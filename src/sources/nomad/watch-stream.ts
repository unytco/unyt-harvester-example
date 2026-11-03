import { NomadClient } from "./client.js";
import {
  allocNodeIdFromEvent,
  nodeStatusSnapshot,
  parseAllocationEvent,
  parseNodeStatusEvent,
  unytAgentIdFromNode,
  unytAgentIdFromNodeEvent,
} from "./parse.js";
import { NomadEventFrame } from "./types.js";
import { NomadStore } from "./store.js";
import { ingestNodeAllocations } from "./allocations.js";

export interface WatcherOptions {
  /** Event topics to subscribe to. Default: Node + Allocation. */
  topics?: string[];
  /**
   * How often to drain dirty nodes (allocation re-pulls), coalescing bursts.
   * Default 2000ms. Allocation churn arrives in floods (one job run = dozens of
   * alloc events across many nodes); pulling per-event would hammer Nomad.
   */
  flushIntervalMs?: number;
  /** First reconnect delay; doubles up to maxBackoffMs. Default 1000ms. */
  reconnectBaseMs?: number;
  /** Max reconnect backoff. Default 30000ms. */
  maxBackoffMs?: number;
  /**
   * Force a reconnect if no frame *or* keep-alive heartbeat arrives within this
   * window. Catches a silently dropped (half-open) connection that never errors
   * — the `for await` would otherwise hang forever. Default 60000ms; must be
   * comfortably above Nomad's keep-alive interval (~20-30s observed).
   */
  idleTimeoutMs?: number;
  /**
   * How often to re-read every node's advertised Unyt agent id. Nomad emits no
   * event when a node's client metadata changes, so a retagged node is only
   * seen by re-reading its detail. Default 300000ms.
   */
  agentRefreshMs?: number;
  /** ms-epoch clock, injectable for tests. */
  now?: () => number;
  /** Progress sink, defaults to console.error. */
  log?: (msg: string) => void;
}

/** Outcome of draining the dirty set once. */
export interface FlushResult {
  pulled: number;
  failed: number;
}

/**
 * Node-topic event types that represent a genuine node-lifecycle change.
 *
 * Observed live: Nomad also emits Node-topic events of Type "AllocationUpdated"
 * (carrying the node object) on every allocation churn — recording those as
 * status transitions floods the table with redundant "ready" rows and would
 * distort uptime. We only treat real lifecycle types as transitions; allocation
 * churn is handled via the Allocation topic (dirty-marking) instead.
 */
const NODE_LIFECYCLE_TYPES = new Set([
  "NodeRegistration",
  "NodeDeregistration",
  "NodeEligibilityUpdate",
  "NodeDrain",
  "NodeStreamEvent",
]);

/**
 * Watch the Nomad event stream and feed the store.
 *
 * Two responsibilities, split for testability:
 *  - `handleFrame` (pure-ish dispatch): records node up/down transitions and
 *    marks nodes dirty for an allocation re-pull; advances the resume index.
 *  - `flush`: drains dirty nodes through the existing pull-based ingest.
 *  - `run`: the long-lived I/O loop wiring the stream + a flush timer +
 *    reconnect/backoff. Kept thin; the logic above is unit-tested directly.
 */
export class StreamWatcher {
  #client: NomadClient;
  #store: NomadStore;
  #topics: string[];
  #flushIntervalMs: number;
  #reconnectBaseMs: number;
  #maxBackoffMs: number;
  #idleTimeoutMs: number;
  #agentRefreshMs: number;
  #now: () => number;
  #log: (msg: string) => void;

  /** Nodes whose allocations changed since the last flush. */
  #dirty = new Set<string>();
  /** Highest stream index seen this session (advanced past on resume). */
  #lastIndex = 0;

