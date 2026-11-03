import { test } from "node:test";
import assert from "node:assert/strict";
import { SqliteStore } from "../../src/store/sqlite-store.js";

function metric(
  over: Partial<import("../../src/store/store.js").MetricRecord> = {},
) {
  return {
    sourceId: "node-1",
    unytPubKey: "node-1",
    metricKey: "nomadAvailability",
    windowStart: 1000,
    windowEnd: 2000,
    value: "60",
    status: "pending" as const,
    attempts: 0,
    lastError: null,
    createdAt: 10,
    invoicedAt: null,
    ...over,
  };
}

test("upsertMetrics is idempotent by (sourceId, metricKey, windowStart)", async () => {
  const store = new SqliteStore(":memory:");
  const first = await store.upsertMetrics([
    metric(),
    metric({ metricKey: "nomadTestTime", value: "3" }),
  ]);
  assert.deepEqual(first, { inserted: 2, updated: 0, skipped: 0 });

  // Re-aggregating the same window must not duplicate ("analyzed once").
  const again = await store.upsertMetrics([metric()]);
  assert.deepEqual(again, { inserted: 0, updated: 0, skipped: 1 });
  await store.close();
});

test("invoice lifecycle: pending -> invoiced, with failure retry tracking", async () => {
  const store = new SqliteStore(":memory:");
  await store.upsertMetrics([
    metric({ metricKey: "a" }),
    metric({ metricKey: "b" }),
  ]);
  const pend = await store.pendingMetrics();
  assert.equal(pend.length, 2);

  // One fails (stays pending, attempts bumped), one is invoiced.
  await store.markFailed(pend[0].id as number, "boom");
  await store.markInvoiced([pend[1].id as number], 5000);

  const summary = await store.metricsSummary();
  assert.equal(summary.invoiced, 1);
  assert.equal(summary.pending, 1);
  assert.equal(summary.failed, 1); // pending with attempts > 0
  assert.equal(summary.lastInvoicedAt, 5000);

  // Still-pending (failed) record is returned for retry.
  const retry = await store.pendingMetrics();
  assert.equal(retry.length, 1);
  assert.equal(retry[0].attempts, 1);
  assert.equal(retry[0].lastError, "boom");

  const recent = await store.recentlyInvoiced();
  assert.equal(recent.length, 1);
  assert.equal(recent[0].status, "invoiced");
  await store.close();
});

test("lastProcessedWindow cursor defaults to 0 and round-trips", async () => {
  const store = new SqliteStore(":memory:");
  assert.equal(await store.lastProcessedWindow(), 0);
  await store.setLastProcessedWindow(1718000000000);
  assert.equal(await store.lastProcessedWindow(), 1718000000000);
  await store.close();
});

test("agent presence starts unchecked and counts checks per key", async () => {
  const store = new SqliteStore(":memory:");
  assert.equal(await store.getAgentPresence("uhCAk-a"), null);
  await store.setAgentPresence("uhCAk-a", false, 150);
  await store.setAgentPresence("uhCAk-a", false, 160);
  assert.deepEqual(await store.getAgentPresence("uhCAk-a"), {
    presence: "absent",
    checks: 2,
    checkedAt: 160,
    firstSkippedWindow: null,
  });
  await store.setAgentPresence("uhCAk-a", true, 250);
  assert.deepEqual(await store.getAgentPresence("uhCAk-a"), {
    presence: "present",
    checks: 3,
    checkedAt: 250,
    firstSkippedWindow: null,
  });
  assert.equal(await store.getAgentPresence("uhCAk-b"), null);
  await store.close();
});

test("claimPlan refuses rows that changed since the plan was built", async () => {
  const store = new SqliteStore(":memory:");
  await store.upsertMetrics([metric({ value: "60" })]);
  const [row] = await store.pendingMetrics();
  // process raises the window's total before invoice claims it.
  await store.upsertMetrics([metric({ value: "70" })]);
  const claim = {
    key: "k1",
    payee: "node-1",
    periodStart: 1000,
    amount: { "5": "60" },
    spenderPayload: {},
    rows: [{ id: row.id as number, value: "60" }],
  };
  assert.equal(await store.claimPlan(claim), false);
  assert.equal((await store.claimedPlans()).length, 0);
  assert.equal(
    await store.claimPlan({
      ...claim,
      rows: [{ id: row.id as number, value: "70" }],
    }),
    true,
  );
  assert.deepEqual(
    (await store.claimedPlans()).map((c) => [c.key, c.recordIds]),
    [["k1", [row.id]]],
  );
  // Claimed rows are no longer pending, and count as covered.
  assert.equal((await store.pendingMetrics()).length, 0);
  assert.deepEqual(await store.upsertMetrics([metric({ value: "75" })]), {
    inserted: 1,
    updated: 0,
    skipped: 0,
  });
  await store.close();
});
