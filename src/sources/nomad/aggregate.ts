import { NodeStatus, NodeStatusEvent, StoredAllocation } from "./store.js";

/**
 * Derivation primitives — pure functions over a time window
 * `[windowStart, windowEnd)` (ms epoch).
 *
 * Two reward dimensions: availability is reported as seconds-of-`ready` in the
 * window (the node was online and able to run tests); usage is reported as the
 * total seconds allocations spent running on the node in the window (a stand-in
 * for test bandwidth consumed). Both are recomputable from stored raw data if
 * the definitions change.
 */

/**
 * Milliseconds a node was `ready` within the window.
 *
 * Carries the last-known status from before the window across `windowStart`, so
 * a node that was already up is credited from the window start. Time before any
 * known status is treated as not-ready (not credited). Uses `observedAt` as the
 * wall-clock axis.
 */
export function computeUptimeMs(
  transitions: NodeStatusEvent[],
  windowStart: number,
  windowEnd: number,
): number {
  if (windowEnd <= windowStart) {
    return 0;
  }
  const sorted = [...transitions].sort(
    (a, b) => a.observedAt - b.observedAt || a.modifyIndex - b.modifyIndex,
  );

  // Status as of windowStart = the last transition observed at/before it.
  let status: NodeStatus | null = null;
  for (const t of sorted) {
    if (t.observedAt <= windowStart) {
      status = t.status;
    } else {
      break;
    }
  }

  let cursor = windowStart;
  let uptime = 0;
  for (const t of sorted) {
    if (t.observedAt <= windowStart) {
      continue;
    }
    if (t.observedAt >= windowEnd) {
      break;
    }
    if (status === "ready") {
      uptime += t.observedAt - cursor;
    }
    cursor = t.observedAt;
    status = t.status;
  }
  if (status === "ready") {
    uptime += windowEnd - cursor;
  }
  return uptime;
}

/** Seconds a node was `ready` within the window (availability metric value). */
export function computeUptimeSeconds(
  transitions: NodeStatusEvent[],
  windowStart: number,
  windowEnd: number,
): number {
  return Math.round(
    computeUptimeMs(transitions, windowStart, windowEnd) / 1000,
  );
}

/** Allocation client statuses that mean the test run has finished. */
const TERMINAL_STATUSES = new Set(["complete", "failed", "lost"]);

/**
 * Milliseconds allocations spent **running** on the node within the window — the
 * total testing time, a stand-in for usage/bandwidth.
 *
 * Each allocation contributes the overlap of its run interval with the window:
 * `[createTime, end)`, where `end` is `modifyTime` for a finished allocation
 * (complete/failed/lost) or `windowEnd` for one still running. Pending (not yet
 * running) allocations contribute nothing.
 */
export function computeTestMs(
  allocs: StoredAllocation[],
  windowStart: number,
  windowEnd: number,
): number {
  if (windowEnd <= windowStart) {
    return 0;
  }
  let total = 0;
  for (const a of allocs) {
    let allocEnd: number;
    if (TERMINAL_STATUSES.has(a.clientStatus)) {
      allocEnd = a.modifyTime;
    } else if (a.clientStatus === "running") {
      allocEnd = windowEnd;
    } else {
      continue;
    }
    const start = Math.max(windowStart, a.createTime);
    const end = Math.min(windowEnd, allocEnd);
    if (end > start) {
      total += end - start;
    }
  }
  return total;
}

/** Seconds allocations spent running within the window (usage metric value). */
export function computeTestSeconds(
  allocs: StoredAllocation[],
  windowStart: number,
  windowEnd: number,
): number {
  return Math.round(computeTestMs(allocs, windowStart, windowEnd) / 1000);
}
