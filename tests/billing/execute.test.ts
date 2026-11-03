import { test } from "node:test";
import assert from "node:assert/strict";
import { SqliteStore } from "../../src/store/sqlite-store.js";
import {
  executeBlocker,
  executeIfPending,
  markExecutePending,
} from "../../src/billing/execute.js";

/** An execute that answers with `result` and counts its calls. */
function fakeExecute(result: { allocations: number } | undefined) {
  const execute = async () => {
    execute.calls++;
    return result;
  };
  execute.calls = 0;
  return execute;
}

test("nothing parked and nothing pending: no execute", async () => {
  const store = new SqliteStore(":memory:");
  const execute = fakeExecute({ allocations: 1 });
  assert.equal(await executeIfPending(store, false, execute), "skipped");
  assert.equal(execute.calls, 0);
  await store.close();
});

test("a spend parked this run is executed", async () => {
  const store = new SqliteStore(":memory:");
  const execute = fakeExecute({ allocations: 2 });
  assert.deepEqual(await executeIfPending(store, true, execute), {
    allocations: 2,
  });
  assert.equal(execute.calls, 1);
  // Executed: the next quiet run does nothing.
  assert.equal(await executeIfPending(store, false, execute), "skipped");
  assert.equal(execute.calls, 1);
  await store.close();
});

test("a failed execute is retried by the next run with nothing new parked", async () => {
  const store = new SqliteStore(":memory:");
  assert.equal(
    await executeIfPending(store, true, fakeExecute(undefined)),
    undefined,
  );
  const retry = fakeExecute({ allocations: 1 });
  assert.deepEqual(await executeIfPending(store, false, retry), {
    allocations: 1,
  });
  assert.equal(retry.calls, 1);
  await store.close();
});

test("a spend parked by another command is executed by the next run", async () => {
  const store = new SqliteStore(":memory:");
  await markExecutePending(store);
  const execute = fakeExecute({ allocations: 0 });
  assert.deepEqual(await executeIfPending(store, false, execute), {
    allocations: 0,
  });
  await store.close();
});

test("a crash between park and execute leaves the execute pending", async () => {
  const store = new SqliteStore(":memory:");
  await assert.rejects(
    executeIfPending(store, true, async () => {
      throw new Error("process killed");
    }),
    /process killed/,
  );
  const execute = fakeExecute({ allocations: 1 });
  assert.notEqual(await executeIfPending(store, false, execute), "skipped");
  await store.close();
});

test("executeBlocker holds the execute after a fund failure or an unresolved park", () => {
  assert.equal(executeBlocker({ fundFailed: false, unresolved: 0 }), undefined);
  assert.match(
    executeBlocker({ fundFailed: true, unresolved: 0 })!,
    /fund failure/,
  );
  assert.match(
    executeBlocker({ fundFailed: false, unresolved: 2 })!,
    /2 spend\(s\) may have parked/,
  );
});
