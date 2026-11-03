import { test } from "node:test";
import assert from "node:assert/strict";
import {
  periodStartFor,
  periodEnd,
  isPeriodComplete,
} from "../../src/billing/period.js";

const DAY = 24 * 60 * 60 * 1000;

test("periodStartFor floors to the epoch-aligned period boundary", () => {
  assert.equal(periodStartFor(DAY + 1, DAY), DAY);
  assert.equal(periodStartFor(2 * DAY, DAY), 2 * DAY);
  assert.equal(periodEnd(DAY, DAY), 2 * DAY);
});

test("periodStartFor throws on non-positive period", () => {
  assert.throws(() => periodStartFor(1, 0), /positive/);
});

test("isPeriodComplete requires both elapsed and aggregated", () => {
  const start = DAY;
  const end = 2 * DAY;
  // elapsed and aggregated through the end -> complete
  assert.equal(isPeriodComplete(start, DAY, end, end), true);
  // not yet elapsed
  assert.equal(isPeriodComplete(start, DAY, end - 1, end), false);
  // elapsed but aggregation hasn't caught up -> would under-bill
  assert.equal(isPeriodComplete(start, DAY, end, end - 1), false);
});
