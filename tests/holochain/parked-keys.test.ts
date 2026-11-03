import { test } from "node:test";
import assert from "node:assert/strict";
import { makeSession } from "../../src/holochain/hc-client.js";

test("parkedInvoiceKeys reads invoice_key from each parked spend's payload", async () => {
  const calls: string[] = [];
  const session = makeSession({
    executor: new Uint8Array(39),
    close: async () => {},
    call: async (fn) => {
      calls.push(fn);
      return [
        {
          details: { ParkedSpend: { attached_payload: { invoice_key: "k1" } } },
        },
        {
          details: { ParkedSpend: { attached_payload: { invoice_key: "k2" } } },
        },
        // A funding spend carries no key.
        { details: { ParkedSpend: { attached_payload: {} } } },
      ];
    },
  });
  const keys = await session.parkedInvoiceKeys(
    "uhCkkAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
  );
  assert.deepEqual([...keys].sort(), ["k1", "k2"]);
  assert.deepEqual(calls, ["get_parked_links_by_ea"]);
});
