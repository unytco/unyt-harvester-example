import { test } from "node:test";
import assert from "node:assert/strict";
import { decode as msgpackDecode } from "@msgpack/msgpack";
import {
  AGREEMENT_TITLE,
  FUNDER_ROLE,
  INVOICER_ROLE,
  codeTemplatePayload,
  priceSheetBytes,
  priceSheetPayload,
  runtimeInputNames,
  smartAgreementPayload,
} from "../../src/agreement/definition.js";
import { executionCodeRhai } from "../../src/agreement/template.generated.js";

const HARVESTER = "uhCAkwVCV9IeFnzNfa73VbXL246eBcVqxpl3_RZnU0xnpvX5MXnpE";

function agreement() {
  return smartAgreementPayload({
    codeTemplateId: "uhCkkCodeTemplate",
    priceSheetHash: "uhCkkPriceSheet",
    hfIndex: 0,
    harvesterPubKey: HARVESTER,
  });
}

const UNITS = new Map([
  ["TOKIN", 7],
  ["TOKOUT", 8],
]);

test("the price sheet is msgpack of micro-HF per unit index", () => {
  const bytes = priceSheetBytes(
    { hfPerUnit: { TOKIN: "0.000001", TOKOUT: "0.000004" } },
    UNITS,
  );
  assert.deepEqual(msgpackDecode(Uint8Array.from(bytes)), {
    micro_hf_per_unit: { "7": "1", "8": "4" },
  });
  assert.equal(
    priceSheetPayload({ hfPerUnit: { TOKIN: "1" } }, UNITS).permissions,
    "Default",
  );
});

test("priceSheetBytes rejects a rate finer than one micro-HF", () => {
  assert.throws(
    () => priceSheetBytes({ hfPerUnit: { TOKIN: "0.0000001" } }, UNITS),
    /6 decimal places/,
  );
});

test("priceSheetBytes rejects an unknown unit symbol", () => {
  assert.throws(
    () => priceSheetBytes({ hfPerUnit: { TOKX: "1" } }, UNITS),
    /unknown unit symbol TOKX/,
  );
});

test("the Rhai template mentions no Wind Tunnel role or unit", () => {
  assert.doesNotMatch(
    executionCodeRhai,
    /wt_ops|WTUP|WTRUN|wtup|wtrun|Wind Tunnel/,
  );
});

test("the code template carries the embedded rhai as msgpack", () => {
  const payload = codeTemplatePayload();
  assert.equal(payload.title, AGREEMENT_TITLE);
  assert.equal(payload.execution_engine, "Rhai");
  assert.equal(
    msgpackDecode(Uint8Array.from(payload.execution_code)),
    executionCodeRhai,
  );
  assert.equal(payload.aggregate_execution, true);
});

test("every runtime input has exactly one input rule", () => {
  const ruleNames = agreement().input_rules.map((r) => r.name);
  assert.deepEqual([...ruleNames].sort(), [...runtimeInputNames()].sort());
  assert.equal(new Set(ruleNames).size, ruleNames.length);
});

test("the rhai reads every consumed input and fixed input by its rule name", () => {
  for (const name of runtimeInputNames()) {
    assert.ok(executionCodeRhai.includes(name), `rhai never reads ${name}`);
  }
});

test("one harvester agent holds both roles and is the executor", () => {
  const a = agreement();
  assert.deepEqual(
    a.roles.map((r) => r.ct_role_id),
    [INVOICER_ROLE, FUNDER_ROLE],
  );
  for (const r of a.roles) {
    assert.deepEqual(r.qualification, { Authorized: [HARVESTER] });
    assert.doesNotMatch(r.display_name, /treasury|wind tunnel/i);
  }
  assert.deepEqual(a.executor_rules, { AuthorizedExecutor: HARVESTER });
  const byName = Object.fromEntries(
    a.input_rules.map((r) => [r.name, r.instruction]),
  );
  assert.deepEqual(byName.harvester_pub_key, { Fixed: HARVESTER });
  assert.deepEqual(byName.invoice_payloads, { ProvidedBy: INVOICER_ROLE });
  assert.deepEqual(byName.funder_allocations, {
    ProvidedBy: FUNDER_ROLE,
  });
  assert.deepEqual(byName.hf_index, { Fixed: "0" });
  assert.deepEqual(byName.unlock, "ExecutorProvided");
});

test("a tag becomes a Public tag; none means no tags", () => {
  assert.deepEqual(agreement().tags, []);
  assert.deepEqual(
    smartAgreementPayload({
      codeTemplateId: [1, 2, 3],
      priceSheetHash: "uhCkkP",
      hfIndex: 0,
      harvesterPubKey: HARVESTER,
      tag: "llm-tokens",
    }).tags,
    [{ Public: "llm-tokens" }],
  );
});