  constructor(
    client: NomadClient,
    store: NomadStore,
    opts: WatcherOptions = {},
  ) {
    this.#client = client;
    this.#store = store;
    this.#topics = opts.topics ?? ["Node", "Allocation"];
    this.#flushIntervalMs = opts.flushIntervalMs ?? 2000;
    this.#reconnectBaseMs = opts.reconnectBaseMs ?? 1000;
    this.#maxBackoffMs = opts.maxBackoffMs ?? 30000;
    this.#idleTimeoutMs = opts.idleTimeoutMs ?? 60000;
    this.#agentRefreshMs = opts.agentRefreshMs ?? 300000;
    this.#now = opts.now ?? Date.now;
    this.#log = opts.log ?? ((m) => console.error(m));
  }

  /** Nodes currently awaiting an allocation re-pull (test/inspection aid). */
  get dirtyCount(): number {
    return this.#dirty.size;
  }

  /**
   * Process one event-stream frame: persist node status transitions, persist
   * allocations carried by allocation events (and mark their node dirty for a
   * safety re-pull), and advance the durable resume index.
   */
  async handleFrame(frame: NomadEventFrame): Promise<void> {
    const observedAt = this.#now();
    const statuses = [];
    const allocs = [];
    const agents = new Map<string, string>();
    for (const ev of frame.Events) {
      if (ev.Topic === "Node") {
        if (!NODE_LIFECYCLE_TYPES.has(ev.Type)) {
          continue; // allocation-churn noise on the Node topic — skip
        }
        const s = parseNodeStatusEvent(ev, observedAt);
        if (s) {
          statuses.push(s);
          // Node lifecycle events carry the full node object (with Meta), so
          // capture the advertised Unyt Agent ID for attribution.
          const agentId = unytAgentIdFromNodeEvent(ev);
          if (agentId) {
            agents.set(s.nodeId, agentId);
          }
        }
      } else if (ev.Topic === "Allocation") {
        // Persist the allocation straight from the event payload: it carries the
        // alloc's current ModifyTime/ClientStatus, so a completed alloc's
        // terminal state is captured here before Nomad GCs it out of the
        // point-in-time pull. Still mark the node dirty so the coalesced re-pull
        // remains a recovery/baseline safety net (the modify_index-guarded
        // upsert keeps a later empty pull from clobbering this row).
        const alloc = parseAllocationEvent(ev, observedAt);
        if (alloc) {
          allocs.push(alloc);
          this.#dirty.add(alloc.nodeId);
        } else {
          const nodeId = allocNodeIdFromEvent(ev);
          if (nodeId) {
            this.#dirty.add(nodeId);
          }
        }
      }
    }

    if (statuses.length > 0) {
      await this.#store.recordNodeStatus(statuses);
      for (const s of statuses) {
        this.#log(
          `node ${s.nodeName ?? s.nodeId}: ${s.eventType} ` +
            `status=${s.status} eligibility=${s.eligibility ?? "?"} (mi=${s.modifyIndex})`,
        );
      }
    }
    if (allocs.length > 0) {
      await this.#store.upsertAllocations(allocs);
    }
    for (const [nodeId, agentId] of agents) {
      await this.#store.setNodeAgent(nodeId, agentId, observedAt);
    }
    await this.#advanceIndex(frame.Index);
  }

  /** Pull allocations for every dirty node, then clear the set. */
  async flush(): Promise<FlushResult> {
    // Snapshot and clear up front so events arriving during the pulls just
    // re-dirty the node for the next flush (no lost updates, no races).
    const nodes = [...this.#dirty];
    this.#dirty.clear();

    const result: FlushResult = { pulled: 0, failed: 0 };
    for (const nodeId of nodes) {
      try {
        await ingestNodeAllocations(
          this.#client,
          this.#store,
          nodeId,
          this.#now,
        );
        result.pulled++;
      } catch (err) {
        result.failed++;
        this.#log(`flush: node ${nodeId} pull failed — ${message(err)}`);
        // Re-dirty so a transient failure is retried on the next flush.
        this.#dirty.add(nodeId);
      }
    }
    if (result.pulled > 0 || result.failed > 0) {
      this.#log(
        `flush: pulled ${result.pulled} node(s)` +
          (result.failed ? `, ${result.failed} failed` : ""),
      );
    }
    return result;
  }

  /**
   * Reconcile against authoritative current state: snapshot every node's status
   * and mark every node for an allocation re-pull. Run on startup and after each
   * reconnect — the event stream can miss events (Nomad's buffer is bounded), so
   * a full read is how current state self-heals across a gap. Snapshots dedupe
   * against any stream events for the same change via (nodeId, modifyIndex).
   */
  async reconcile(): Promise<number> {
    const stubs = await this.#client.listNodes();
    const observedAt = this.#now();
    const snapshots = [];
    let agentsCaptured = 0;
    for (const stub of stubs) {
      if (!stub.ID) {
        continue;
      }
      const snap = nodeStatusSnapshot(stub, observedAt);
      if (snap) {
        snapshots.push(snap);
      }
      this.#dirty.add(stub.ID);
      // Best-effort per node: one failed detail fetch must not abort the
      // resync (status snapshot + re-pull marking already happened).
      try {
        const agentId = await this.#readAgentId(stub.ID);
        if (agentId) {
          await this.#store.setNodeAgent(stub.ID, agentId, observedAt);
          agentsCaptured++;
        }
      } catch (err) {
        this.#log(
          `reconcile: node ${stub.ID} detail fetch failed — ${message(err)}`,
        );
      }
    }
    if (snapshots.length > 0) {
      await this.#store.recordNodeStatus(snapshots);
    }
    this.#log(
      `reconcile: ${stubs.length} node(s) snapshotted + marked for re-pull, ` +
        `${agentsCaptured} Unyt agent id(s) captured`,
    );
    return stubs.length;
  }

  /**
   * Re-read every node's advertised Unyt agent id and record the ones that
   * changed. Returns how many changed. A failed detail fetch skips that node
   * until the next refresh.
   */
  async refreshAgents(): Promise<number> {
    const stubs = await this.#client.listNodes();
    const observedAt = this.#now();
    let changed = 0;
    for (const stub of stubs) {
      if (!stub.ID) {
        continue;
      }
      try {
        const agentId = await this.#readAgentId(stub.ID);
        const previous = await this.#store.getNodeAgent(stub.ID);
        if (agentId && agentId !== previous) {
          await this.#store.setNodeAgent(stub.ID, agentId, observedAt);
          changed++;
          this.#log(
            previous
              ? `node ${stub.ID}: agent key changed ${previous} → ${agentId}`
              : `node ${stub.ID}: agent key recorded ${agentId}`,
          );
        }
      } catch (err) {
        this.#log(
          `agent refresh: node ${stub.ID} detail fetch failed — ${message(err)}`,
        );
      }
    }
    return changed;
  }

  /** The node list stub omits Meta, so read the advertised id from its detail. */
  async #readAgentId(nodeId: string): Promise<string | null> {
    return unytAgentIdFromNode(
      (await this.#client.getNode(nodeId)) as unknown as Record<
        string,
        unknown
      >,
    );
  }

  /**
   * Long-lived loop: consume the stream from the persisted resume index,
   * flushing dirty nodes on an interval, reconnecting with backoff on error.
   * Returns when `signal` is aborted.
   *
   * Resilience: a per-attempt idle watchdog forces a reconnect if no frame or
   * keep-alive arrives within `idleTimeoutMs` (catches silent half-open drops
   * that never throw); every (re)connect runs `reconcile()` so missed events
   * can't leave stale state; each disconnect window is persisted.
   */
  async run(signal: AbortSignal): Promise<void> {
    const flushTimer = setInterval(() => {
      if (this.#dirty.size > 0) {
        void this.flush().catch((e) => this.#log(`flush error: ${message(e)}`));
      }
    }, this.#flushIntervalMs);
    let refreshing = false;
    const agentTimer = setInterval(() => {
      if (refreshing) {
        return;
      }
      refreshing = true;
      void this.refreshAgents()
        .catch((e) => this.#log(`agent refresh error: ${message(e)}`))
        .finally(() => {
          refreshing = false;
        });
    }, this.#agentRefreshMs);
    const watchdogTick = Math.max(1000, Math.floor(this.#idleTimeoutMs / 4));

    let backoff = this.#reconnectBaseMs;
    // null until the first drop; set to the drop time so the next iteration can
    // record the disconnect window before reconnecting.
    let droppedAt: number | null = null;
    let reason = "eof";

    try {
      while (!signal.aborted) {
        const index = await this.#store.getStreamIndex();
        this.#lastIndex = index;

        if (droppedAt !== null) {
          const endedAt = this.#now();
          await this.#store
            .recordDisconnect({
              startedAt: droppedAt,
              endedAt,
              durationMs: endedAt - droppedAt,
              reason,
              resumeIndex: index,
            })
            .catch((e) => this.#log(`recordDisconnect failed: ${message(e)}`));
          this.#log(
            `reconnected after ${endedAt - droppedAt}ms (${reason}); reconciling`,
          );
        }
        // Authoritative resync on every (re)connect — covers events missed
        // while disconnected. Best-effort: a failure shouldn't stop watching.
        await this.reconcile().catch((e) =>
          this.#log(`reconcile failed: ${message(e)}`),
        );

        // Per-attempt abort so the watchdog can drop just this connection; also
        // aborted when the outer shutdown signal fires.
        const attempt = new AbortController();
        const attemptSignal = AbortSignal.any([signal, attempt.signal]);
        let lastActivity = this.#now();
        const watchdog = setInterval(() => {
          if (this.#now() - lastActivity > this.#idleTimeoutMs) {
            this.#log(
              `no stream activity for ${this.#idleTimeoutMs}ms — forcing reconnect`,
            );
            attempt.abort();
          }
        }, watchdogTick);

        try {
          this.#log(
            `watching [${this.#topics.join(", ")}] from index ${index}`,
          );
          for await (const frame of this.#client.streamEvents({
            topics: this.#topics,
            index,
            signal: attemptSignal,
            onHeartbeat: (i) => {
              lastActivity = this.#now();
              if (i != null) {
                void this.#advanceIndex(i).catch((e) =>
                  this.#log(`setStreamIndex failed: ${message(e)}`),
                );
              }
            },
            onError: (line, err) =>
              this.#log(
                `skipping malformed stream frame: ${message(err)} — ${line.slice(0, 120)}`,
              ),
          })) {
            lastActivity = this.#now();
            await this.handleFrame(frame);
            backoff = this.#reconnectBaseMs; // healthy activity resets backoff
          }
          reason = "eof"; // stream closed cleanly by the server
        } catch (err) {
          if (signal.aborted) {
            break;
          }
          reason = attempt.signal.aborted ? "idle-timeout" : message(err);
        } finally {
          clearInterval(watchdog);
        }

        if (signal.aborted) {
          break;
        }
        droppedAt = this.#now();
        const wait = backoff + Math.floor(backoff * 0.2 * Math.random());
        this.#log(`stream ended (${reason}) — reconnecting in ${wait}ms`);
        await sleep(wait, signal);
        backoff = Math.min(backoff * 2, this.#maxBackoffMs);
      }
    } finally {
      clearInterval(flushTimer);
      clearInterval(agentTimer);
      await this.flush().catch((e) =>
        this.#log(`final flush error: ${message(e)}`),
      );
    }
  }

  /** Advance and persist the resume index, monotonically. */
  async #advanceIndex(index: number): Promise<void> {
    if (index > this.#lastIndex) {
      this.#lastIndex = index;
      await this.#store.setStreamIndex(index);
    }
  }
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Sleep that resolves early (no throw) when the signal aborts. */
function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      return resolve();
    }
    const t = setTimeout(done, ms);
    const onAbort = () => done();
    function done() {
      clearTimeout(t);
      signal.removeEventListener("abort", onAbort);
      resolve();
    }
    signal.addEventListener("abort", onAbort, { once: true });
  });
}
