import { test } from "node:test";
import assert from "node:assert/strict";
import {
  hcOpenSessionWithRetry,
  SessionDeps,
} from "../../src/holochain/hc-client.js";

const config = {
  credsPath: "/tmp/x",
  hcAdminPort: 1,
  hcAppPort: 2,
  hcAppId: "unyt",
};
const fresh = {
  hcCreds: { cap: "n", pub: "n", sec: "n" },
  hcToken: "t2",
} as any;
const session = { agent: "a" } as any;

test("uses stored creds when they work", async () => {
  let inits = 0;
  const deps: SessionDeps = {
    readCreds: async () => ({ hcCreds: fresh.hcCreds, hcToken: "t1" }),
    writeCreds: async () => {},
    init: async () => {
      inits++;
      return fresh;
    },
    open: async () => session,
  };
  assert.equal(await hcOpenSessionWithRetry(config, deps), session);
  assert.equal(inits, 0);
});

test("re-inits once when stored creds fail or are missing", async () => {
  const written: string[] = [];
  const tokens: string[] = [];
  const deps: SessionDeps = {
    readCreds: async () => {
      throw new Error("ENOENT");
    },
    writeCreds: async (_p: string, d: any) => {
      written.push(d.hcToken);
    },
    init: async () => fresh,
    open: async (_port: number, _c: any, token: string) => {
      tokens.push(token);
      if (token !== "t2") throw new Error("unauthorized");
      return session;
    },
  };
  assert.equal(await hcOpenSessionWithRetry(config, deps), session);
  assert.deepEqual(written, ["t2"]);
  assert.deepEqual(tokens, ["t2"]);
});

test("surfaces the error when init itself fails", async () => {
  const deps: SessionDeps = {
    readCreds: async () => ({ hcCreds: fresh.hcCreds, hcToken: "stale" }),
    writeCreds: async () => {},
    init: async () => {
      throw new Error("admin port closed");
    },
    open: async () => {
      throw new Error("unauthorized");
    },
  };
  await assert.rejects(
    hcOpenSessionWithRetry(config, deps),
    /admin port closed/,
  );
});

test("agentExists asks check_agent_exists with the raw key bytes", async () => {
  const { makeSession, fromB64 } =
    await import("../../src/holochain/hc-client.js");
  const AGENT = "uhCAkEgwsRQmYpVUGWSdNyziQgQZu1sfXVlVIR0sbEZJBd5N6wYr_";
  const calls: Array<[string, unknown]> = [];
  let answer: unknown = true;
  const s = makeSession({
    call: async (fn, payload) => {
      calls.push([fn, payload]);
      return answer;
    },
    executor: new Uint8Array(39),
    close: async () => {},
  });
  assert.equal(await s.agentExists(AGENT), true);
  assert.equal(calls[0][0], "check_agent_exists");
  assert.deepEqual(calls[0][1], fromB64(AGENT.substring(1)));
  assert.equal((calls[0][1] as Uint8Array).length, 39);

  answer = false;
  assert.equal(await s.agentExists(AGENT), false);

  answer = "yes";
  await assert.rejects(s.agentExists(AGENT), /check_agent_exists/);
});

test("resolveLanes cites the version in force over the session's cell", async () => {
  const { makeSession } = await import("../../src/holochain/hc-client.js");
  const { FIRST, SECOND, NOW, fakeLaneCalls, windTunnelFixture } =
    await import("./lane-fixture.js");
  const lines: string[] = [];
  const s = makeSession({
    call: fakeLaneCalls(windTunnelFixture()),
    executor: new Uint8Array(39),
    close: async () => {},
    now: () => NOW,
  });
  assert.deepEqual(await s.resolveLanes([SECOND], (m) => lines.push(m)), [
    FIRST,
  ]);
  assert.equal(lines.length, 1);
});

test("the session names its agent in Holochain's base64 form", async () => {
  const { makeSession } = await import("../../src/holochain/hc-client.js");
  const { decodeHashFromBase64 } = await import("@holochain/client");
  const AGENT = "uhCAkPXBHhz7XY3hFJJUoqxC73V5xQs_WX5FWfC7MidwR1-ijNXVL";
  const s = makeSession({
    call: async () => true,
    executor: decodeHashFromBase64(AGENT),
    close: async () => {},
  });
  assert.equal(s.agent, AGENT);
});

