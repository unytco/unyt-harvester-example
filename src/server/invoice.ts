import {
  loadOpsConfig,
  OpsConfig,
  requireLaneDefinitionIds,
} from "../config.js";
import { SqliteStore } from "../store/sqlite-store.js";
import {
  loadPolicy,
  resolveRuleUnits,
  ResolvedPolicy,
} from "../billing/policy.js";
import { runInvoice, Reporter } from "../billing/run-invoice.js";
import { InvoicePlan } from "../billing/invoice.js";
import {
  hfCostMicro,
  fundingTotalMicro,
  fundingLargestMicro,
  microToHf,
  hfToMicro,
  HfPricing,
} from "../billing/funding.js";
import {
  hcOpenSession,
  hcOpenSessionWithRetry,
  hcReadFunding,
  AgreementFunding,
  ParkedSpend,
  HcSession,
} from "../holochain/hc-client.js";
import { readCreds } from "../holochain/creds.js";
import { ensureFunded } from "../billing/fund.js";
import {
  executeBlocker,
  executeIfPending,
  markExecutePending,
} from "../billing/execute.js";
import {
  alert,
  lowBalanceAlert,
  failureAlert,
  errorMessage,
  alertOnFailure,
  alertAndContinue,
} from "../ops/alerts.js";

/**
 * One-shot invoice run: roll pending metric records into parked spends on the
 * configured agreement, creating them directly in the unyt Holochain app.
 * Once the period's invoices are parked, the run
 * executes the agreement so it drains without a manual step. It also executes
 * when an earlier execute failed or a top-up was parked since the last one.
 *
 *   npm run invoice
 *   npm run invoice -- --dry-run      # show plans, create nothing, no execute
 *   npm run invoice -- --drain        # graceful stop: also close the current period
 *   npm run invoice -- --no-execute   # park only, don't execute the agreement
 *
 * At-least-once; a failed spend leaves its records pending to retry next run.
 * Exits non-zero if any spend failed or the execute failed, so a cron/caller can
 * alert. A failed execute does not un-park the spends.
 *
 * `--drain` is the graceful-stop close-out: it also invoices the in-progress
 * period (normally held back until fully elapsed). With INVOICE_PERIOD_MS long
 * enough to span the run, the drain parks one invoice per payee. Pair with
 * `process -- --drain` first so the final partial window is aggregated.
 */
