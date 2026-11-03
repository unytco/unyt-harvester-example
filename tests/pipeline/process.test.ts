import { test } from "node:test";
import assert from "node:assert/strict";
import { appendFileSync } from "node:fs";
import { SqliteStore } from "../../src/store/sqlite-store.js";
import { processWindows } from "../../src/pipeline/process.js";
import { tokenSource } from "../../src/sources/tokens/source.js";
import {
  ALICE,
  BOB,
  MINUTE,
  line,
  tempLog,
} from "../sources/tokens/fixture.js";

const opts = { windowMs: MINUTE, now: () => 10 * MINUTE };

function setup() {
  const logPath = tempLog();
  const store = new SqliteStore(":memory:");
  const source = tokenSource({ dbPath: ":memory:", logPath });
  return { logPath, store, source };
}

async function billed(store: SqliteStore, metricKey: string): Promise<bigint> {
  const pending = await store.pendingMetrics(10_000);
  const invoiced = await store.recentlyInvoiced({ limit: 10_000 });
  return [...pending, ...invoiced]
    .filter((m) => m.metricKey === metricKey)
    .reduce((n, m) => n + BigInt(m.value), 0n);
}

test("processWindows queues each operator's tokens per window", async () => {
  const { logPath, store, source } = setup();
  appendFileSync(logPath, line("a1", 10, ALICE, 100, 10));
  appendFileSync(logPath, line("b1", MINUTE + 1, BOB, 5, 6));
  await processWindows(store, source, opts);
  const rows = (await store.pendingMetrics()).map((m) => [
    m.unytPubKey,
    m.metricKey,
    m.windowStart,
    m.value,
  ]);
  assert.deepEqual(
    rows.sort(),
    [
      [ALICE, "inputTokens", 0, "100"],
      [ALICE, "outputTokens", 0, "10"],
      [BOB, "inputTokens", MINUTE, "5"],
      [BOB, "outputTokens", MINUTE, "6"],
    ].sort(),
  );
});

test("processWindows skips a malformed operator key", async () => {
  const { logPath, store, source } = setup();
  appendFileSync(logPath, line("x1", 10, "not-a-key", 100, 10));
  const logs: string[] = [];
  await processWindows(store, source, { ...opts, log: (m) => logs.push(m) });
  assert.equal((await store.pendingMetrics()).length, 0);
  assert.match(logs.join("\n"), /malformed/);
});

test("processWindows skips a foreign key", async () => {
  const { logPath, store, source } = setup();
  appendFileSync(logPath, line("a1", 10, ALICE, 100, 10));
  appendFileSync(logPath, line("b1", 10, BOB, 100, 10));
  const logs: string[] = [];
  await processWindows(store, source, {
    ...opts,
    agentExists: async (key) => key === ALICE,
    log: (m) => logs.push(m),
  });
  const keys = new Set((await store.pendingMetrics()).map((m) => m.unytPubKey));
  assert.deepEqual([...keys], [ALICE]);
  assert.match(logs.join("\n"), /not on this network/);
});

test("a late line for a pending window updates that window", async () => {
  const { logPath, store, source } = setup();
  appendFileSync(logPath, line("a1", 10, ALICE, 100, 10));
  await processWindows(store, source, opts);
  appendFileSync(logPath, line("a2", 20, ALICE, 50, 5));
  await processWindows(store, source, opts);
  const input = (await store.pendingMetrics()).filter(
    (m) => m.metricKey === "inputTokens",
  );
  assert.deepEqual(
    input.map((m) => [m.windowStart, m.value]),
    [[0, "150"]],
  );
});

test("a late line for an invoiced window is billed once, later", async () => {
  const { logPath, store, source } = setup();
  appendFileSync(logPath, line("a1", 10, ALICE, 100, 10));
  await processWindows(store, source, opts);
  const first = await store.pendingMetrics();
  await store.markInvoiced(
    first.map((m) => m.id as number),
    11 * MINUTE,
  );

  appendFileSync(logPath, line("a2", 20, ALICE, 50, 5));
  await processWindows(store, source, opts);
  const late = (await store.pendingMetrics()).filter(
    (m) => m.metricKey === "inputTokens",
  );
  assert.deepEqual(
    late.map((m) => m.value),
    ["50"],
  );

  await processWindows(store, source, opts);
  await processWindows(store, source, opts);
  assert.equal(await billed(store, "inputTokens"), 150n);
  assert.equal(await billed(store, "outputTokens"), 15n);
});

test("windows skipped while a key was not on the network are measured once it is", async () => {
  const { logPath, store, source } = setup();
  appendFileSync(logPath, line("b1", 10, BOB, 100, 10));
  // Bob's agent entry has not reached this conductor yet.
  await processWindows(store, source, {
    ...opts,
    agentExists: async (key) => key !== BOB,
  });
  assert.equal((await store.pendingMetrics()).length, 0);

  // Two windows later it has.
  await processWindows(store, source, {
    ...opts,
    now: () => 12 * MINUTE,
    agentExists: async () => true,
  });
  const bob = (await store.pendingMetrics()).filter(
    (m) => m.unytPubKey === BOB,
  );
  assert.deepEqual(
    bob.map((m) => [m.metricKey, m.windowStart, m.value]).sort(),
    [
      ["inputTokens", 0, "100"],
      ["outputTokens", 0, "10"],
    ],
  );
});
