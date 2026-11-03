/**
 * Alerts for conditions an operator must act on. This sample only logs them;
 * replace `alert` to send them to your own channel (chat webhook, email, pager).
 */

export interface Alert {
  subject: string;
  body: string;
}

export type Log = (m: string) => void;

const stderr: Log = (m) => console.error(m);

export function alert(a: Alert, log: Log = stderr): void {
  log(`ALERT ${a.subject}: ${a.body}`);
}

export function lowBalanceAlert(
  agent: string,
  balanceHf: string,
  alertHf: string,
): Alert {
  return {
    subject: "harvester low HF balance",
    body:
      `The harvester agent ${agent} holds ${balanceHf} HF, below the alert ` +
      `level of ${alertHf} HF. Send HF to this agent.`,
  };
}

export type FailureStep =
  "connect" | "lanes" | "fund" | "park" | "execute" | "invoice" | "unlock";

export function failureAlert(
  step: FailureStep,
  agreementId: string,
  message: string,
): Alert {
  return {
    subject: `${step} failed`,
    body: `Agreement ${agreementId}: ${step} failed with: ${message}`,
  };
}

/** The message of a thrown value, whatever its type. */
export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Run one step of a job. If it throws, alert and rethrow. */
export async function alertOnFailure<T>(
  step: FailureStep,
  agreementId: string,
  run: () => Promise<T>,
  log: Log = stderr,
): Promise<T> {
  try {
    return await run();
  } catch (err) {
    alert(failureAlert(step, agreementId, errorMessage(err)), log);
    throw err;
  }
}

/**
 * Run one step of a job that must not stop the run. If it throws, log it,
 * alert, and return undefined so the caller carries on.
 */
export async function alertAndContinue<T>(
  step: FailureStep,
  agreementId: string,
  run: () => Promise<T>,
  log: Log = stderr,
): Promise<T | undefined> {
  try {
    return await run();
  } catch (err) {
    log(`${step} FAILED: ${errorMessage(err)}`);
    alert(failureAlert(step, agreementId, errorMessage(err)), log);
    return undefined;
  }
}