export async function invoiceAndExecute(): Promise<void> {
  const dryRun = process.argv.includes("--dry-run");
  const drain = process.argv.includes("--drain");
  // After parking, the pipeline executes the agreement so it drains without a
  // manual step. `--no-execute` parks only (e.g. when another agent executes).
  const execute = !dryRun && !process.argv.includes("--no-execute");
  const config = loadOpsConfig();
  if (!config.agreementId) {
    throw new Error("AGREEMENT_ID is required to invoice");
  }
  if (!dryRun) requireLaneDefinitionIds(config);

  // A real run opens the session first: it re-runs hc:init if the stored
  // credentials fail, so the creds read below are fresh. It is reused for every
  // parked spend, the fund step and the execute.
  let session: HcSession | undefined;
  if (!dryRun) {
    session = await alertOnFailure("connect", config.agreementId, () =>
      hcOpenSessionWithRetry(config),
    );
  }
  const store = new SqliteStore(config.storePath);
  const configuredPolicy = await loadPolicy(config.policyPath);

  // A run-stopping error after the session and store are open: release both,
  // alert, and throw.
  const fail = async (message: string): Promise<never> => {
    await session?.close();
    await store.close();
    alert(failureAlert("invoice", config.agreementId, message));
    throw new Error(message);
  };

  // Read the agreement's pinned unit indices + price sheet + fundingSpends. The
  // indices are required to park under the units the agreement pins;
  // the price sheet lets a dry-run price the HF these invoices cost at execute.
  // A real run must read them; a dry-run degrades to measures-only if it can't.
  let funding: AgreementFunding | undefined;
  try {
    const creds = await readCreds(config.credsPath);
    funding = await hcReadFunding(
      config.hcAppPort,
      creds.hcCreds,
      creds.hcToken,
      config.agreementId,
    );
  } catch (err) {
    const msg = errorMessage(err);
    if (!dryRun) {
      await fail(
        `cannot read agreement units (needed to park under the right unit ` +
          `indices) from ${config.agreementId}: ${msg}`,
      );
    }
    console.error(
      `[dry-run] agreement unreadable — showing measures only, HF unknown: ${msg}`,
    );
  }

  // Map the policy's unit symbols onto this network's unit indices.
  const policy: ResolvedPolicy = await (async () => {
    const creds = session ? undefined : await readCreds(config.credsPath);
    const reader =
      session ??
      (await hcOpenSession(config.hcAppPort, creds!.hcCreds, creds!.hcToken));
    try {
      return resolveRuleUnits(
        configuredPolicy,
        await reader.unitIndexBySymbol(),
      );
    } finally {
      if (reader !== session) await reader.close();
    }
  })().catch((err) => fail(`units: ${errorMessage(err)}`));
  const pricing: HfPricing | undefined = funding?.priceSheet;

  // Cite the version of each configured lane that is in force now. A real run
  // cannot park without it; a dry-run reports the problem and shows plans.
  let laneDefinitionIds = config.laneDefinitionIds;
  try {
    if (session) {
      laneDefinitionIds = await session.resolveLanes(config.laneDefinitionIds);
    } else {
      const creds = await readCreds(config.credsPath);
      const reader = await hcOpenSession(
        config.hcAppPort,
        creds.hcCreds,
        creds.hcToken,
      );
      try {
        laneDefinitionIds = await reader.resolveLanes(config.laneDefinitionIds);
      } finally {
        await reader.close();
      }
    }
  } catch (err) {
    const msg = errorMessage(err);
    if (!dryRun) {
      await fail(`lanes: ${msg}`);
    }
    console.error(
      `[dry-run] lanes unresolved, citing LANE_DEFINITION_IDS as configured: ${msg}`,
    );
  }

  const reporter: Reporter = dryRun
    ? {
        async report() {
          throw new Error("dry-run: no spend");
        },
        parkedInvoiceKeys: async () => new Set<string>(),
      }
    : {
        report: (spend: ParkedSpend) => session!.report(spend),
        parkedInvoiceKeys: (agreementId: string) =>
          session!.parkedInvoiceKeys(agreementId),
      };

  console.error(
    `store: ${config.storePath} agreement: ${config.agreementId} ` +
      `policy: ${policy.version} period: ${config.invoicePeriodMs}ms` +
      ` units: ${policy.rules.map((r) => `${r.unitSymbol}=${r.unitIndex}`).join(" ")}` +
      `${dryRun ? " (dry-run)" : ""}${drain ? " (drain)" : ""}`,
  );

  try {
    let balanceHf: string | undefined;
    let parkedTopUp = false;
    let fundFailed = false;
    if (session && config.fundMinHf && config.fundTopUpHf) {
      // The invoices still park on a fund failure; a later execute may still be
      // covered by held HF.
      const funded = await alertAndContinue("fund", config.agreementId, () =>
        ensureFunded(session, {
          agreementId: config.agreementId,
          laneDefinitionIds,
          minHf: config.fundMinHf!,
          topUpHf: config.fundTopUpHf!,
          log: (m) => console.error(m),
        }),
      );
      balanceHf = funded?.balanceHfAfter;
      parkedTopUp = funded !== undefined && funded.parkedHf !== "0";
      fundFailed = funded === undefined;
    }
    if (session && config.balanceAlertHf) {
      await alertIfLowBalance(session, config, balanceHf);
    }
    const r = await runInvoice(store, reporter, {
      policy,
      agreementId: config.agreementId,
      laneDefinitionIds,
      periodMs: config.invoicePeriodMs,
      windowMs: config.windowMs,
      dryRun,
      drain,
      // Suppress runInvoice's own per-plan dry-run lines — we print a richer,
      // HF-priced view below.
      log: (m) => {
        if (!m.startsWith("[dry-run]")) console.error(m);
      },
    });
    if (dryRun) {
      printDryRun(r.plans, pricing, funding);
    }
    console.log(
      `invoice: ${r.spends} spend(s), ${r.records} record(s), ${r.failed} failed` +
        `${dryRun ? ` (dry-run; ${r.plans.length} plan(s))` : ""}`,
    );
    if (r.failed > 0) {
      process.exitCode = 1;
      alert(
        failureAlert("park", config.agreementId, `${r.failed} spend(s) failed`),
      );
    }

    // Execute when this run parked an invoice or a top-up, or when an earlier
    // execute failed or never ran, so parked spends do not wait for the next
    // invoice. Skipped on dry-run and `--no-execute`. A failed execute does not
    // un-park the spends; it is reported (non-zero exit) and retried next run.
    // See `executeBlocker` for when it waits for the next run instead.
    const blocker = executeBlocker({ fundFailed, unresolved: r.unresolved });
    if (execute && blocker) {
      if (r.spends > 0) await markExecutePending(store);
      console.error(`execute: ${blocker}`);
      process.exitCode = 1;
    } else if (execute) {
      const res = await executeIfPending(
        store,
        r.spends > 0 || parkedTopUp,
        () =>
          alertAndContinue("execute", config.agreementId, () =>
            session!.execute(config.agreementId, laneDefinitionIds),
          ),
      );
      if (res === undefined) {
        process.exitCode = 1;
      } else if (res !== "skipped") {
        console.log(
          `execute: agreement ${config.agreementId} ran, ` +
            `${res.allocations} allocation(s)`,
        );
      }
    }
  } finally {
    if (session) await session.close();
    await store.close();
  }
}

