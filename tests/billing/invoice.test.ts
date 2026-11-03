import { test } from "node:test";
import assert from "node:assert/strict";
import { buildInvoicePlans } from "../../src/billing/invoice.js";
import { DEFAULT_POLICY, resolveRuleUnits } from "../../src/billing/policy.js";
import { MetricRecord } from "../../src/store/store.js";

const DAY = 24 * 60 * 60 * 1000;

let nextId = 1;
function rec(over: Partial<MetricRecord>): MetricRecord {
  return {
    id: nextId++,
    sourceId: "n1",
    unytPubKey: "u-alice",
    // Default to test-time (TOKOUT, unit 1); measure→unit mapping is covered in
    // policy.test.ts and the mixed-key case below.
    metricKey: "outputTokens",
    windowStart: DAY,
    windowEnd: 2 * DAY,
    value: "100",
    status: "pending",
    attempts: 0,
    lastError: null,
    createdAt: 0,
    invoicedAt: null,
    ...over,
  };
}

const POLICY = resolveRuleUnits(
  DEFAULT_POLICY,
  new Map([
    ["TOKIN", 7],
    ["TOKOUT", 8],
  ]),
);

const complete = {
  policy: POLICY,
  periodMs: DAY,
  now: 3 * DAY,
  aggregatedThrough: 3 * DAY,
};

test("all metric keys for a payee/period collapse into ONE plan (min DHT commits)", () => {
  const plans = buildInvoicePlans(
    [
      rec({ metricKey: "inputTokens", value: "86400" }),
      rec({ metricKey: "outputTokens", value: "600" }),
    ],
    complete,
  );
  assert.equal(plans.length, 1);
  // Each measure bills its raw seconds: TOKIN (unit 5) = 86400, TOKOUT (unit 6) = 600.
  assert.deepEqual(plans[0].amount, { "7": "86400", "8": "600" });
  assert.equal(plans[0].recordIds.length, 2);
});

test("multiple aggregation windows within a period roll up", () => {
  // period = 2 days; two daily windows fall in [0, 2*DAY)
  const plans = buildInvoicePlans(
    [
      rec({ windowStart: 0, value: "100" }),
      rec({ windowStart: DAY, value: "140" }),
    ],
    {
      ...complete,
      periodMs: 2 * DAY,
      now: 4 * DAY,
      aggregatedThrough: 4 * DAY,
    },
  );
  assert.equal(plans.length, 1);
  assert.equal(plans[0].periodStart, 0);
  // Raw run-time seconds sum across both windows (100 + 140 = 240s) and bill as-is.
  assert.deepEqual(plans[0].metricTotals, { outputTokens: "240" });
  assert.deepEqual(plans[0].amount, { "8": "240" });
});

test("incomplete periods are excluded", () => {
  // window is in period [DAY, 2*DAY) but now is mid-period
  const plans = buildInvoicePlans([rec({ windowStart: DAY })], {
    ...complete,
    now: 2 * DAY - 1,
    aggregatedThrough: 2 * DAY - 1,
  });
  assert.equal(plans.length, 0);
});

test("distinct payees produce distinct plans, sorted", () => {
  const plans = buildInvoicePlans(
    [
      rec({ unytPubKey: "u-bob", value: "7" }),
      rec({ unytPubKey: "u-alice", value: "7" }),
    ],
    complete,
  );
  assert.equal(plans.length, 2);
  assert.equal(plans[0].unytPubKey, "u-alice");
  assert.equal(plans[1].unytPubKey, "u-bob");
});

test("zero-billable payees yield no plan (no commit)", () => {
  const plans = buildInvoicePlans([rec({ value: "0" })], complete);
  assert.equal(plans.length, 0);
});

test("spender payload carries policy version and breakdown", () => {
  const plans = buildInvoicePlans([rec({ value: "120" })], complete);
  const payload = plans[0].spenderPayload as any;
  assert.equal(payload.invoice_payloads[0].policy_version, "default-1");
  assert.equal(payload.invoice_payloads[0].host_pub_key, "u-alice");
  assert.deepEqual(payload.invoice_payloads[0].metrics, {
    outputTokens: "120",
  });
});

// The rhai template reads payload.units[tokin] and payload.units[tokout]
// unconditionally and errors on missing keys. `buildSpenderPayload` must
// always emit BOTH keys, zero-filling whichever measure was absent. The
// underlying parked-spend `amount` stays sparse — it's what the transactor
// validates — so only `units` is filled.

test("TOKIN-only payload zero-fills TOKOUT in units (but not in amount)", () => {
  const plans = buildInvoicePlans(
    [rec({ metricKey: "inputTokens", value: "3600" })],
    complete,
  );
  const payload = plans[0].spenderPayload as any;
  assert.deepEqual(payload.invoice_payloads[0].units, {
    "7": "3600",
    "8": "0",
  });
  assert.deepEqual(plans[0].amount, { "7": "3600" });
});

test("TOKOUT-only payload zero-fills TOKIN in units (but not in amount)", () => {
  const plans = buildInvoicePlans(
    [rec({ metricKey: "outputTokens", value: "240" })],
    complete,
  );
  const payload = plans[0].spenderPayload as any;
  assert.deepEqual(payload.invoice_payloads[0].units, {
    "7": "0",
    "8": "240",
  });
  assert.deepEqual(plans[0].amount, { "8": "240" });
});

test("payload with both measures leaves units unchanged (no zero clobber)", () => {
  const plans = buildInvoicePlans(
    [
      rec({ metricKey: "inputTokens", value: "3600" }),
      rec({ metricKey: "outputTokens", value: "240" }),
    ],
    complete,
  );
  const payload = plans[0].spenderPayload as any;
  assert.deepEqual(payload.invoice_payloads[0].units, {
    "7": "3600",
    "8": "240",
  });
  assert.deepEqual(plans[0].amount, { "7": "3600", "8": "240" });
});
