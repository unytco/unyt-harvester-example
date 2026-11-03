import { test } from "node:test";
import assert from "node:assert/strict";
import { StreamWatcher } from "../../../src/sources/nomad/watch-stream.js";
import { SqliteNomadStore } from "../../../src/sources/nomad/store.js";
import { NomadClient } from "../../../src/sources/nomad/client.js";
import {
  NomadAllocStub,
  NomadEvent,
  NomadEventFrame,
  NomadNodeStub,
} from "../../../src/sources/nomad/types.js";

/** NomadClient stand-in: allocations per node, or a thrower for failure tests.
 * `agentIds` maps a node id to the `Meta.unyt_agent_id` its detail advertises
 * (the list stub deliberately omits Meta, matching real Nomad). */
function fakeClient(
  allocsByNode: Record<string, Partial<NomadAllocStub>[]>,
  failNodes: Set<string> = new Set(),
  nodes: Partial<NomadNodeStub>[] = [],
  agentIds: Record<string, string> = {},
): NomadClient {
  return {
    listNodes: async () => nodes as NomadNodeStub[],
    getNode: async (id: string) => ({
      ID: id,
      Meta: agentIds[id] ? { unyt_agent_id: agentIds[id] } : {},
    }),
    listNodeAllocations: async (id: string) => {
      if (failNodes.has(id)) {
        throw new Error(`boom ${id}`);
      }
      return (allocsByNode[id] ?? []) as NomadAllocStub[];
    },
  } as unknown as NomadClient;
}

const frame = (index: number, events: NomadEvent[]): NomadEventFrame => ({
  Index: index,
  Events: events,
});

const nodeEvent = (
  id: string,
  status: string,
  modifyIndex: number,
  type = "NodeStreamEvent",
  agentId?: string,
): NomadEvent => ({
  Topic: "Node",
  Type: type,
  Key: id,
  Index: modifyIndex,
  Payload: {
    Node: {
      ID: id,
      Name: id,
      Status: status,
      ModifyIndex: modifyIndex,
      ...(agentId ? { Meta: { unyt_agent_id: agentId } } : {}),
    },
  },
});

const allocEvent = (nodeId: string, modifyIndex: number): NomadEvent => ({
  Topic: "Allocation",
  Type: "AllocationUpdated",
  Key: `a-${modifyIndex}`,
  Index: modifyIndex,
  Payload: {
    Allocation: {
      ID: `a-${modifyIndex}`,
      NodeID: nodeId,
      ModifyIndex: modifyIndex,
    },
  },
});

test("handleFrame records node status, marks alloc nodes dirty, advances index", async () => {
  const store = new SqliteNomadStore(":memory:");
  const watcher = new StreamWatcher(fakeClient({}), store, {
    now: () => 5000,
  });

  await watcher.handleFrame(
    frame(610, [
      nodeEvent("n1", "down", 600),
      allocEvent("n2", 605),
      allocEvent("n3", 608),
    ]),
  );

  assert.equal(watcher.dirtyCount, 2); // n2, n3
  const hist = await store.nodeStatusHistory("n1");
  assert.equal(hist.length, 1);
  assert.equal(hist[0].status, "down");
  assert.equal(hist[0].observedAt, 5000);
  assert.equal(await store.getStreamIndex(), 610);
  await store.close();
});

test("handleFrame ignores Node-topic allocation-churn events", async () => {
  // Nomad emits Topic=Node / Type=AllocationUpdated (with a Node payload) on
  // every allocation change — these must NOT become status transitions.
  const store = new SqliteNomadStore(":memory:");
  const watcher = new StreamWatcher(fakeClient({}), store);
  await watcher.handleFrame(
    frame(700, [
      nodeEvent("n1", "ready", 690, "AllocationUpdated"),
      nodeEvent("n1", "down", 695, "NodeStreamEvent"),
    ]),
  );
  const h = await store.nodeStatusHistory("n1");
  assert.deepEqual(
    h.map((e) => [e.modifyIndex, e.eventType]),
    [[695, "NodeStreamEvent"]],
  );
  await store.close();
});

test("handleFrame coalesces repeated alloc events for one node", async () => {
  const store = new SqliteNomadStore(":memory:");
  const watcher = new StreamWatcher(fakeClient({}), store);
  await watcher.handleFrame(
    frame(20, [
      allocEvent("n1", 11),
      allocEvent("n1", 12),
      allocEvent("n1", 13),
    ]),
  );
  assert.equal(watcher.dirtyCount, 1);
  await store.close();
});

