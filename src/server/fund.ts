import { loadOpsConfig, envDecimal } from "../config.js";
import { hcOpenSessionWithRetry } from "../holochain/hc-client.js";
import { ensureFunded, FUNDER_ROLE } from "../billing/fund.js";
import { hfToMicro } from "../billing/funding.js";
import { markExecutePending } from "../billing/execute.js";
import { SqliteStore } from "../store/sqlite-store.js";
import { alert, lowBalanceAlert, alertOnFailure } from "../ops/alerts.js";

/**
 * Keep the agreement funded from the harvester balance.
 *
 *   npm run fund                       # top up to FUND_MIN_HF / FUND_TOP_UP_HF from .env
 *   npm run fund -- --min 2 --top-up 10
 *   npm run fund -- --hf 5             # park exactly 5 HF now
 *
 * Alerts when the agent's HF balance is below BALANCE_ALERT_HF.
 */
function parseArgs(argv: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) out[a.slice(2)] = argv[++i] ?? "";
  }
  return out;
}

export async function fund(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const config = loadOpsConfig();
  if (!config.agreementId) throw new Error("AGREEMENT_ID is required");
  for (const name of ["hf", "min", "top-up"]) {
    if (name in args && !args[name].trim()) {
      throw new Error(`--${name} needs a value`);
    }
  }
  const minHf = envDecimal(args["min"]) ?? config.fundMinHf;
  const topUpHf = envDecimal(args["top-up"]) ?? config.fundTopUpHf;
  const fixedHf = envDecimal(args["hf"]);
  if (!fixedHf && (!minHf || !topUpHf)) {
    throw new Error(
      "give --hf <amount>, or --min and --top-up (or FUND_MIN_HF/FUND_TOP_UP_HF)",
    );
  }

  const session = await alertOnFailure("connect", config.agreementId, () =>
    hcOpenSessionWithRetry(config),
  );
  try {
    const laneDefinitionIds = await alertOnFailure(
      "lanes",
      config.agreementId,
      () => session.resolveLanes(config.laneDefinitionIds),
    );
    const r = await alertOnFailure("fund", config.agreementId, () =>
      ensureFunded(session, {
        agreementId: config.agreementId,
        laneDefinitionIds,
        log: (m: string) => console.error(m),
        fixedHf,
        minHf,
        topUpHf,
      }),
    );
    if (r.parkedHf !== "0") {
      // The next invoice run executes the agreement over this top-up.
      const store = new SqliteStore(config.storePath);
      try {
        await markExecutePending(store);
      } finally {
        await store.close();
      }
    }
    console.log(
      `fund: parked ${r.parkedHf} HF as ${FUNDER_ROLE}; balance now ${r.balanceHfAfter} HF`,
    );
    if (
      config.balanceAlertHf &&
      hfToMicro(r.balanceHfAfter) < hfToMicro(config.balanceAlertHf)
    ) {
      alert(
        lowBalanceAlert(session.agent, r.balanceHfAfter, config.balanceAlertHf),
      );
    }
  } finally {
    await session.close();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  fund().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
