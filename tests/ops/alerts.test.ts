import { test } from "node:test";
import assert from "node:assert/strict";
import {
  alertAndContinue,
  alertOnFailure,
  lowBalanceAlert,
} from "../../src/ops/alerts.js";

test("alertOnFailure logs the failure and rethrows", async () => {
  const lines: string[] = [];
  await assert.rejects(
    alertOnFailure(
      "invoice",
      "uhCkkA",
      async () => {
        throw new Error("boom");
      },
      (m) => lines.push(m),
    ),
    /boom/,
  );
  assert.equal(lines.length, 1);
  assert.match(lines[0], /ALERT .*invoice.*uhCkkA.*boom/);
});

test("alertAndContinue logs the failure and returns undefined", async () => {
  const lines: string[] = [];
  const r = await alertAndContinue(
    "fund",
    "uhCkkA",
    async () => {
      throw new Error("no hf");
    },
    (m) => lines.push(m),
  );
  assert.equal(r, undefined);
  assert.match(lines.join("\n"), /fund FAILED: no hf/);
});

test("lowBalanceAlert names the agent and both amounts", () => {
  const a = lowBalanceAlert("uhCAkX", "1.5", "10");
  assert.match(a.subject, /low HF balance/);
  assert.match(a.body, /uhCAkX.*1\.5.*10/s);
});
