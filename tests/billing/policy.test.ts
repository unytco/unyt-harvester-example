import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_POLICY,
  validatePolicy,
  loadPolicy,
  applyPolicy,
  resolveRuleUnits,
  ResolvedPolicy,
} from "../../src/billing/policy.js";

const UNITS = new Map([
  ["TOKIN", 7],
  ["TOKOUT", 8],
]);
const resolved = resolveRuleUnits(DEFAULT_POLICY, UNITS);

test("resolveRuleUnits maps symbols to network indices", () => {
  const byMetric = Object.fromEntries(
    resolved.rules.map((r) => [r.metricKey, r.unitIndex]),
  );
  assert.equal(byMetric["inputTokens"], 7);
  assert.equal(byMetric["outputTokens"], 8);
});

test("resolveRuleUnits rejects an unknown symbol", () => {
  const policy = {
    ...DEFAULT_POLICY,
    rules: [{ metricKey: "x", unitSymbol: "TOKX" }],
  };
  assert.throws(
    () => resolveRuleUnits(policy, UNITS),
    /unknown unit symbol TOKX/,
  );
});

test("applyPolicy bills input and output tokens as raw counts", () => {
  const amount = applyPolicy(resolved, {
    inputTokens: 1200n,
    outputTokens: 300n,
  });
  assert.deepEqual(amount, { "7": "1200", "8": "300" });
});

test("applyPolicy omits a unit with no value", () => {
  assert.deepEqual(applyPolicy(resolved, { outputTokens: 0n }), {});
  assert.deepEqual(applyPolicy(resolved, { outputTokens: 5n }), { "8": "5" });
});

test("applyPolicy scales and sums keys that share a unit", () => {
  const policy: ResolvedPolicy = {
    version: "t",
    ctRoleId: "r",
    rules: [
      { metricKey: "a", unitSymbol: "U", unitIndex: 0, scale: 2 },
      { metricKey: "b", unitSymbol: "U", unitIndex: 0, scale: 10 },
    ],
  };
  // 5*2 + 3*10 = 40 onto unit 0
  assert.deepEqual(applyPolicy(policy, { a: 5n, b: 3n }), { "0": "40" });
});

test("applyPolicy excludes opted-out and zero/unknown metrics", () => {
  const policy: ResolvedPolicy = {
    version: "t",
    ctRoleId: "r",
    rules: [
      { metricKey: "billed", unitSymbol: "A", unitIndex: 0 },
      {
        metricKey: "captured-only",
        unitSymbol: "B",
        unitIndex: 1,
        include: false,
      },
    ],
  };
  assert.deepEqual(applyPolicy(policy, { billed: 7n, "captured-only": 99n }), {
    "0": "7",
  });
  assert.deepEqual(applyPolicy(policy, { billed: 0n }), {});
});

test("validatePolicy accepts the default and round-trips JSON", () => {
  const parsed = validatePolicy(JSON.parse(JSON.stringify(DEFAULT_POLICY)));
  assert.equal(parsed.version, "default-1");
  assert.deepEqual(
    parsed.rules.map((r) => [r.metricKey, r.unitSymbol]),
    [
      ["inputTokens", "TOKIN"],
      ["outputTokens", "TOKOUT"],
    ],
  );
});

test("validatePolicy rejects a rule with unitIndex", () => {
  assert.throws(
    () =>
      validatePolicy({
        version: "v",
        ctRoleId: "r",
        rules: [{ metricKey: "a", unitIndex: 5 }],
      }),
    /unitSymbol/,
  );
});

test("validatePolicy rejects malformed policies", () => {
  assert.throws(() => validatePolicy(null), /JSON object/);
  assert.throws(() =>
    validatePolicy({ version: "", ctRoleId: "r", rules: [] }),
  );
  assert.throws(() =>
    validatePolicy({ version: "v", ctRoleId: "r", rules: [] }),
  );
  assert.throws(() =>
    validatePolicy({
      version: "v",
      ctRoleId: "r",
      rules: [
        { metricKey: "a", unitSymbol: "A" },
        { metricKey: "a", unitSymbol: "B" },
      ],
    }),
  );
});

test("default policy parks as invoicer", async () => {
  const p = await loadPolicy(undefined);
  assert.equal(p.ctRoleId, "invoicer");
});
