import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  NodeStatusEvent,
  SqliteNomadStore,
  StoredAllocation,
} from "../../../src/sources/nomad/store.js";

function alloc(over: Partial<StoredAllocation> = {}): StoredAllocation {
  return {
    allocId: "a1",
    nodeId: "n1",
    nodeName: "node-one",
    jobId: "job",
    taskGroup: "tg",
    clientStatus: "running",
    desiredStatus: "run",
    createTime: 1,
    modifyTime: 2,
    modifyIndex: 10,
    observedAt: 100,
    raw: "{}",
    ...over,
  };
}

test("upsert inserts new allocations", async () => {
  const store = new SqliteNomadStore(":memory:");
  const r = await store.upsertAllocations([alloc(), alloc({ allocId: "a2" })]);
  assert.deepEqual(r, { inserted: 2, updated: 0, unchanged: 0 });
  assert.equal((await store.allocationsForNode("n1")).length, 2);
  await store.close();
});

test("persists across reopen and re-migrates idempotently", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wt-hf-store-"));
  const dbPath = path.join(dir, "store.db");
  try {
    const first = new SqliteNomadStore(dbPath);
    await first.upsertAllocations([alloc({ allocId: "a1", modifyIndex: 7 })]);
    await first.setNodeSync({
      nodeId: "n1",
      lastModifyIndex: 7,
      lastSyncedAt: 42,
    });
    await first.close();

    // Reopen the same file: schema CREATE-IF-NOT-EXISTS must be a no-op and the
    // data must still be there — this is the durable "current state" contract.
    const second = new SqliteNomadStore(dbPath);
    const rows = await second.allocationsForNode("n1");
    assert.equal(rows.length, 1);
    assert.equal(rows[0].allocId, "a1");
    assert.deepEqual(await second.getNodeSync("n1"), {
      nodeId: "n1",
      lastModifyIndex: 7,
      lastSyncedAt: 42,
    });

    // A pull after reopen still upserts correctly against existing rows.
    const r = await second.upsertAllocations([
      alloc({ allocId: "a1", modifyIndex: 8 }),
    ]);
    assert.deepEqual(r, { inserted: 0, updated: 1, unchanged: 0 });
    await second.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("round-trips realistic ms timestamps without read-back overflow", async () => {
  const store = new SqliteNomadStore(":memory:");
  await store.upsertAllocations([
    alloc({ createTime: 1781706244869, modifyTime: 1781706245000 }),
  ]);
  const [row] = await store.allocationsForNode("n1");
  assert.equal(row.createTime, 1781706244869);
  assert.equal(row.modifyTime, 1781706245000);
  await store.close();
});

test("re-pulling identical data is idempotent (no spurious updates)", async () => {
  const store = new SqliteNomadStore(":memory:");
  await store.upsertAllocations([alloc()]);
  const again = await store.upsertAllocations([alloc()]);
  assert.deepEqual(again, { inserted: 0, updated: 0, unchanged: 1 });
  await store.close();
});

test("a newer modifyIndex updates current state; a stale one is ignored", async () => {
  const store = new SqliteNomadStore(":memory:");
  await store.upsertAllocations([alloc({ clientStatus: "running" })]);

  const newer = await store.upsertAllocations([
    alloc({ modifyIndex: 11, clientStatus: "complete" }),
  ]);
  assert.deepEqual(newer, { inserted: 0, updated: 1, unchanged: 0 });
  assert.equal(
    (await store.allocationsForNode("n1"))[0].clientStatus,
    "complete",
  );

  // An out-of-order/stale pull must not roll the state backwards.
  const stale = await store.upsertAllocations([
    alloc({ modifyIndex: 9, clientStatus: "running" }),
  ]);
  assert.deepEqual(stale, { inserted: 0, updated: 0, unchanged: 1 });
  assert.equal(
    (await store.allocationsForNode("n1"))[0].clientStatus,
    "complete",
  );
  await store.close();
});

test("allocationsForNode filters by node and orders by modifyIndex desc", async () => {
  const store = new SqliteNomadStore(":memory:");
  await store.upsertAllocations([
    alloc({ allocId: "a1", nodeId: "n1", modifyIndex: 5 }),
    alloc({ allocId: "a2", nodeId: "n1", modifyIndex: 9 }),
    alloc({ allocId: "a3", nodeId: "n2", modifyIndex: 7 }),
  ]);
  const n1 = await store.allocationsForNode("n1");
  assert.deepEqual(
    n1.map((a) => a.allocId),
    ["a2", "a1"],
  );
  assert.equal((await store.allocationsForNode("n2")).length, 1);
  await store.close();
});

test("node sync bookkeeping round-trips and upserts", async () => {
  const store = new SqliteNomadStore(":memory:");
  assert.equal(await store.getNodeSync("n1"), undefined);
  await store.setNodeSync({
    nodeId: "n1",
    lastModifyIndex: 10,
    lastSyncedAt: 100,
  });
  assert.deepEqual(await store.getNodeSync("n1"), {
    nodeId: "n1",
    lastModifyIndex: 10,
    lastSyncedAt: 100,
  });
  await store.setNodeSync({
    nodeId: "n1",
    lastModifyIndex: 20,
    lastSyncedAt: 200,
  });
  assert.equal((await store.getNodeSync("n1"))?.lastModifyIndex, 20);
  await store.close();
});

function statusEvent(over: Partial<NodeStatusEvent> = {}): NodeStatusEvent {
  return {
    nodeId: "n1",
    nodeName: "node-one",
    status: "ready",
    eligibility: "eligible",
    eventType: "NodeRegistration",
    modifyIndex: 100,
    observedAt: 1000,
    raw: "{}",
    ...over,
  };
}

test("recordNodeStatus appends and dedupes re-delivered events", async () => {
  const store = new SqliteNomadStore(":memory:");
  const first = await store.recordNodeStatus([
    statusEvent({ modifyIndex: 100, status: "ready" }),
    statusEvent({ modifyIndex: 120, status: "down" }),
  ]);
  assert.deepEqual(first, { inserted: 2, ignored: 0 });

  // A resume re-delivers index 120 and adds a new 140 — only 140 is new.
  const second = await store.recordNodeStatus([
    statusEvent({ modifyIndex: 120, status: "down" }),
    statusEvent({ modifyIndex: 140, status: "ready" }),
  ]);
  assert.deepEqual(second, { inserted: 1, ignored: 1 });
  await store.close();
});

test("nodeStatusHistory returns a node's transitions oldest-first", async () => {
  const store = new SqliteNomadStore(":memory:");
  await store.recordNodeStatus([
    statusEvent({ nodeId: "n1", modifyIndex: 140, status: "ready" }),
    statusEvent({ nodeId: "n1", modifyIndex: 100, status: "ready" }),
    statusEvent({ nodeId: "n1", modifyIndex: 120, status: "down" }),
    statusEvent({ nodeId: "n2", modifyIndex: 110, status: "down" }),
  ]);
  const h = await store.nodeStatusHistory("n1");
  assert.deepEqual(
    h.map((e) => [e.modifyIndex, e.status]),
    [
      [100, "ready"],
      [120, "down"],
      [140, "ready"],
    ],
  );
  assert.equal((await store.nodeStatusHistory("n2")).length, 1);
  await store.close();
});

test("node agent id round-trips and is last-writer-wins per node", async () => {
  const store = new SqliteNomadStore(":memory:");
  assert.equal(await store.getNodeAgent("n1"), null); // none seen yet
  await store.setNodeAgent("n1", "uhCAk-first", 100);
  assert.equal(await store.getNodeAgent("n1"), "uhCAk-first");
  await store.setNodeAgent("n1", "uhCAk-second", 200); // overwrite
  assert.equal(await store.getNodeAgent("n1"), "uhCAk-second");
  assert.equal(await store.getNodeAgent("n2"), null); // isolated per node
  await store.close();
});

test("stream index defaults to 0 and round-trips", async () => {
  const store = new SqliteNomadStore(":memory:");
  assert.equal(await store.getStreamIndex(), 0);
  await store.setStreamIndex(334615);
  assert.equal(await store.getStreamIndex(), 334615);
  await store.setStreamIndex(334620);
  assert.equal(await store.getStreamIndex(), 334620);
  await store.close();
});

test("disconnect windows are appended and listed oldest-first", async () => {
  const store = new SqliteNomadStore(":memory:");
  assert.deepEqual(await store.listDisconnects(), []);
  await store.recordDisconnect({
    startedAt: 100,
    endedAt: 150,
    durationMs: 50,
    reason: "eof",
    resumeIndex: 10,
  });
  await store.recordDisconnect({
    startedAt: 200,
    endedAt: 260,
    durationMs: 60,
    reason: "idle-timeout",
    resumeIndex: 20,
  });
  const ds = await store.listDisconnects();
  assert.deepEqual(
    ds.map((d) => [d.startedAt, d.reason, d.resumeIndex]),
    [
      [100, "eof", 10],
      [200, "idle-timeout", 20],
    ],
  );
  await store.close();
});

test("allNodeIds unions allocations and status events", async () => {
  const store = new SqliteNomadStore(":memory:");
  await store.upsertAllocations([alloc({ allocId: "x", nodeId: "n1" })]);
  await store.recordNodeStatus([statusEvent({ nodeId: "n2", modifyIndex: 1 })]);
  assert.deepEqual(await store.allNodeIds(), ["n1", "n2"]);
  await store.close();
});