test("an allocation event persists terminal state a later empty pull can't clobber", async () => {
  const store = new SqliteNomadStore(":memory:");
  // The pull returns nothing for n1 — Nomad GC'd the completed allocation
  // before the coalesced re-pull ran. The event payload is the only source.
  const watcher = new StreamWatcher(fakeClient({}), store, { now: () => 9 });

  const completed: NomadEvent = {
    Topic: "Allocation",
    Type: "AllocationUpdated",
    Key: "a1",
    Index: 30,
    Payload: {
      Allocation: {
        ID: "a1",
        NodeID: "n1",
        JobID: "job",
        TaskGroup: "tg",
        ClientStatus: "complete",
        DesiredStatus: "stop",
        CreateTime: 1_000_000_000, // ns -> 1000ms
        ModifyTime: 5_000_000_000, // ns -> 5000ms
        ModifyIndex: 30,
      },
    },
  };

  await watcher.handleFrame(frame(30, [completed]));
  // Stored straight from the event, before any pull — duration is derivable
  // (modifyTime - createTime = 4000ms).
  let allocs = await store.allocationsForNode("n1");
  assert.equal(allocs.length, 1);
  assert.equal(allocs[0].clientStatus, "complete");
  assert.equal(allocs[0].createTime, 1000);
  assert.equal(allocs[0].modifyTime, 5000);

  // The safety re-pull returns empty (GC'd); the terminal row must survive.
  await watcher.flush();
  allocs = await store.allocationsForNode("n1");
  assert.equal(allocs.length, 1);
  assert.equal(allocs[0].modifyTime, 5000);
  await store.close();
});

test("the resume index never goes backwards", async () => {
  const store = new SqliteNomadStore(":memory:");
  const watcher = new StreamWatcher(fakeClient({}), store);
  await watcher.handleFrame(frame(600, []));
  await watcher.handleFrame(frame(500, [])); // stale/out-of-order
  assert.equal(await store.getStreamIndex(), 600);
  await store.close();
});

test("flush pulls dirty nodes into the store and clears the set", async () => {
  const store = new SqliteNomadStore(":memory:");
  const client = fakeClient({
    n2: [{ ID: "x", NodeID: "n2", ModifyIndex: 5 }],
  });
  const watcher = new StreamWatcher(client, store, { now: () => 1 });

  await watcher.handleFrame(frame(10, [allocEvent("n2", 9)]));
  const res = await watcher.flush();

  assert.deepEqual(res, { pulled: 1, failed: 0 });
  assert.equal(watcher.dirtyCount, 0);
  const stored = await store.allocationsForNode("n2");
  assert.ok(
    stored.some((a) => a.allocId === "x"),
    "the pulled allocation is stored",
  );
  await store.close();
});

test("flush re-dirties a node whose pull fails so it retries", async () => {
  const store = new SqliteNomadStore(":memory:");
  const client = fakeClient({}, new Set(["n9"]));
  const watcher = new StreamWatcher(client, store, { log: () => {} });

  await watcher.handleFrame(frame(10, [allocEvent("n9", 9)]));
  const res = await watcher.flush();

  assert.deepEqual(res, { pulled: 0, failed: 1 });
  assert.equal(watcher.dirtyCount, 1); // re-dirtied for the next flush
  await store.close();
});

test("reconcile snapshots all nodes and marks them dirty for re-pull", async () => {
  const store = new SqliteNomadStore(":memory:");
  const client = fakeClient({}, new Set(), [
    { ID: "n1", Name: "n1", Status: "ready", ModifyIndex: 50 },
    { ID: "n2", Name: "n2", Status: "down", ModifyIndex: 60 },
  ]);
  const watcher = new StreamWatcher(client, store, { now: () => 9 });

  const count = await watcher.reconcile();
  assert.equal(count, 2);
  assert.equal(watcher.dirtyCount, 2);

  const h1 = await store.nodeStatusHistory("n1");
  assert.equal(h1[0].eventType, "Reconcile");
  assert.equal(h1[0].status, "ready");
  assert.equal((await store.nodeStatusHistory("n2"))[0].status, "down");
  await store.close();
});

test("reconcile captures the Unyt agent id from node detail (stubs omit Meta)", async () => {
  const store = new SqliteNomadStore(":memory:");
  const AGENT = "uhCAkEgwsRQmYpVUGWSdNyziQgQZu1sfXVlVIR0sbEZJBd5N6wYr_";
  const client = fakeClient(
    {},
    new Set(),
    [
      { ID: "n1", Name: "n1", Status: "ready", ModifyIndex: 50 },
      { ID: "n2", Name: "n2", Status: "ready", ModifyIndex: 60 },
    ],
    { n1: AGENT }, // only n1 advertises an agent id
  );
  const watcher = new StreamWatcher(client, store, { now: () => 9 });

  await watcher.reconcile();
  assert.equal(await store.getNodeAgent("n1"), AGENT);
  assert.equal(await store.getNodeAgent("n2"), null); // none advertised
  await store.close();
});

