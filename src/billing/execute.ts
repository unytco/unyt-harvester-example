import { Store } from "../store/store.js";
import { ExecuteResult } from "../holochain/hc-client.js";

/**
 * Whether the agreement holds parked spends that no execute has run over yet.
 * Kept in the store so a failed execute, a crash before it, or a top-up parked
 * by `fund` is executed by the next invoice run, not only when that run parks
 * a new invoice.
 */
const EXECUTE_PENDING = "execute_pending";

/** Record that something was parked and the agreement needs an execute. */
export function markExecutePending(store: Store): Promise<void> {
  return store.setMeta(EXECUTE_PENDING, "1");
}

/**
 * Execute when this run parked something or an earlier execute is still
 * pending. `execute` returns undefined when it failed and was already
 * reported; the execute then stays pending for the next run.
 */
export async function executeIfPending(
  store: Store,
  parkedThisRun: boolean,
  execute: () => Promise<ExecuteResult | undefined>,
): Promise<ExecuteResult | undefined | "skipped"> {
  if (parkedThisRun) {
    await markExecutePending(store);
  }
  if ((await store.getMeta(EXECUTE_PENDING)) !== "1") {
    return "skipped";
  }
  const result = await execute();
  if (result) {
    await store.setMeta(EXECUTE_PENDING, "0");
  }
  return result;
}

/**
 * Why this run must not execute, or undefined if it may. After a failed fund
 * the agreement is short of HF. After a park call that failed, the spend may
 * still have landed; executing would consume it before the next run can see
 * it parked, and that run would park it again.
 */
export function executeBlocker(run: {
  fundFailed: boolean;
  unresolved: number;
}): string | undefined {
  if (run.fundFailed) return "skipped after the fund failure; pending";
  if (run.unresolved > 0) {
    return (
      `skipped: ${run.unresolved} spend(s) may have parked; ` +
      `the next run settles them first`
    );
  }
  return undefined;
}
