import { test } from "node:test";
import assert from "node:assert/strict";
import {
  hfCostMicro,
  fundingTotalMicro,
  fundingLargestMicro,
  microToHf,
  hfToMicro,
  latestLockedHf,
  HfPricing,
} from "../../src/billing/funding.js";

// 1 HF per unit on units 5 and 6.
const pricing: HfPricing = {
  microHfPerUnit: { "5": 1_000_000n, "6": 1_000_000n },
};

test("hfCostMicro prices each unit from the amount map (micro-HF)", () => {
  assert.equal(hfCostMicro({ "5": "1", "6": "3" }, pricing), 4_000_000n);
  assert.equal(hfCostMicro({ "5": "1" }, pricing), 1_000_000n);
  assert.equal(hfCostMicro({}, pricing), 0n);
});

test("hfCostMicro applies per-unit rates and ignores unpriced units", () => {
  const p: HfPricing = { microHfPerUnit: { "7": 1n, "8": 4n } };
  // 1200 input tokens at 1 micro-HF + 300 output tokens at 4 = 2400 micro-HF.
  assert.equal(hfCostMicro({ "7": "1200", "8": "300", "0": "99" }, p), 2400n);
});

test("microToHf formats micro-HF as a trimmed decimal string", () => {
  assert.equal(microToHf(0n), "0");
  assert.equal(microToHf(1_000_000n), "1");
  assert.equal(microToHf(1_500_000n), "1.5");
  assert.equal(microToHf(8_760_000n), "8.76");
  assert.equal(microToHf(1n), "0.000001");
});

test("funding helpers summarize parked allocations in micro-HF", () => {
  const allocs = ["50", "1", "1", "1"];
  assert.equal(fundingTotalMicro(allocs), 53_000_000n);
  assert.equal(fundingLargestMicro(allocs), 50_000_000n);
  assert.equal(fundingTotalMicro([]), 0n);
  assert.equal(fundingLargestMicro([]), 0n);
  // fractional allocations
  assert.equal(fundingTotalMicro(["0.5", "0.25"]), 750_000n);
  assert.equal(fundingLargestMicro(["0.5", "0.25"]), 500_000n);
});

test("hfToMicro parses decimal HF strings", () => {
  assert.equal(hfToMicro("5"), 5_000_000n);
  assert.equal(hfToMicro("0.0001"), 100n);
  assert.equal(hfToMicro("0"), 0n);
});

test("latestLockedHf reads the newest RAVE's locked HF, or 0", () => {
  assert.equal(latestLockedHf([], "0"), "0");
  const raves = [
    { executed_timestamp: 100, output: { locked: { "0": "2.5" } } },
    { executed_timestamp: 300, output: { locked: { "0": "1.25" } } },
    { executed_timestamp: 200, output: {} },
  ];
  assert.equal(latestLockedHf(raves, "0"), "1.25");
  // newest run held nothing
  assert.equal(
    latestLockedHf([{ executed_timestamp: 400, output: {} }, ...raves], "0"),
    "0",
  );
});