test("handleFrame captures the Unyt agent id carried by a Node lifecycle event", async () => {
  const store = new SqliteNomadStore(":memory:");
  const AGENT = "uhCAkEgwsRQmYpVUGWSdNyziQgQZu1sfXVlVIR0sbEZJBd5N6wYr_";
  const watcher = new StreamWatcher(fakeClient({}), store, { now: () => 7 });

  await watcher.handleFrame(
    frame(800, [nodeEvent("n1", "ready", 790, "NodeStreamEvent", AGENT)]),
  );
  assert.equal(await store.getNodeAgent("n1"), AGENT);
  await store.close();
});

test("run reconnects after a dropped stream, resumes, and records the gap", async () => {
  const store = new SqliteNomadStore(":memory:");
  let calls = 0;
  const client = {
    listNodes: async () => [] as NomadNodeStub[],
    listNodeAllocations: async () => [] as NomadAllocStub[],
    streamEvents: async function* (opts: { signal: AbortSignal }) {
      calls++;
      if (calls === 1) {
        yield frame(10, [nodeEvent("n1", "down", 9)]);
        throw new Error("connection reset"); // simulate a drop
      }
      // Second connection: deliver another frame, then idle until shutdown.
      yield frame(20, [nodeEvent("n1", "ready", 19)]);
      await new Promise<void>((r) => {
        if (opts.signal.aborted) return r();
        opts.signal.addEventListener("abort", () => r(), { once: true });
      });
    },
  } as unknown as NomadClient;

  const watcher = new StreamWatcher(client, store, {
    reconnectBaseMs: 5,
    now: () => 1000,
  });
  const ctrl = new AbortController();
  const running = watcher.run(ctrl.signal);

  // Wait until both attempts' frames are processed (index reaches 20), then stop.
  const deadline = Date.now() + 3000;
  while ((await store.getStreamIndex()) < 20 && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 5));
  }
  ctrl.abort();
  await running;

  assert.ok(calls >= 2, "should have reconnected at least once");
  assert.equal(await store.getStreamIndex(), 20);
  // Both attempts' transitions are stored (resumed across the drop).
  assert.deepEqual(
    (await store.nodeStatusHistory("n1")).map((e) => e.status),
    ["down", "ready"],
  );
  // The disconnect window was recorded for accountability.
  const ds = await store.listDisconnects();
  assert.equal(ds.length, 1);
  assert.equal(ds[0].reason, "connection reset");
  await store.close();
});

test("refreshAgents records a key Nomad changed without an event", async () => {
  const store = new SqliteNomadStore(":memory:");
  const OLD = "uhCAkEgwsRQmYpVUGWSdNyziQgQZu1sfXVlVIR0sbEZJBd5N6wYr_";
  const NEW = "uhCAkEgwsRQmYpVUGWSdNyziQgQZu1sfXVlVIR0sbEZJBd5N6wYr2";
  await store.setNodeAgent("n1", OLD, 1);
  await store.setNodeAgent("n2", OLD, 1);
  const client = fakeClient(
    {},
    new Set(),
    [
      { ID: "n1", Name: "n1", Status: "ready", ModifyIndex: 50 },
      { ID: "n2", Name: "n2", Status: "ready", ModifyIndex: 60 },
    ],
    { n1: NEW, n2: OLD }, // n1 was retagged through client metadata
  );
  const lines: string[] = [];
  const watcher = new StreamWatcher(client, store, {
    now: () => 9,
    log: (m) => lines.push(m),
  });

  assert.equal(await watcher.refreshAgents(), 1);
  assert.equal(await store.getNodeAgent("n1"), NEW);
  assert.equal(await store.getNodeAgent("n2"), OLD);
  assert.deepEqual(lines, [`node n1: agent key changed ${OLD} → ${NEW}`]);
  await store.close();
});

test("refreshAgents carries on past a node whose detail fetch fails", async () => {
  const store = new SqliteNomadStore(":memory:");
  const AGENT = "uhCAkEgwsRQmYpVUGWSdNyziQgQZu1sfXVlVIR0sbEZJBd5N6wYr_";
  const client = fakeClient(
    {},
    new Set(),
    [
      { ID: "n1", Name: "n1", Status: "ready", ModifyIndex: 50 },
      { ID: "n2", Name: "n2", Status: "ready", ModifyIndex: 60 },
    ],
    { n2: AGENT },
  );
  const getNode = client.getNode.bind(client);
  client.getNode = async (id: string) => {
    if (id === "n1") throw new Error("detail down");
    return getNode(id);
  };
  const lines: string[] = [];
  const watcher = new StreamWatcher(client, store, {
    now: () => 9,
    log: (m) => lines.push(m),
  });

  assert.equal(await watcher.refreshAgents(), 1);
  assert.equal(await store.getNodeAgent("n2"), AGENT);
  assert.ok(
    lines.some((l) => /node n1 detail fetch failed — detail down/.test(l)),
  );
  await store.close();
});
