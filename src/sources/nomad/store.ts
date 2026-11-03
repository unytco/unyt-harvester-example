import { DatabaseSync } from "node:sqlite";

/**
 * The Nomad source's own tables: allocations, node status transitions, the
 * Unyt agent key each node advertises, and the event-stream cursor. They live
 * in the harvester's SQLite file next to the core outbox.
 */

/**
 * A normalized Nomad allocation as we persist it.
 *
 * We keep the few fields we derive "active usage" from as columns, plus the full
 * `raw` payload so aggregation can be recomputed if the derivation logic changes
 * without re-pulling from Nomad.
 */
export interface StoredAllocation {
  /** Allocation ID — unique per allocation, the primary key. */
  allocId: string;
  /** Node this allocation is assigned to (what we pull/query by). */
  nodeId: string;
  /** Node name at observation time, if Nomad reported one. */
  nodeName: string | null;
  jobId: string;
  taskGroup: string;
  /** e.g. running | complete | failed | pending | lost. */
  clientStatus: string;
  /** e.g. run | stop | evict. */
  desiredStatus: string;
  /**
   * Millisecond epochs, converted from Nomad's nanosecond UnixNano (which
   * overflows JS safe-integer range). See `parseAllocation`.
   */
  createTime: number;
  modifyTime: number;
  /** Raft index; monotonic, used as the change cursor. */
  modifyIndex: number;
  /**
   * Millisecond epoch when this allocation's state was last inserted or updated
   * — i.e. last *changed*, not last *seen*. A re-pull of an unchanged allocation
   * (same `modifyIndex`) intentionally leaves this untouched (see `upsertAllocations`).
   * Per-node liveness lives in `NodeSync.lastSyncedAt`; a per-alloc last-seen can
   * be added when GC reconciliation needs to answer "is this alloc still present?".
   */
  observedAt: number;
  /** Full raw allocation JSON, for recompute-friendly storage. */
  raw: string;
}

/** Result of an upsert batch — how the current state changed. */
export interface UpsertResult {
  inserted: number;
  updated: number;
  /** Rows whose ModifyIndex was not newer than what we already had. */
  unchanged: number;
}

/** Per-node bookkeeping so a re-pull is observable and resumable. */
export interface NodeSync {
  nodeId: string;
  /** Highest allocation ModifyIndex seen for this node. */
  lastModifyIndex: number;
  /** Millisecond epoch of the last successful pull. */
  lastSyncedAt: number;
}

/** Nomad node status values we observe. */
export type NodeStatus = "ready" | "down" | "initializing" | "disconnected";

/**
 * A node up/down (and eligibility) transition derived from a Nomad `Node`
 * event — the raw material for availability/uptime aggregation. Append-only:
 * we keep every observed transition rather than just current status, so uptime
 * over a window can be computed (and recomputed) from the sequence.
 */
export interface NodeStatusEvent {
  nodeId: string;
  nodeName: string | null;
  /** Nomad node status. */
  status: NodeStatus;
  /** Scheduling eligibility: eligible | ineligible (null if absent). */
  eligibility: string | null;
  /** Nomad event type, e.g. NodeRegistration | NodeDeregistration | NodeDrain. */
  eventType: string;
  /** The node's ModifyIndex at this transition — the dedupe key with nodeId. */
  modifyIndex: number;
  /** Millisecond epoch when we observed the event. */
  observedAt: number;
  /** Full raw Nomad event JSON, for recompute. */
  raw: string;
}

/** Result of an append-only record batch — how many rows were new. */
export interface RecordResult {
  inserted: number;
  /** Rows already present (same nodeId + modifyIndex) — re-delivered events. */
  ignored: number;
}

/**
 * A window during which the event stream was disconnected. Recorded for
 * accountability: events in this window may have been missed (beyond Nomad's
 * buffer), so uptime derived across it relies on the reconnect reconcile
 * snapshot rather than observed transitions.
 */
export interface DisconnectEvent {
  /** ms epoch the stream dropped. */
  startedAt: number;
  /** ms epoch we reconnected. */
  endedAt: number;
  durationMs: number;
  /** Why it dropped: an error message, "eof", or "idle-timeout". */
  reason: string;
  /** The resume index we reconnected from. */
  resumeIndex: number;
}

export interface NomadStore {
  /**
   * Upsert a node's current allocation set. Idempotent: an allocation whose
   * `modifyIndex` is not newer than the stored one is left untouched and counted
   * as `unchanged`, so re-running a pull is safe.
   */
  upsertAllocations(allocs: StoredAllocation[]): Promise<UpsertResult>;

