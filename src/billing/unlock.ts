import { hfToMicro, microToHf } from "./funding.js";
import { availableMicro } from "./fund.js";
import { AgreementBalances, ExecuteResult } from "../holochain/hc-client.js";

export interface UnlockSession {
  balances(agreementId: string): Promise<AgreementBalances>;
  execute(
    agreementId: string,
    laneDefinitionIds?: string[],
    executorInputs?: Record<string, unknown>,
  ): Promise<ExecuteResult>;
  acceptRave(raveHash: string, note?: string): Promise<string>;
}

export interface UnlockOptions {
  agreementId: string;
  laneDefinitionIds: string[];
  /** Report what would be reclaimed without executing. */
  dryRun?: boolean;
  /** Reclaim even when invoices are still parked on the agreement. */
  force?: boolean;
  log?: (m: string) => void;
}

export interface UnlockResult {
  /** HF the agreement held before the reclaim: parked plus locked. */
  heldHf: string;
  /** HF returned to the agent; "0" when nothing was held or on a dry run. */
  unlockedHf: string;
  raveHash?: string;
  receiptHash?: string;
  balanceHfAfter: string;
}

/**
 * Return every HF the agreement holds to the harvester agent: execute once with
 * the `unlock` executor input, which allocates the carried lock and any
 * parked funding back to `harvester_pub_key`, then accept that allocation so it
 * lands on the ledger. Run before rotating to a new agreement, after the last
 * invoice run settled, so no invoice is left parked on an agreement nobody
 * executes again.
 */
export async function unlockAgreement(
  session: UnlockSession,
  opts: UnlockOptions,
): Promise<UnlockResult> {
  const log = opts.log ?? (() => {});
  const before = await session.balances(opts.agreementId);
  if (before.hfIndex === undefined) {
    throw new Error(`agreement ${opts.agreementId} pins no hf_index`);
  }
  const held = availableMicro(before);
  const heldHf = microToHf(held);
  const result: UnlockResult = {
    heldHf,
    unlockedHf: "0",
    balanceHfAfter: before.balanceHf,
  };
  if (held === 0n) {
    log(`unlock: agreement ${opts.agreementId} holds no HF, nothing to do`);
    return result;
  }
  const parkedInvoices = before.parkedInvoices ?? 0;
  if (parkedInvoices > 0 && !opts.force) {
    throw new Error(
      `${parkedInvoices} invoice(s) are still parked on ${opts.agreementId}; ` +
        `run invoice first so they settle, or pass --force to leave them unpaid`,
    );
  }
  log(
    `unlock: agreement holds ${heldHf} HF ` +
      `(locked ${before.lockedHf}, parked ${before.parkedHf.join("+") || "0"})` +
      (parkedInvoices > 0 ? `; ${parkedInvoices} invoice(s) left parked` : ""),
  );
  if (opts.dryRun) {
    log("unlock: dry run, not executing");
    return result;
  }

  const executed = await session.execute(
    opts.agreementId,
    opts.laneDefinitionIds,
    { unlock: true },
  );
  if (!executed.raveHash) {
    throw new Error("execute_rave returned no RAVE hash; nothing accepted");
  }
  log(`unlock: executed, RAVE ${executed.raveHash}`);
  const receiptHash = await session.acceptRave(
    executed.raveHash,
    "unlock before rotation",
  );
  log(`unlock: accepted, receipt ${receiptHash}`);

  const after = await session.balances(opts.agreementId);
  const gained = hfToMicro(after.balanceHf) - hfToMicro(before.balanceHf);
  return {
    ...result,
    unlockedHf: microToHf(gained > 0n ? gained : held),
    raveHash: executed.raveHash,
    receiptHash,
    balanceHfAfter: after.balanceHf,
  };
}
