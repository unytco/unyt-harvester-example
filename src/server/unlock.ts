import { loadOpsConfig } from "../config.js";
import { hcOpenSessionWithRetry } from "../holochain/hc-client.js";
import { unlockAgreement } from "../billing/unlock.js";
import { alertOnFailure } from "../ops/alerts.js";

/**
 * Return the HF an agreement holds to the harvester balance, where `fund` can
 * park it on the next agreement. Runs on the harvester node: the execution must
 * be signed by the authorized executor and the receipt by the receiver, and
 * both are the harvester agent.
 *
 *   npm run unlock                        # the agreement in AGREEMENT_ID
 *   npm run unlock -- --agreement uhCkk...  # an older one, after .env moved on
 *   npm run unlock -- --dry-run           # report the held HF only
 *   npm run unlock -- --force             # even with invoices still parked
 */
function parseArgs(argv: string[]): Record<string, string | true> {
  const out: Record<string, string | true> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) continue;
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) out[a.slice(2)] = true;
    else out[a.slice(2)] = argv[++i];
  }
  return out;
}

export async function unlock(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const config = loadOpsConfig();
  const agreementId =
    typeof args.agreement === "string" ? args.agreement : config.agreementId;
  if (!agreementId) {
    throw new Error("AGREEMENT_ID or --agreement <ea_id> is required");
  }

  const session = await alertOnFailure("connect", agreementId, () =>
    hcOpenSessionWithRetry(config),
  );
  try {
    const laneDefinitionIds = await alertOnFailure("lanes", agreementId, () =>
      session.resolveLanes(config.laneDefinitionIds),
    );
    const r = await alertOnFailure("unlock", agreementId, () =>
      unlockAgreement(session, {
        agreementId,
        laneDefinitionIds,
        dryRun: args["dry-run"] === true,
        force: args.force === true,
        log: (m: string) => console.error(m),
      }),
    );
    console.log(
      `unlock: returned ${r.unlockedHf} HF from ${agreementId}; balance now ${r.balanceHfAfter} HF`,
    );
  } finally {
    await session.close();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  unlock().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