  /** Current stored allocations for a node, newest `modifyIndex` first. */
  allocationsForNode(nodeId: string): Promise<StoredAllocation[]>;

  /** Every node id we've seen (union of allocations + status events). */
  allNodeIds(): Promise<string[]>;

  /** Read per-node sync bookkeeping, if we've pulled it before. */
  getNodeSync(nodeId: string): Promise<NodeSync | undefined>;

  /** Record per-node sync bookkeeping after a successful pull. */
  setNodeSync(sync: NodeSync): Promise<void>;

  /**
   * Append node status transitions. Idempotent: a transition already stored
   * (same `nodeId` + `modifyIndex`) is ignored, so a stream resume that
   * re-delivers events doesn't double-count uptime.
   */
  recordNodeStatus(events: NodeStatusEvent[]): Promise<RecordResult>;

  /** A node's status transitions, oldest `modifyIndex` first. */
  nodeStatusHistory(nodeId: string): Promise<NodeStatusEvent[]>;

  /**
   * Record the Unyt Agent ID a node advertises (Nomad `Meta.unyt_agent_id`).
   * Last-writer-wins per node. Stored verbatim (may be malformed) — validation
   * happens at attribution time, so a bad value is observable rather than
   * silently dropped at ingest. Only call with a non-empty value; a node that
   * reports none simply has no row.
   */
  setNodeAgent(
    nodeId: string,
    agentId: string,
    observedAt: number,
  ): Promise<void>;

  /** The last-recorded Unyt Agent ID for a node, or `null` if none seen. */
  getNodeAgent(nodeId: string): Promise<string | null>;

  /**
   * Last Nomad event-stream index we've durably processed (0 if never). The
   * watcher resumes the stream from here across restarts.
   */
  getStreamIndex(): Promise<number>;

  /** Persist the event-stream resume point. */
  setStreamIndex(index: number): Promise<void>;

  /** Record a stream disconnect window (append-only, for accountability). */
  recordDisconnect(d: DisconnectEvent): Promise<void>;

  /** All recorded disconnect windows, oldest first. */
  listDisconnects(): Promise<DisconnectEvent[]>;

  close(): Promise<void>;
}

export class SqliteNomadStore implements NomadStore {
  #db: DatabaseSync;

