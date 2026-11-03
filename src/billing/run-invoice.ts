import { InvoiceClaim, Store } from "../store/store.js";
import { ResolvedPolicy } from "./policy.js";
import { buildInvoicePlans, InvoicePlan, invoiceKey } from "./invoice.js";
import { ParkedSpend } from "../holochain/hc-client.js";

/**
 * Direct-invoice runner: drain pending outbox records into parked spends.
 *
 * Pulls pending records, rolls them into per-(payee, complete-period) plans
 * (one DHT commit each), creates the spend via the injected `Reporter`, and
 * marks the covered records `invoiced`. Before parking, each plan is claimed:
 * its rows, amount and `invoice_key` are stored together, so a later run
 * settles or retries exactly that spend, and new records for the same window
 * become a separate spend. A claim whose key is already parked on the
 * agreement is only marked invoiced.
 */

/** Creates one parked spend. Implemented by the Holochain client (or a fake). */
export interface Reporter {
  report(spend: ParkedSpend): Promise<void>;
  /** `invoice_key`s of the spends parked on the agreement and not yet executed. */
  parkedInvoiceKeys(agreementId: string): Promise<Set<string>>;
}

export interface RunInvoiceOptions {
  policy: ResolvedPolicy;
  /** The single smart agreement these spends are parked on. */
  agreementId: string;
  /** Lane definitions the spends apply under (base64 ActionHashes); default none. */
  laneDefinitionIds?: string[];
  /** Invoice period length (ms). */
  periodMs: number;
  /** Aggregation window length (ms) — to derive how far aggregation has run. */
  windowMs: number;
  /** Build plans and log them, but create no spends and mark nothing. */
  dryRun?: boolean;
  /**
   * Drain / graceful-stop: also invoice the current in-progress period. With a
   * period spanning the run this closes it out as one invoice per payee.
   */
  drain?: boolean;
  /** Max pending records to pull per run. */
  batchSize?: number;
  now?: () => number;
  log?: (msg: string) => void;
}

export interface RunInvoiceResult {
  /** Parked spends created (DHT commits). */
  spends: number;
  /** Outbox records marked invoiced. */
  records: number;
  /** Spends whose park call failed. */
  failed: number;
  /**
   * Claims whose spend may or may not have landed. Executing now could
   * consume such a spend before the next run sees it parked, so the caller
   * must not execute while this is non-zero.
   */
  unresolved: number;
  /** The plans that were (or would be, in dry-run) invoiced. */
  plans: InvoicePlan[];
}

export async function runInvoice(
  store: Store,
  reporter: Reporter,
  opts: RunInvoiceOptions,
): Promise<RunInvoiceResult> {
  const now = (opts.now ?? Date.now)();
  const log = opts.log ?? (() => {});

  const lastWindow = await store.lastProcessedWindow();
  const aggregatedThrough = lastWindow > 0 ? lastWindow + opts.windowMs : 0;

  const pending = await store.pendingMetrics(
    opts.batchSize ?? Number.MAX_SAFE_INTEGER,
  );
  const plans = buildInvoicePlans(pending, {
    policy: opts.policy,
    periodMs: opts.periodMs,
    now,
    aggregatedThrough,
    includeIncomplete: opts.drain,
  });

  const result: RunInvoiceResult = {
    spends: 0,
    records: 0,
    failed: 0,
    unresolved: 0,
    plans,
  };

  if (opts.dryRun) {
    for (const p of plans) {
      log(
        `[dry-run] would invoice ${p.unytPubKey} for period ` +
          `${new Date(p.periodStart).toISOString()} amount ${JSON.stringify(p.amount)}`,
      );
    }
    return result;
  }

  const claimed = await store.claimedPlans();
  const parked =
    plans.length > 0 || claimed.length > 0
      ? await reporter.parkedInvoiceKeys(opts.agreementId)
      : new Set<string>();

  // Park one claimed plan. A failed call leaves the claim for the next run,
  // which first checks whether the spend landed anyway. A failure to record
  // a parked spend is not caught: the run stops before it can execute.
  const park = async (c: InvoiceClaim) => {
    const label =
      `${c.payee} period ${new Date(c.periodStart).toISOString()} ` +
      `amount ${JSON.stringify(c.amount)}`;
    try {
      await reporter.report({
        agreementId: opts.agreementId,
        ctRoleId: opts.policy.ctRoleId,
        amount: c.amount,
        spenderPayload: c.spenderPayload,
        laneDefinitionIds: opts.laneDefinitionIds ?? [],
      });
    } catch (err) {
      result.failed++;
      result.unresolved++;
      const msg = err instanceof Error ? err.message : String(err);
      log(`invoice FAILED for ${label}: ${msg} — left claimed`);
      return;
    }
    await store.markClaimInvoiced(c.key, now);
    result.spends++;
    result.records += c.recordIds.length;
    log(`invoiced ${label} (${c.recordIds.length} record(s))`);
  };

  const settled = async (c: InvoiceClaim) => {
    await store.markClaimInvoiced(c.key, now);
    result.records += c.recordIds.length;
    log(
      `already parked: ${c.payee} period ` +
        `${new Date(c.periodStart).toISOString()} (key ${c.key.slice(0, 12)}…)`,
    );
  };

  // Plans an earlier run claimed: settle the ones that landed, park the rest
  // again with exactly the amount claimed.
  for (const c of claimed) {
    if (parked.has(c.key)) await settled(c);
    else await park(c);
  }

  const valueOf = new Map(pending.map((r) => [r.id, r.value]));
  for (const p of plans) {
    const key = invoiceKey({
      agreementId: opts.agreementId,
      payee: p.unytPubKey,
      periodStart: p.periodStart,
      policyVersion: opts.policy.version,
      recordIds: p.recordIds,
    });
    const claim: InvoiceClaim = {
      key,
      payee: p.unytPubKey,
      periodStart: p.periodStart,
      amount: p.amount,
      spenderPayload: {
        ...(p.spenderPayload as Record<string, unknown>),
        invoice_key: key,
      },
      recordIds: p.recordIds,
    };
    const claimedNow = await store.claimPlan({
      ...claim,
      rows: p.recordIds.map((id) => ({ id, value: valueOf.get(id)! })),
    });
    if (!claimedNow) {
      log(
        `skipped ${p.unytPubKey} period ` +
          `${new Date(p.periodStart).toISOString()}: records changed since ` +
          `the plan was built; the next run invoices them`,
      );
      continue;
    }
    if (parked.has(key)) await settled(claim);
    else await park(claim);
  }

  log(
    `invoice run: ${result.spends} spend(s), ${result.records} record(s), ` +
      `${result.failed} failed`,
  );
  return result;
}
