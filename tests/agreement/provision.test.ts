import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parsePrices,
  provisionAgreement,
  reusableParts,
  rotationPlan,
} from "../../src/agreement/provision.js";

const EA = "uhCkkAgreement";

test("without --from both parts are published", () => {
  assert.deepEqual(
    rotationPlan({
      newTemplate: false,
      newPriceSheet: false,
      ratesGiven: true,
    }),
    { publishTemplate: true, publishPriceSheet: true },
  );
});

test("--new-* flags need --from", () => {
  assert.throws(
    () =>
      rotationPlan({
        newTemplate: true,
        newPriceSheet: false,
        ratesGiven: false,
      }),
    /need --from/,
  );
});

test("with --from each part is reused unless republished", () => {
  const plan = (newTemplate: boolean, newPriceSheet: boolean) =>
    rotationPlan({ from: EA, newTemplate, newPriceSheet, ratesGiven: false });
  assert.deepEqual(plan(false, false), {
    publishTemplate: false,
    publishPriceSheet: false,
  });
  assert.deepEqual(plan(true, false), {
    publishTemplate: true,
    publishPriceSheet: false,
  });
  assert.deepEqual(plan(false, true), {
    publishTemplate: false,
    publishPriceSheet: true,
  });
  assert.deepEqual(plan(true, true), {
    publishTemplate: true,
    publishPriceSheet: true,
  });
});

test("rates with a reused price sheet are an error", () => {
  assert.throws(
    () =>
      rotationPlan({
        from: EA,
        newTemplate: true,
        newPriceSheet: false,
        ratesGiven: true,
      }),
    /--new-price-sheet/,
  );
  assert.doesNotThrow(() =>
    rotationPlan({
      from: EA,
      newTemplate: false,
      newPriceSheet: true,
      ratesGiven: true,
    }),
  );
});

test("reusable parts come from the agreement's template id and pinned sheet", () => {
  assert.deepEqual(
    reusableParts({
      code_template_id: "uhCkkTemplate",
      input_rules: [
        { name: "hf_index", instruction: { Fixed: "0" } },
        {
          name: "price_sheet_data_blob_hash",
          instruction: { Fixed: "uhCkkSheet" },
        },
      ],
    }),
    { templateHash: "uhCkkTemplate", priceSheetHash: "uhCkkSheet" },
  );
  assert.throws(
    () => reusableParts({ code_template_id: "uhCkkTemplate", input_rules: [] }),
    /price_sheet_data_blob_hash/,
  );
});

test("parsePrices reads SYMBOL=rate flags", () => {
  assert.deepEqual(parsePrices(["TOKIN=0.000001", "TOKOUT=0.000004"]), {
    hfPerUnit: { TOKIN: "0.000001", TOKOUT: "0.000004" },
  });
  assert.throws(() => parsePrices(["TOKIN"]), /SYMBOL=rate/);
});

test("provisionAgreement publishes the sheet and template, then the agreement", async () => {
  const HARVESTER = "uhCAkwVCV9IeFnzNfa73VbXL246eBcVqxpl3_RZnU0xnpvX5MXnpE";
  const TEMPLATE = "uhCkkHTUxEFOIJNdfvB8WlBdYS3cu_HaC7FAtY8uJeISKyW2fmKP0";
  const calls: Array<[string, any]> = [];
  const call = async (fn: string, payload: any): Promise<any> => {
    calls.push([fn, payload]);
    switch (fn) {
      case "get_global_units_details":
        return [
          { unit_symbol: "HF", index: 0 },
          { unit_symbol: "TOKIN", index: 7 },
          { unit_symbol: "TOKOUT", index: 8 },
        ];
      case "create_data_blob":
        return "uhCkkSheet";
      case "create_code_template":
        return TEMPLATE;
      case "create_smart_agreement":
        return "uhCkkAgreement";
    }
    throw new Error(`unexpected ${fn}`);
  };
  const r = await provisionAgreement(call, {
    harvesterPubKey: HARVESTER,
    prices: { hfPerUnit: { TOKIN: "0.000001", TOKOUT: "0.000004" } },
  });
  assert.equal(r.agreementId, "uhCkkAgreement");
  assert.deepEqual(
    calls.map(([fn]) => fn),
    [
      "get_global_units_details",
      "create_data_blob",
      "create_code_template",
      "create_smart_agreement",
    ],
  );
  const agreement = calls[3][1];
  const rules = Object.fromEntries(
    agreement.input_rules.map((r: any) => [r.name, r.instruction]),
  );
  assert.deepEqual(rules.hf_index, { Fixed: "0" });
  assert.deepEqual(rules.price_sheet_data_blob_hash, { Fixed: "uhCkkSheet" });
  assert.deepEqual(agreement.executor_rules, { AuthorizedExecutor: HARVESTER });
});