  constructor(path = ":memory:") {
    this.#db = new DatabaseSync(path);
    this.#db.exec("PRAGMA journal_mode = WAL;");
    // The long-lived `watch` writer and scheduled `process` runs share the file.
    this.#db.exec("PRAGMA busy_timeout = 5000;");
    this.#db.exec(`
      CREATE TABLE IF NOT EXISTS allocations (
        alloc_id      TEXT PRIMARY KEY,
        node_id       TEXT NOT NULL,
        node_name     TEXT,
        job_id        TEXT NOT NULL,
        task_group    TEXT NOT NULL,
        client_status TEXT NOT NULL,
        desired_status TEXT NOT NULL,
        create_time   INTEGER NOT NULL,
        modify_time   INTEGER NOT NULL,
        modify_index  INTEGER NOT NULL,
        observed_at   INTEGER NOT NULL,
        raw           TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_allocations_node
        ON allocations (node_id, modify_index DESC);

      CREATE TABLE IF NOT EXISTS node_sync (
        node_id          TEXT PRIMARY KEY,
        last_modify_index INTEGER NOT NULL,
        last_synced_at    INTEGER NOT NULL
      );

      -- Append-only node up/down transitions; (node_id, modify_index) dedupes
      -- re-delivered stream events.
      CREATE TABLE IF NOT EXISTS node_status_events (
        node_id      TEXT NOT NULL,
        node_name    TEXT,
        status       TEXT NOT NULL,
        eligibility  TEXT,
        event_type   TEXT NOT NULL,
        modify_index INTEGER NOT NULL,
        observed_at  INTEGER NOT NULL,
        raw          TEXT NOT NULL,
        PRIMARY KEY (node_id, modify_index)
      );

      -- Unyt Agent ID advertised by a node (Nomad Meta.unyt_agent_id).
      -- Last-writer-wins per node; the raw value is kept (validation is at
      -- attribution time) so a malformed id is observable, not silently dropped.
      CREATE TABLE IF NOT EXISTS node_agent (
        node_id             TEXT PRIMARY KEY,
        agent_id            TEXT NOT NULL,
        observed_at         INTEGER NOT NULL
      );

      -- Append-only record of stream disconnect windows (accountability for
      -- possibly-missed events; see DisconnectEvent).
      CREATE TABLE IF NOT EXISTS disconnects (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        started_at   INTEGER NOT NULL,
        ended_at     INTEGER NOT NULL,
        duration_ms  INTEGER NOT NULL,
        reason       TEXT NOT NULL,
        resume_index INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS nomad_meta (
        key   TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `);
  }

  async upsertAllocations(allocs: StoredAllocation[]): Promise<UpsertResult> {
    const existing = this.#db.prepare(
      "SELECT modify_index FROM allocations WHERE alloc_id = ?",
    );
    // Insert, or update only when the incoming row is strictly newer. The
    // WHERE on the conflict clause makes a stale re-pull a no-op (idempotent).
    // Consequence: observed_at tracks last *change*, not last *poll* — an
    // unchanged re-pull leaves the whole row, observed_at included (see
    // StoredAllocation.observedAt).
    const upsert = this.#db.prepare(`
      INSERT INTO allocations (
        alloc_id, node_id, node_name, job_id, task_group,
        client_status, desired_status, create_time, modify_time,
        modify_index, observed_at, raw
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(alloc_id) DO UPDATE SET
        node_id        = excluded.node_id,
        node_name      = excluded.node_name,
        job_id         = excluded.job_id,
        task_group     = excluded.task_group,
        client_status  = excluded.client_status,
        desired_status = excluded.desired_status,
        create_time    = excluded.create_time,
        modify_time    = excluded.modify_time,
        modify_index   = excluded.modify_index,
        observed_at    = excluded.observed_at,
        raw            = excluded.raw
      WHERE excluded.modify_index > allocations.modify_index
    `);

    const result: UpsertResult = { inserted: 0, updated: 0, unchanged: 0 };
    const run = this.#db.prepare("BEGIN");
    run.run();
    try {
      for (const a of allocs) {
        const prior = existing.get(a.allocId) as
          { modify_index: number } | undefined;
        upsert.run(
          a.allocId,
          a.nodeId,
          a.nodeName,
          a.jobId,
          a.taskGroup,
          a.clientStatus,
          a.desiredStatus,
          a.createTime,
          a.modifyTime,
          a.modifyIndex,
          a.observedAt,
          a.raw,
        );
        if (prior === undefined) {
          result.inserted++;
        } else if (a.modifyIndex > prior.modify_index) {
          result.updated++;
        } else {
          result.unchanged++;
        }
      }
      this.#db.prepare("COMMIT").run();
    } catch (err) {
      this.#db.prepare("ROLLBACK").run();
      throw err;
    }
    return result;
  }

  async allocationsForNode(nodeId: string): Promise<StoredAllocation[]> {
    const rows = this.#db
      .prepare(
        `SELECT * FROM allocations WHERE node_id = ? ORDER BY modify_index DESC`,
      )
      .all(nodeId) as Record<string, unknown>[];
    return rows.map(rowToAllocation);
  }

  async allNodeIds(): Promise<string[]> {
    const rows = this.#db
      .prepare(
        `SELECT node_id FROM allocations
         UNION
         SELECT node_id FROM node_status_events
         ORDER BY node_id`,
      )
      .all() as { node_id: string }[];
    return rows.map((r) => r.node_id);
  }

  async getNodeSync(nodeId: string): Promise<NodeSync | undefined> {
    const row = this.#db
      .prepare(`SELECT * FROM node_sync WHERE node_id = ?`)
      .get(nodeId) as Record<string, unknown> | undefined;
    if (!row) {
      return undefined;
    }
    return {
      nodeId: row.node_id as string,
      lastModifyIndex: row.last_modify_index as number,
      lastSyncedAt: row.last_synced_at as number,
    };
  }

  async setNodeSync(sync: NodeSync): Promise<void> {
    this.#db
      .prepare(
        `INSERT INTO node_sync (node_id, last_modify_index, last_synced_at)
         VALUES (?, ?, ?)
         ON CONFLICT(node_id) DO UPDATE SET
           last_modify_index = excluded.last_modify_index,
           last_synced_at    = excluded.last_synced_at`,
      )
      .run(sync.nodeId, sync.lastModifyIndex, sync.lastSyncedAt);
  }

  async recordNodeStatus(events: NodeStatusEvent[]): Promise<RecordResult> {
    // INSERT OR IGNORE so a re-delivered transition (same node_id+modify_index)
    // is a no-op; `changes` tells us whether the row was actually inserted.
    const insert = this.#db.prepare(`
      INSERT OR IGNORE INTO node_status_events (
        node_id, node_name, status, eligibility, event_type,
        modify_index, observed_at, raw
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const result: RecordResult = { inserted: 0, ignored: 0 };
    this.#db.prepare("BEGIN").run();
    try {
      for (const e of events) {
        const info = insert.run(
          e.nodeId,
          e.nodeName,
          e.status,
          e.eligibility,
          e.eventType,
          e.modifyIndex,
          e.observedAt,
          e.raw,
        );
        if (Number(info.changes) > 0) {
          result.inserted++;
        } else {
          result.ignored++;
        }
      }
      this.#db.prepare("COMMIT").run();
    } catch (err) {
      this.#db.prepare("ROLLBACK").run();
      throw err;
    }
    return result;
  }

  async nodeStatusHistory(nodeId: string): Promise<NodeStatusEvent[]> {
    const rows = this.#db
      .prepare(
        `SELECT * FROM node_status_events WHERE node_id = ? ORDER BY modify_index ASC`,
      )
      .all(nodeId) as Record<string, unknown>[];
    return rows.map(rowToNodeStatusEvent);
  }

  async setNodeAgent(
    nodeId: string,
    agentId: string,
    observedAt: number,
  ): Promise<void> {
    this.#db
      .prepare(
        `INSERT INTO node_agent (node_id, agent_id, observed_at)
         VALUES (?, ?, ?)
         ON CONFLICT(node_id) DO UPDATE SET
           agent_id    = excluded.agent_id,
           observed_at = excluded.observed_at`,
      )
      .run(nodeId, agentId, observedAt);
  }

  async getNodeAgent(nodeId: string): Promise<string | null> {
    const row = this.#db
      .prepare(`SELECT agent_id FROM node_agent WHERE node_id = ?`)
      .get(nodeId) as { agent_id: string } | undefined;
    return row ? row.agent_id : null;
  }

  async getStreamIndex(): Promise<number> {
    const row = this.#db
      .prepare(`SELECT value FROM nomad_meta WHERE key = 'stream_index'`)
      .get() as { value: string } | undefined;
    return row ? Number(row.value) : 0;
  }

  async setStreamIndex(index: number): Promise<void> {
    this.#db
      .prepare(
        `INSERT INTO nomad_meta (key, value) VALUES ('stream_index', ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      )
      .run(String(index));
  }

  async recordDisconnect(d: DisconnectEvent): Promise<void> {
    this.#db
      .prepare(
        `INSERT INTO disconnects (started_at, ended_at, duration_ms, reason, resume_index)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(d.startedAt, d.endedAt, d.durationMs, d.reason, d.resumeIndex);
  }

  async listDisconnects(): Promise<DisconnectEvent[]> {
    const rows = this.#db
      .prepare(`SELECT * FROM disconnects ORDER BY started_at ASC`)
      .all() as Record<string, unknown>[];
    return rows.map((r) => ({
      startedAt: r.started_at as number,
      endedAt: r.ended_at as number,
      durationMs: r.duration_ms as number,
      reason: r.reason as string,
      resumeIndex: r.resume_index as number,
    }));
  }

  async close(): Promise<void> {
    this.#db.close();
  }
}

function rowToNodeStatusEvent(row: Record<string, unknown>): NodeStatusEvent {
  return {
    nodeId: row.node_id as string,
    nodeName: (row.node_name as string | null) ?? null,
    status: row.status as NodeStatus,
    eligibility: (row.eligibility as string | null) ?? null,
    eventType: row.event_type as string,
    modifyIndex: row.modify_index as number,
    observedAt: row.observed_at as number,
    raw: row.raw as string,
  };
}

function rowToAllocation(row: Record<string, unknown>): StoredAllocation {
  return {
    allocId: row.alloc_id as string,
    nodeId: row.node_id as string,
    nodeName: (row.node_name as string | null) ?? null,
    jobId: row.job_id as string,
    taskGroup: row.task_group as string,
    clientStatus: row.client_status as string,
    desiredStatus: row.desired_status as string,
    createTime: row.create_time as number,
    modifyTime: row.modify_time as number,
    modifyIndex: row.modify_index as number,
    observedAt: row.observed_at as number,
    raw: row.raw as string,
  };
}
