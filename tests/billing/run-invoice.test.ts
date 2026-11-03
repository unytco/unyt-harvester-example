import { test } from "node:test";
import assert from "node:assert/strict";
import { SqliteStore } from "../../src/store/sqlite-store.js";
import { buildMetric } from "../../src/pipeline/format.js";
import { runInvoice, Reporter } from "../../src/billing/run-invoice.js";
import { invoiceKey } from "../../src/billing/invoice.js";
import { DEFAULT_POLICY, resolveRuleUnits } from "../../src/billing/policy.js";
import { ParkedSpend } from "../../src/holochain/hc-client.js";

const DAY = 24 * 60 * 60 * 1000;

/** Parks into memory; its parked keys are the keys of the spends it took. */
class FakeReporter implements Reporter {
  calls: ParkedSpend[] = [];
  fail = false;
  async report(spend: ParkedSpend): Promise<void> {
    if (this.fail) {
      throw new Error("boom");
    }
    this.calls.push(spend);
  }
  async parkedInvoiceKeys(): Promise<Set<string>> {
    return new Set(
      this.calls.map(
        (c) => (c.spenderPayload as { invoice_key: string }).invoice_key,
      ),
    );
  }
}

async function seed(store: SqliteStore) {
  await store.upsertMetrics([
    buildMetric({
      sourceId: "n1",
      unytPubKey: "u-alice",
      metricKey: "inputTokens",
      windowStart: DAY,
      windowEnd: 2 * DAY,
      value: 86400,
      createdAt: 0,
    }),
    buildMetric({
      sourceId: "n1",
      unytPubKey: "u-alice",
      metricKey: "outputTokens",
      windowStart: DAY,
      windowEnd: 2 * DAY,
      value: 5,
      createdAt: 0,
    }),
  ]);
  // aggregation has run through the end of the period
  await store.setLastProcessedWindow(DAY);
}

const opts = {
  policy: resolveRuleUnits(
    DEFAULT_POLICY,
    new Map([
      ["TOKIN", 5],
      ["TOKOUT", 6],
    ]),
  ),
  agreementId: "uTESTAGREEMENT",
  periodMs: DAY,
  windowMs: DAY,
  now: () => 3 * DAY,
};

test("runInvoice creates one spend per payee/period and marks records invoiced", async () => {
  const store = new SqliteStore(":memory:");
  await seed(store);
  const reporter = new FakeReporter();

  const r = await runInvoice(store, reporter, opts);

  assert.equal(r.spends, 1);
  assert.equal(r.records, 2);
  assert.equal(reporter.calls.length, 1);
  // Each measure bills its raw count: TOKIN (unit 5) = 86400, TOKOUT (unit 6) = 5.
  assert.deepEqual(reporter.calls[0].amount, { "5": "86400", "6": "5" });
  assert.equal(reporter.calls[0].agreementId, "uTESTAGREEMENT");

  // second run is a no-op — records are no longer pending
  const r2 = await runInvoice(store, reporter, opts);
  assert.equal(r2.spends, 0);
  assert.equal(reporter.calls.length, 1);
  await store.close();
});

test("a failed spend leaves its plan claimed for retry", async () => {
  const store = new SqliteStore(":memory:");
  await seed(store);
  const reporter = new FakeReporter();
  reporter.fail = true;

  const r = await runInvoice(store, reporter, opts);
  assert.equal(r.spends, 0);
  assert.equal(r.failed, 1);

  // recovers on a later successful run
  reporter.fail = false;
  const r2 = await runInvoice(store, reporter, opts);
  assert.equal(r2.spends, 1);
  assert.equal(r2.records, 2);
  await store.close();
});

test("dry-run creates no spends and marks nothing", async () => {
  const store = new SqliteStore(":memory:");
  await seed(store);
  const reporter = new FakeReporter();

  const r = await runInvoice(store, reporter, { ...opts, dryRun: true });
  assert.equal(r.spends, 0);
  assert.equal(r.plans.length, 1);
  assert.equal(reporter.calls.length, 0);

  // still pending afterwards
  const r2 = await runInvoice(store, reporter, opts);
  assert.equal(r2.spends, 1);
  await store.close();
});

test("drain invoices the in-progress period a normal run holds back", async () => {
  const store = new SqliteStore(":memory:");
  await seed(store); // metrics in period [DAY, 2*DAY)
  const reporter = new FakeReporter();

  // now is mid-period: [DAY, 2*DAY) hasn't elapsed, so a normal run bills nothing.
  const midPeriod = { ...opts, now: () => DAY + 1 };
  const normal = await runInvoice(store, reporter, midPeriod);
  assert.equal(normal.spends, 0);

  // drain closes out the current period.
  const drained = await runInvoice(store, reporter, {
    ...midPeriod,
    drain: true,
  });
  assert.equal(drained.spends, 1);
  assert.equal(reporter.calls.length, 1);
  await store.close();
});

test("a payee with only outputTokens parks under the pinned lane", async () => {
  const store = new SqliteStore(":memory:");
  await store.upsertMetrics([
    buildMetric({
      sourceId: "op-1",
      unytPubKey: "u-alice",
      metricKey: "outputTokens",
      windowStart: DAY,
      windowEnd: 2 * DAY,
      value: 42,
      createdAt: 0,
    }),
  ]);
  await store.setLastProcessedWindow(DAY);
  const reporter = new FakeReporter();

  const r = await runInvoice(store, reporter, {
    ...opts,
    laneDefinitionIds: ["uhCkkLANE"],
  });

  assert.equal(r.spends, 1);
  assert.deepEqual(reporter.calls[0].amount, { "6": "42" });
  assert.deepEqual(reporter.calls[0].laneDefinitionIds, ["uhCkkLANE"]);
  await store.close();
});

