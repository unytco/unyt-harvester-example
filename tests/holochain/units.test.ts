import { test } from "node:test";
import assert from "node:assert/strict";
import { hcUnitIndexBySymbol } from "../../src/holochain/hc-client.js";

test("hcUnitIndexBySymbol maps each global unit symbol to its index", async () => {
  const calls: string[] = [];
  const units = await hcUnitIndexBySymbol(async (fn) => {
    calls.push(fn);
    return [
      { unit_symbol: "HF", index: 0 },
      { unit_symbol: "TOKIN", index: 7 },
      { unit_symbol: "TOKOUT", index: 8 },
    ];
  });
  assert.deepEqual(calls, ["get_global_units_details"]);
  assert.deepEqual(
    [...units],
    [
      ["HF", 0],
      ["TOKIN", 7],
      ["TOKOUT", 8],
    ],
  );
});