/**
 * Alert when the harvester balance is below BALANCE_ALERT_HF. Uses the balance
 * the fund step reported, or reads it when that step did not run.
 */
async function alertIfLowBalance(
  session: HcSession,
  config: OpsConfig,
  knownBalanceHf: string | undefined,
): Promise<void> {
  await alertAndContinue("invoice", config.agreementId, async () => {
    const balanceHf =
      knownBalanceHf ?? (await session.balances(config.agreementId)).balanceHf;
    if (hfToMicro(balanceHf) < hfToMicro(config.balanceAlertHf!)) {
      alert(lowBalanceAlert(session.agent, balanceHf, config.balanceAlertHf!));
    }
  });
}

/**
 * Dry-run presentation: per-plan measures + the HF each will cost at execute,
 * the total HF obligation, and whether the funding covers it (each payload is
 * paid from a single allocation, so the largest allocation — not the total — is
 * the per-payload ceiling).
 */
function printDryRun(
  plans: InvoicePlan[],
  pricing: HfPricing | undefined,
  funding: AgreementFunding | undefined,
): void {
  if (plans.length === 0) {
    console.error("[dry-run] nothing to invoice (no complete periods)");
    return;
  }
  // HF math is in micro-HF (HF*10^6) bigints; format with microToHf for display.
  let total = 0n;
  let maxPayload = 0n;
  for (const p of plans) {
    const ts = new Date(p.periodStart).toISOString();
    const payee = `${p.unytPubKey.slice(0, 12)}…`;
    if (pricing) {
      const hf = hfCostMicro(p.amount, pricing);
      total += hf;
      if (hf > maxPayload) maxPayload = hf;
      console.error(
        `[dry-run] ${payee} ${ts}  amount ${JSON.stringify(p.amount)}  -> ${microToHf(hf)} HF`,
      );
    } else {
      console.error(
        `[dry-run] ${payee} ${ts}  amount ${JSON.stringify(p.amount)}`,
      );
    }
  }
  if (!pricing) {
    console.error("[dry-run] HF: unknown (agreement price sheet unreadable)");
    return;
  }
  const tTotal = funding ? fundingTotalMicro(funding.fundingHf) : 0n;
  const tLargest = funding ? fundingLargestMicro(funding.fundingHf) : 0n;
  const allocs = funding?.fundingHf.length ?? 0;
  console.error(
    `[dry-run] HF obligation at execute: ${microToHf(total)} across ${plans.length} plan(s); ` +
      `largest single payload ${microToHf(maxPayload)} HF`,
  );
  console.error(
    `[dry-run] funding: ${microToHf(tTotal)} HF across ${allocs} allocation(s), largest ${microToHf(tLargest)} — ` +
      (maxPayload <= tLargest
        ? "OK (each payload fits a single allocation)"
        : "SHORT: a payload exceeds the largest allocation and will fail at execute"),
  );
}

if (import.meta.url === `file://${process.argv[1]}`) {
  invoiceAndExecute().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
