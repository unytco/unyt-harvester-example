import { test } from "node:test";
import assert from "node:assert/strict";
import { parseTokenLine } from "../../../src/sources/tokens/log.js";
import { ALICE, line } from "./fixture.js";

test("parseTokenLine reads OpenAI usage", () => {
  const r = parseTokenLine(line("r1", 1000, ALICE, 12, 34).trim());
  assert.deepEqual(r, {
    id: "r1",
    ts: 1000,
    operator: ALICE,
    model: "sample-model",
    promptTokens: 12,
    completionTokens: 34,
  });
});

test("parseTokenLine rejects a negative token count", () => {
  const r = parseTokenLine(line("r1", 1000, ALICE, -1, 34).trim());
  assert.ok(r instanceof Error);
  assert.match(r.message, /prompt_tokens/);
});

test("parseTokenLine rejects a line that is not JSON", () => {
  assert.ok(parseTokenLine("{oops") instanceof Error);
});