test("a plan already parked is marked invoiced without reporting again", async () => {
  const store = new SqliteStore(":memory:");
  await seed(store);
  const reporter = new FakeReporter();
  // Park once, then put the records back to pending as if the mark was lost.
  await runInvoice(store, reporter, opts);
  const parked = reporter.calls.length;
  const store2 = new SqliteStore(":memory:");
  await seed(store2);

  const logs: string[] = [];
  const r = await runInvoice(store2, reporter, {
    ...opts,
    log: (m) => logs.push(m),
  });

  assert.equal(reporter.calls.length, parked);
  assert.equal(r.spends, 0);
  assert.equal((await store2.pendingMetrics()).length, 0);
  assert.match(logs.join("\n"), /already parked/);
});

test("crash after report, before marking, then rerun parks once", async () => {
  const store = new SqliteStore(":memory:");
  await seed(store);
  const reporter = new FakeReporter();
  const mark = store.markClaimInvoiced.bind(store);
  store.markClaimInvoiced = async () => {
    throw new Error("crash");
  };
  await assert.rejects(runInvoice(store, reporter, opts), /crash/);
  store.markClaimInvoiced = mark;

  await runInvoice(store, reporter, opts);

  assert.equal(reporter.calls.length, 1);
  assert.equal((await store.pendingMetrics()).length, 0);
});

/** Sum of a unit across every spend the reporter took. */
function parkedTotal(reporter: FakeReporter, unit: string): bigint {
  return reporter.calls.reduce((n, c) => n + BigInt(c.amount[unit] ?? "0"), 0n);
}

test("a late record after a crash is paid on top, not twice", async () => {
  const store = new SqliteStore(":memory:");
  await seed(store);
  const reporter = new FakeReporter();
  const mark = store.markClaimInvoiced.bind(store);
  store.markClaimInvoiced = async () => {
    throw new Error("crash");
  };
  await assert.rejects(runInvoice(store, reporter, opts), /crash/);
  store.markClaimInvoiced = mark;

  // A late record raises the window's input tokens from 86400 to 90000.
  await store.upsertMetrics([
    buildMetric({
      sourceId: "n1",
      unytPubKey: "u-alice",
      metricKey: "inputTokens",
      windowStart: DAY,
      windowEnd: 2 * DAY,
      value: 90000,
      createdAt: 0,
    }),
  ]);
  await runInvoice(store, reporter, opts);

  assert.equal(reporter.calls.length, 2);
  assert.equal(parkedTotal(reporter, "5"), 90000n);
  assert.equal(parkedTotal(reporter, "6"), 5n);
  assert.equal((await store.pendingMetrics()).length, 0);
});

test("a park that fails ambiguously stays claimed, blocks execute, and is not parked again", async () => {
  const store = new SqliteStore(":memory:");
  await seed(store);
  const reporter = new FakeReporter();
  // The commit lands, but the call reports an error (a timeout, say).
  const report = reporter.report.bind(reporter);
  reporter.report = async (spend) => {
    await report(spend);
    throw new Error("timeout");
  };
  const r = await runInvoice(store, reporter, opts);
  assert.equal(r.unresolved, 1);
  reporter.report = report;

  const r2 = await runInvoice(store, reporter, opts);
  assert.equal(r2.unresolved, 0);
  assert.equal(reporter.calls.length, 1);
  assert.equal((await store.pendingMetrics()).length, 0);
});

test("a park that never landed is retried with its claimed amount", async () => {
  const store = new SqliteStore(":memory:");
  await seed(store);
  const reporter = new FakeReporter();
  reporter.fail = true;
  const r = await runInvoice(store, reporter, opts);
  assert.equal(r.unresolved, 1);
  reporter.fail = false;
  // New work for the same window arrives before the retry.
  await store.upsertMetrics([
    buildMetric({
      sourceId: "n1",
      unytPubKey: "u-alice",
      metricKey: "inputTokens",
      windowStart: DAY,
      windowEnd: 2 * DAY,
      value: 90000,
      createdAt: 0,
    }),
  ]);

  await runInvoice(store, reporter, opts);

  assert.deepEqual(reporter.calls[0].amount, { "5": "86400", "6": "5" });
  assert.deepEqual(reporter.calls[1].amount, { "5": "3600" });
  assert.equal((await store.pendingMetrics()).length, 0);
});

test("invoiceKey is stable and policy-version sensitive", () => {
  const plan = {
    agreementId: "uhCkkA",
    payee: "uhCAkP",
    periodStart: 60_000,
    policyVersion: "v1",
    recordIds: [3, 1, 2],
  };
  assert.equal(invoiceKey(plan), invoiceKey({ ...plan, recordIds: [1, 2, 3] }));
  assert.match(invoiceKey(plan), /^[0-9a-f]{64}$/);
  assert.notEqual(
    invoiceKey(plan),
    invoiceKey({ ...plan, policyVersion: "v2" }),
  );
  // A follow-up spend for late records in the same period is a different spend.
  assert.notEqual(invoiceKey(plan), invoiceKey({ ...plan, recordIds: [9] }));
});
