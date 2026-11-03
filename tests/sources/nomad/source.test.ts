import { test } from "node:test";
import assert from "node:assert/strict";
import { SqliteNomadStore } from "../../../src/sources/nomad/store.js";
import { nomadSource } from "../../../src/sources/nomad/source.js";

const KEY = "uhCAkEgwsRQmYpVUGWSdNyziQgQZu1sfXVlVIR0sbEZJBd5N6wYr_";
const HOUR = 3_600_000;

test("nomadSource.measure returns uptime and test seconds per node", async () => {
  const store = new SqliteNomadStore(":memory:");
  await store.setNodeAgent("n1", KEY, 0);
  // Ready from before the window until half way through it.
  await store.recordNodeStatus([
    {
      nodeId: "n1",
      nodeName: "node-one",
      status: "ready",
      eligibility: "eligible",
      eventType: "NodeRegistration",
      modifyIndex: 1,
      observedAt: 0,
      raw: "{}",
    },
    {
      nodeId: "n1",
      nodeName: "node-one",
      status: "down",
      eligibility: "eligible",
      eventType: "NodeStreamEvent",
      modifyIndex: 2,
      observedAt: HOUR + HOUR / 2,
      raw: "{}",
    },
  ]);
  // One allocation ran for 10 minutes inside the window.
  await store.upsertAllocations([
    {
      allocId: "a1",
      nodeId: "n1",
      nodeName: "node-one",
      jobId: "job",
      taskGroup: "tg",
      clientStatus: "complete",
      desiredStatus: "run",
      createTime: HOUR + 60_000,
      modifyTime: HOUR + 11 * 60_000,
      modifyIndex: 3,
      observedAt: 0,
      raw: "{}",
    },
  ]);
  const source = nomadSource({ store });
  const got = await source.measure(HOUR, 2 * HOUR);
  assert.deepEqual(
    got.map((m) => [m.sourceId, m.operatorKey, m.metricKey, m.value]),
    [
      ["n1", KEY, "nomadAvailability", "1800"],
      ["n1", KEY, "nomadTestTime", "600"],
    ],
  );
  await source.close();
});

test("nomadSource reports a node with no agent key as an empty key", async () => {
  const store = new SqliteNomadStore(":memory:");
  await store.recordNodeStatus([
    {
      nodeId: "n2",
      nodeName: null,
      status: "ready",
      eligibility: "eligible",
      eventType: "NodeRegistration",
      modifyIndex: 1,
      observedAt: 0,
      raw: "{}",
    },
  ]);
  const got = await nomadSource({ store }).measure(HOUR, 2 * HOUR);
  assert.deepEqual(
    got.map((m) => [m.sourceId, m.operatorKey]),
    [["n2", ""]],
  );
});
