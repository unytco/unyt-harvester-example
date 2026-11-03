import { test } from "node:test";
import assert from "node:assert/strict";
import { decideFunding, ensureFunded } from "../../src/billing/fund.js";
import {
  AgreementBalances,
  ParkedSpend,
} from "../../src/holochain/hc-client.js";

test("decideFunding parks nothing while available >= min", () => {
  assert.equal(
    decideFunding({
      availableMicro: 5n,
      minMicro: 5n,
      topUpMicro: 10n,
      balanceMicro: 100n,
    }).parkMicro,
    0n,
  );
});

test("decideFunding parks the top-up when below min", () => {
  assert.equal(
    decideFunding({
      availableMicro: 4n,
      minMicro: 5n,
      topUpMicro: 10n,
      balanceMicro: 100n,
    }).parkMicro,
    10n,
  );
});

test("decideFunding caps the top-up at what the balance pays with its fee", () => {
  // No fee terms: assume 1%. 3 micro pays 2 micro plus a 1-micro fee.
  assert.equal(
    decideFunding({
      availableMicro: 0n,
      minMicro: 5n,
      topUpMicro: 10n,
      balanceMicro: 3n,
    }).parkMicro,
    2n,
  );
  assert.equal(
    decideFunding({
      availableMicro: 0n,
      minMicro: 5n,
      topUpMicro: 10n,
      balanceMicro: 0n,
    }).parkMicro,
    0n,
  );
});

function fakeSession(b: AgreementBalances) {
  const spends: ParkedSpend[] = [];
  return {
    spends,
    async balances() {
      return b;
    },
    async report(s: ParkedSpend) {
      spends.push(s);
    },
  };
}

test("ensureFunded parks as funder with the HF unit", async () => {
  const s = fakeSession({
    hfIndex: "0",
    parkedHf: ["1"],
    lockedHf: "0.5",
    balanceHf: "20",
  });
  const r = await ensureFunded(s, {
    agreementId: "uhCkkA",
    laneDefinitionIds: ["uhCkkL"],
    minHf: "2",
    topUpHf: "5",
  });
  assert.equal(r.parkedHf, "5");
  assert.equal(r.availableHfBefore, "1.5");
  assert.equal(s.spends.length, 1);
  assert.equal(s.spends[0].ctRoleId, "funder");
  assert.deepEqual(s.spends[0].amount, { "0": "5" });
  assert.deepEqual(s.spends[0].laneDefinitionIds, ["uhCkkL"]);
});

test("ensureFunded does nothing when funded, and errors without hf_index", async () => {
  const s = fakeSession({
    hfIndex: "0",
    parkedHf: ["3"],
    lockedHf: "0",
    balanceHf: "20",
  });
  const r = await ensureFunded(s, {
    agreementId: "u",
    laneDefinitionIds: [],
    minHf: "2",
    topUpHf: "5",
  });
  assert.equal(r.parkedHf, "0");
  assert.equal(s.spends.length, 0);
  const none = fakeSession({ parkedHf: [], lockedHf: "0", balanceHf: "0" });
  await assert.rejects(
    ensureFunded(none, {
      agreementId: "u",
      laneDefinitionIds: [],
      minHf: "2",
      topUpHf: "5",
    }),
    /hf_index/,
  );
});

test("ensureFunded with fixedHf parks exactly that amount as funder", async () => {
  const s = fakeSession({
    hfIndex: "0",
    parkedHf: [],
    lockedHf: "0",
    balanceHf: "3",
  });
  const r = await ensureFunded(s, {
    agreementId: "uhCkkA",
    laneDefinitionIds: ["uhCkkL"],
    fixedHf: "5",
  });
  assert.equal(r.parkedHf, "5");
  assert.equal(s.spends.length, 1);
  assert.equal(s.spends[0].ctRoleId, "funder");
  assert.deepEqual(s.spends[0].amount, { "0": "5" });
  assert.deepEqual(s.spends[0].laneDefinitionIds, ["uhCkkL"]);
});

test("ensureFunded logs the zero balance when below the floor", async () => {
  const s = fakeSession({
    hfIndex: "0",
    parkedHf: ["1"],
    lockedHf: "0",
    balanceHf: "0",
  });
  const lines: string[] = [];
  const r = await ensureFunded(s, {
    agreementId: "u",
    laneDefinitionIds: [],
    minHf: "2",
    topUpHf: "5",
    log: (m) => lines.push(m),
  });
  assert.equal(r.parkedHf, "0");
  assert.equal(s.spends.length, 0);
  assert.equal(lines.length, 1);
  assert.match(
    lines[0],
    /available 1 HF < min 2 but the agent has no spendable HF/,
  );
});

