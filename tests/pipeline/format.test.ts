import { test } from "node:test";
import assert from "node:assert/strict";
import { buildMetric } from "../../src/pipeline/format.js";

test("buildMetric produces a pending outbox record (bigint-safe value)", () => {
  const m = buildMetric({
    sourceId: "node-1",
    unytPubKey: "payee-1",
    metricKey: "outputTokens",
    windowStart: 1000,
    windowEnd: 2000,
    value: 4,
    createdAt: 50,
  });
  assert.equal(m.sourceId, "node-1");
  assert.equal(m.unytPubKey, "payee-1");
  assert.equal(m.metricKey, "outputTokens");
  assert.equal(m.value, "4"); // stringified
  assert.equal(m.status, "pending");
  assert.equal(m.attempts, 0);
  assert.equal(m.windowStart, 1000);
  assert.equal(m.invoicedAt, null);
});

test("buildMetric clamps/floors the value", () => {
  assert.equal(
    buildMetric({
      sourceId: "n",
      unytPubKey: "p",
      metricKey: "x",
      windowStart: 0,
      windowEnd: 1,
      value: 7.9,
      createdAt: 0,
    }).value,
    "7",
  );
  assert.equal(
    buildMetric({
      sourceId: "n",
      unytPubKey: "p",
      metricKey: "x",
      windowStart: 0,
      windowEnd: 1,
      value: -3,
      createdAt: 0,
    }).value,
    "0",
  );
});
