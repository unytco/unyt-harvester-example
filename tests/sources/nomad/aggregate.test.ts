import { test } from "node:test";
import assert from "node:assert/strict";
import {
  computeUptimeMs,
  computeUptimeSeconds,
  computeTestMs,
  computeTestSeconds,
} from "../../../src/sources/nomad/aggregate.js";
import {
  NodeStatus,
  NodeStatusEvent,
  StoredAllocation,
} from "../../../src/sources/nomad/store.js";

function ev(
  status: NodeStatus,
  observedAt: number,
  modifyIndex: number,
): NodeStatusEvent {
  return {
    nodeId: "n1",
    nodeName: "n1",
    status,
    eligibility: "eligible",
    eventType: "NodeStreamEvent",
    modifyIndex,
    observedAt,
    raw: "{}",
  };
}

const W0 = 1000;
const W1 = 2000; // window [1000, 2000)

test("ready before and through the window is fully credited", () => {
  // last status before window is ready; no transitions inside.
  assert.equal(computeUptimeMs([ev("ready", 500, 1)], W0, W1), 1000);
});

test("a down->ready transition mid-window credits only the ready part", () => {
  // down before window, comes ready at 1600 -> 400ms ready.
  const t = [ev("down", 500, 1), ev("ready", 1600, 2)];
  assert.equal(computeUptimeMs(t, W0, W1), 400);
});

test("a ready->down transition mid-window credits only up to the drop", () => {
  const t = [ev("ready", 500, 1), ev("down", 1300, 2)];
  assert.equal(computeUptimeMs(t, W0, W1), 300);
});

test("status unknown before the window is not credited until first known", () => {
  // first ever transition is inside the window -> only from there.
  assert.equal(computeUptimeMs([ev("ready", 1400, 1)], W0, W1), 600);
});

test("transitions outside the window don't leak in", () => {
  const t = [ev("ready", 500, 1), ev("down", 2500, 2)];
  assert.equal(computeUptimeMs(t, W0, W1), 1000); // ready whole window
});

test("computeUptimeSeconds rounds ms to seconds", () => {
  assert.equal(computeUptimeSeconds([ev("ready", 0, 1)], 0, 3500), 4); // 3.5s -> 4
});

function alloc(
  createTime: number,
  opts: { clientStatus?: string; modifyTime?: number } = {},
): StoredAllocation {
  return {
    allocId: `a${createTime}`,
    nodeId: "n1",
    nodeName: "n1",
    jobId: "job",
    taskGroup: "tg",
    clientStatus: opts.clientStatus ?? "running",
    desiredStatus: "run",
    createTime,
    modifyTime: opts.modifyTime ?? createTime,
    modifyIndex: createTime,
    observedAt: createTime,
    raw: "{}",
  };
}

test("computeTestMs sums running durations within the window", () => {
  const allocs = [
    alloc(2000), // running -> [2000, 10000) = 8000ms
    alloc(1000, { clientStatus: "complete", modifyTime: 4000 }), // 3000ms
    alloc(5000, { clientStatus: "pending" }), // not running -> 0
  ];
  assert.equal(computeTestMs(allocs, 0, 10000), 11000);
  assert.equal(computeTestSeconds(allocs, 0, 10000), 11);
});

test("computeTestMs clips to the window and drops allocs outside it", () => {
  const allocs = [
    alloc(-1000), // running, started before window -> [0, 10000) = 10000ms
    alloc(8000, { clientStatus: "complete", modifyTime: 20000 }), // [8000,10000) = 2000ms
    alloc(-5000, { clientStatus: "complete", modifyTime: -1000 }), // ended before window -> 0
  ];
  assert.equal(computeTestSeconds(allocs, 0, 10000), 12);
});

test("computeTestSeconds rounds ms to seconds", () => {
  assert.equal(computeTestSeconds([alloc(0)], 0, 3500), 4); // 3.5s -> 4
});
