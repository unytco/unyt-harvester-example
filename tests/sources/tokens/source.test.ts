import { test } from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, readFileSync } from "node:fs";
import { tokenSource } from "../../../src/sources/tokens/source.js";
import { generateTokens } from "../../../src/sources/tokens/generate.js";
import { ALICE, BOB, MINUTE, line, tempLog } from "./fixture.js";

test("ingest is idempotent by request id", async () => {
  const logPath = tempLog();
  appendFileSync(logPath, line("r1", 0, ALICE, 1, 1));
  appendFileSync(logPath, line("r2", 1, ALICE, 1, 1));
  appendFileSync(logPath, line("r3", 2, BOB, 1, 1));
  const first = tokenSource({ dbPath: ":memory:", logPath });
  assert.equal((await first.ingest()).inserted, 3);
  assert.equal((await first.ingest()).inserted, 0);
  // A duplicate id appended later is ignored too.
  appendFileSync(logPath, line("r1", 0, ALICE, 1, 1));
  const again = await first.ingest();
  assert.deepEqual([again.inserted, again.ignored], [0, 1]);
});

test("ingest reports the earliest new request time", async () => {
  const logPath = tempLog();
  appendFileSync(logPath, line("r1", 5 * MINUTE, ALICE, 1, 1));
  appendFileSync(logPath, line("r2", 2 * MINUTE, ALICE, 1, 1));
  const source = tokenSource({ dbPath: ":memory:", logPath });
  assert.equal((await source.ingest()).earliest, 2 * MINUTE);
  assert.equal((await source.ingest()).earliest, null);
});

test("measure sums per operator per window", async () => {
  const logPath = tempLog();
  appendFileSync(logPath, line("a1", 10, ALICE, 100, 10));
  appendFileSync(logPath, line("a2", 20, ALICE, 200, 20));
  appendFileSync(logPath, line("b1", 30, BOB, 7, 3));
  appendFileSync(logPath, line("a3", MINUTE + 5, ALICE, 1, 2));
  appendFileSync(logPath, line("b2", MINUTE + 6, BOB, 4, 5));
  const source = tokenSource({ dbPath: ":memory:", logPath });
  await source.ingest();
  const all = [
    ...(await source.measure(0, MINUTE)),
    ...(await source.measure(MINUTE, 2 * MINUTE)),
  ];
  const got = all.map((m) => [
    m.operatorKey,
    m.metricKey,
    m.windowStart,
    m.value,
  ]);
  assert.deepEqual(
    got.sort(),
    [
      [ALICE, "inputTokens", 0, "300"],
      [ALICE, "inputTokens", MINUTE, "1"],
      [ALICE, "outputTokens", 0, "30"],
      [ALICE, "outputTokens", MINUTE, "2"],
      [BOB, "inputTokens", 0, "7"],
      [BOB, "inputTokens", MINUTE, "4"],
      [BOB, "outputTokens", 0, "3"],
      [BOB, "outputTokens", MINUTE, "5"],
    ].sort(),
  );
});

test("generateTokens is deterministic for a seed", () => {
  const a = tempLog();
  const b = tempLog();
  const args = {
    operators: [ALICE, BOB],
    start: 0,
    minutes: 3,
    requestsPerMinute: 5,
    seed: 1,
  };
  generateTokens({ ...args, path: a });
  generateTokens({ ...args, path: b });
  const text = readFileSync(a, "utf8");
  assert.equal(text, readFileSync(b, "utf8"));
  assert.equal(text.trim().split("\n").length, 15);
  generateTokens({ ...args, seed: 2, path: b });
  assert.notEqual(text, readFileSync(b, "utf8").slice(0, text.length));
});