test("balances reads the HF fee terms and precision, and tolerates their absence", async () => {
  const { makeSession } = await import("../../src/holochain/hc-client.js");
  const { decodeHashFromBase64 } = await import("@holochain/client");
  const AGENT = "uhCAkPXBHhz7XY3hFJJUoqxC73V5xQs_WX5FWfC7MidwR1-ijNXVL";
  const OTHER = "uhCAkEgwsRQmYpVUGWSdNyziQgQZu1sfXVlVIR0sbEZJBd5N6wYr_";
  const base: Record<string, unknown> = {
    get_smart_agreement: {
      input_rules: [{ name: "hf_index", instruction: { Fixed: 0 } }],
    },
    get_parked_links_by_ea: [],
    get_raves_for_smart_agreement: [],
    get_ledger: { balance: { "0": "9865" } },
    get_global_units_details: [
      {
        index: 0,
        unit_symbol: "HF",
        unit_type: { MonetaryUnit: { precision: 2, is_external: false } },
      },
    ],
    get_current_global_definition: {
      id: "uhCkk",
      system_rave_agreements: {
        compute_transaction_fee: {
          unit_fees: [
            {
              unit_index: 0,
              spender_pay_percent: { numerator: 1, denominator: 100 },
              fee_cap: "50",
              exempt_agents: [OTHER],
            },
          ],
        },
      },
    },
  };
  const session = (answers: Record<string, unknown>) =>
    makeSession({
      call: async (fn) => {
        if (!(fn in answers)) throw new Error(`no answer for ${fn}`);
        const a = answers[fn];
        if (a instanceof Error) throw a;
        return a;
      },
      executor: decodeHashFromBase64(AGENT),
      close: async () => {},
    });

  const b = await session(base).balances("uhCkkea");
  assert.equal(b.balanceHf, "9865");
  assert.deepEqual(b.hfFee, {
    numerator: 1n,
    denominator: 100n,
    capMicro: 50_000_000n,
    exempt: false,
  });
  assert.equal(b.hfPrecision, 2);

  const exempt = structuredClone(base) as any;
  exempt.get_current_global_definition.system_rave_agreements.compute_transaction_fee.unit_fees[0].exempt_agents =
    [AGENT];
  assert.equal((await session(exempt).balances("uhCkkea")).hfFee?.exempt, true);

  const noFee = structuredClone(base) as any;
  noFee.get_current_global_definition.system_rave_agreements.compute_transaction_fee.unit_fees =
    [];
  assert.equal((await session(noFee).balances("uhCkkea")).hfFee?.numerator, 0n);

  const broken = {
    ...base,
    get_current_global_definition: new Error("boom"),
    get_global_units_details: new Error("boom"),
  };
  const b2 = await session(broken).balances("uhCkkea");
  assert.equal(b2.balanceHf, "9865");
  assert.equal(b2.hfFee, undefined);
  assert.equal(b2.hfPrecision, undefined);
});

test("execute passes the executor inputs and returns the RAVE hash", async () => {
  const { makeSession } = await import("../../src/holochain/hc-client.js");
  const { decodeHashFromBase64 } = await import("@holochain/client");
  const RAVE = "uhCkkPXBHhz7XY3hFJJUoqxC73V5xQs_WX5FWfC7MidwR1-ijNXVL";
  const GLOBAL = "uhCkkEgwsRQmYpVUGWSdNyziQgQZu1sfXVlVIR0sbEZJBd5N6wYr_";
  const calls: Array<[string, any]> = [];
  const s = makeSession({
    call: async (fn, payload) => {
      calls.push([fn, payload]);
      if (fn === "get_current_global_definition") return { id: GLOBAL };
      if (fn === "execute_rave") {
        return [
          { output: { unyt_allocation: [{}] } },
          decodeHashFromBase64(RAVE),
        ];
      }
      if (fn === "create_receipt_from_rave") return "uhCkkReceipt";
      return null;
    },
    executor: new Uint8Array(39),
    close: async () => {},
  });
  const r = await s.execute(GLOBAL, [], { unlock: true });
  assert.deepEqual(r, { allocations: 1, raveHash: RAVE });
  const execute = calls.find(([fn]) => fn === "execute_rave")!;
  assert.deepEqual(execute[1].executor_inputs, { unlock: true });

  assert.equal(await s.acceptRave(RAVE, "note"), "uhCkkReceipt");
  const receipt = calls.find(([fn]) => fn === "create_receipt_from_rave")!;
  assert.deepEqual(receipt[1], { hash: RAVE, note: "note" });
});

test("balances counts the parked invoices still waiting for an execution", async () => {
  const { makeSession } = await import("../../src/holochain/hc-client.js");
  const s = makeSession({
    call: async (fn) => {
      if (fn === "get_smart_agreement") {
        return {
          input_rules: [{ name: "hf_index", instruction: { Fixed: "0" } }],
        };
      }
      if (fn === "get_parked_links_by_ea") {
        return [
          {
            amount: { "0": "5" },
            details: { ParkedSpend: { ct_role_id: "funder" } },
          },
          {
            amount: { "5": "60" },
            details: { ParkedSpend: { ct_role_id: "invoicer" } },
          },
          {
            amount: { "6": "60" },
            details: { ParkedSpend: { ct_role_id: "invoicer" } },
          },
        ];
      }
      if (fn === "get_raves_for_smart_agreement") return [];
      if (fn === "get_ledger") return { balance: { "0": "1" } };
      throw new Error(`unexpected ${fn}`);
    },
    executor: new Uint8Array(39),
    close: async () => {},
  });
  const b = await s.balances(
    "uhCkkEgwsRQmYpVUGWSdNyziQgQZu1sfXVlVIR0sbEZJBd5N6wYr_",
  );
  assert.deepEqual(b.parkedHf, ["5"]);
  assert.equal(b.parkedInvoices, 2);
});