test("ensureFunded parks what the balance pays when it is below the top-up", async () => {
  const s = fakeSession({
    hfIndex: "0",
    parkedHf: [],
    lockedHf: "0",
    balanceHf: "9865",
    hfFee: { numerator: 1n, denominator: 100n },
    hfPrecision: 0,
  });
  const lines: string[] = [];
  const r = await ensureFunded(s, {
    agreementId: "u",
    laneDefinitionIds: [],
    minHf: "40000",
    topUpHf: "120000",
    log: (m) => lines.push(m),
  });
  assert.equal(r.parkedHf, "9767");
  assert.equal(r.balanceHfAfter, "98");
  assert.equal(s.spends.length, 1);
  assert.equal(s.spends[0].amount["0"], "9767");
  assert.deepEqual(lines, [
    "fund: parked 9767 HF (balance 9865 HF less 1% fee)",
  ]);
});

test("ensureFunded without fee terms keeps 1% back", async () => {
  const s = fakeSession({
    hfIndex: "0",
    parkedHf: [],
    lockedHf: "0",
    balanceHf: "3",
  });
  const lines: string[] = [];
  const r = await ensureFunded(s, {
    agreementId: "u",
    laneDefinitionIds: [],
    minHf: "2",
    topUpHf: "5",
    log: (m) => lines.push(m),
  });
  assert.equal(r.parkedHf, "2.970297");
  assert.equal(r.balanceHfAfter, "0.029703");
  assert.deepEqual(lines, [
    "fund: parked 2.970297 HF (balance 3 HF less 1% fee)",
  ]);
});

test("parkableMicro keeps the fee back, honours the cap, exemption and precision", async () => {
  const { parkableMicro } = await import("../../src/billing/fund.js");
  const HF = 1_000_000n;
  const onePercent = { numerator: 1n, denominator: 100n };
  // 9767 + 97.67 fee fits in 9865; 9768 + 97.68 does not.
  assert.equal(parkableMicro(9865n * HF, onePercent, 0), 9767n * HF);
  // At micro precision the fee rounds up on any remainder.
  assert.equal(parkableMicro(3n * HF, onePercent), 2_970_297n);
  // A capped fee: 9815 + 50 (cap) = 9865.
  assert.equal(
    parkableMicro(9865n * HF, { ...onePercent, capMicro: 50n * HF }, 0),
    9815n * HF,
  );
  // An exempt agent pays no fee.
  assert.equal(
    parkableMicro(9865n * HF, { ...onePercent, exempt: true }, 0),
    9865n * HF,
  );
  // A zero percent charges nothing.
  assert.equal(
    parkableMicro(9865n * HF, { numerator: 0n, denominator: 1n }, 0),
    9865n * HF,
  );
  assert.equal(parkableMicro(0n, onePercent), 0n);
});

test("decideFunding parks the top-up when the balance pays it with its fee", () => {
  const HF = 1_000_000n;
  assert.equal(
    decideFunding({
      availableMicro: 0n,
      minMicro: 40000n * HF,
      topUpMicro: 120000n * HF,
      balanceMicro: 121200n * HF,
      fee: { numerator: 1n, denominator: 100n },
      precision: 0,
    }).parkMicro,
    120000n * HF,
  );
  assert.equal(
    decideFunding({
      availableMicro: 0n,
      minMicro: 40000n * HF,
      topUpMicro: 120000n * HF,
      balanceMicro: 121199n * HF,
      fee: { numerator: 1n, denominator: 100n },
      precision: 0,
    }).parkMicro,
    119999n * HF,
  );
});

test("ensureFunded parks against the agent's HF credit when its balance is 0", async () => {
  const s = fakeSession({
    hfIndex: "0",
    parkedHf: [],
    lockedHf: "0",
    balanceHf: "0",
    creditHf: "1000",
    hfFee: { numerator: 0n, denominator: 100n, exempt: true },
  });
  const r = await ensureFunded(s, {
    agreementId: "uhCkkA",
    laneDefinitionIds: [],
    minHf: "50",
    topUpHf: "100",
  });
  assert.equal(r.parkedHf, "100");
  assert.equal(r.balanceHfAfter, "-100");
  assert.deepEqual(s.spends[0].amount, { "0": "100" });
});

test("spendable HF is the balance plus the credit limit", () => {
  assert.equal(
    decideFunding({
      availableMicro: 0n,
      minMicro: 1n,
      topUpMicro: 5_000_000n,
      balanceMicro: -1_000_000n,
      creditMicro: 3_000_000n,
      fee: { numerator: 0n, denominator: 100n, exempt: true },
    }).parkMicro,
    2_000_000n,
  );
});
