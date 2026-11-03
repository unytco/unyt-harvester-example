import { test } from "node:test";
import assert from "node:assert/strict";
import { unlockAgreement, UnlockSession } from "../../src/billing/unlock.js";
import { AgreementBalances } from "../../src/holochain/hc-client.js";

const EA = "uhCkkAgreement";
const RAVE = "uhCkkRave";

function fakeSession(
  before: AgreementBalances,
  after: AgreementBalances = before,
) {
  const calls: string[] = [];
  let reads = 0;
  const session: UnlockSession = {
    balances: async () => (reads++ === 0 ? before : after),
    execute: async (_ea, lanes, inputs) => {
      calls.push(`execute ${lanes?.join(",")} ${JSON.stringify(inputs)}`);
      return { allocations: 1, raveHash: RAVE };
    },
    acceptRave: async (hash, note) => {
      calls.push(`accept ${hash} ${note}`);
      return "uhCkkReceipt";
    },
  };
  return { session, calls };
}

const held: AgreementBalances = {
  hfIndex: "0",
  parkedHf: ["2"],
  lockedHf: "3",
  balanceHf: "10",
  parkedInvoices: 0,
};

test("executes with unlock, accepts the RAVE, reports the gain", async () => {
  const { session, calls } = fakeSession(held, { ...held, balanceHf: "15" });
  const log: string[] = [];
  const r = await unlockAgreement(session, {
    agreementId: EA,
    laneDefinitionIds: ["uhCkkLane"],
    log: (m) => log.push(m),
  });
  assert.deepEqual(calls, [
    'execute uhCkkLane {"unlock":true}',
    "accept uhCkkRave unlock before rotation",
  ]);
  assert.equal(r.heldHf, "5");
  assert.equal(r.unlockedHf, "5");
  assert.equal(r.raveHash, RAVE);
  assert.equal(r.receiptHash, "uhCkkReceipt");
  assert.equal(r.balanceHfAfter, "15");
  assert.match(log[0], /holds 5 HF \(locked 3, parked 2\)/);
});

test("does nothing when the agreement holds no HF", async () => {
  const { session, calls } = fakeSession({
    ...held,
    parkedHf: [],
    lockedHf: "0",
  });
  const r = await unlockAgreement(session, {
    agreementId: EA,
    laneDefinitionIds: [],
  });
  assert.deepEqual(calls, []);
  assert.equal(r.unlockedHf, "0");
  assert.equal(r.balanceHfAfter, "10");
});

test("a dry run reports the held HF without executing", async () => {
  const { session, calls } = fakeSession(held);
  const r = await unlockAgreement(session, {
    agreementId: EA,
    laneDefinitionIds: [],
    dryRun: true,
  });
  assert.deepEqual(calls, []);
  assert.equal(r.heldHf, "5");
  assert.equal(r.unlockedHf, "0");
});

test("refuses while invoices are parked unless forced", async () => {
  const pending = { ...held, parkedInvoices: 2 };
  const { session, calls } = fakeSession(pending);
  await assert.rejects(
    unlockAgreement(session, { agreementId: EA, laneDefinitionIds: [] }),
    /2 invoice\(s\) are still parked/,
  );
  assert.deepEqual(calls, []);
  const forced = fakeSession(pending);
  await unlockAgreement(forced.session, {
    agreementId: EA,
    laneDefinitionIds: [],
    force: true,
  });
  assert.equal(forced.calls.length, 2);
});

test("fails when the execution returns no RAVE hash", async () => {
  const { session } = fakeSession(held);
  session.execute = async () => ({ allocations: 0 });
  await assert.rejects(
    unlockAgreement(session, { agreementId: EA, laneDefinitionIds: [] }),
    /no RAVE hash/,
  );
});

test("an agreement without hf_index is an error", async () => {
  const { session } = fakeSession({ ...held, hfIndex: undefined });
  await assert.rejects(
    unlockAgreement(session, { agreementId: EA, laneDefinitionIds: [] }),
    /pins no hf_index/,
  );
});
