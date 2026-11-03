import { loadOpsConfig } from "../config.js";
import { SqliteStore } from "../store/sqlite-store.js";
import { processWindows } from "../pipeline/process.js";
import { hcOpenSessionWithRetry, HcSession } from "../holochain/hc-client.js";
import { alertOnFailure } from "../ops/alerts.js";
import { openSource } from "../sources/open.js";

/**
 * One-shot aggregation run: ingest new records from the configured source and
 * queue each operator's measurements per window as pending metric records.
 *
 *   npm run process
 *   npm run process -- --drain          # also measure the in-progress window
 *   npm run process -- --recheck-agents # ask the network again about absent keys
 *
 * Idempotent — safe to run on a schedule or by hand. With `HC_APP_PORT` set,
 * each new operator key is checked against the unyt network, and a key the
 * network does not hold is skipped. A failed connection aborts the run.
 */
export async function processRecords(): Promise<void> {
  const drain = process.argv.includes("--drain");
  const recheckAbsent = process.argv.includes("--recheck-agents");
  const config = loadOpsConfig();
  const log = (m: string) => console.error(m);
  let session: HcSession | undefined;
  if (config.hcAppPort > 0) {
    session = await alertOnFailure("connect", config.agreementId, () =>
      hcOpenSessionWithRetry(config),
    );
  } else {
    log("HC_APP_PORT unset: agent keys are not checked against the network");
  }
  const store = new SqliteStore(config.storePath);
  const source = await openSource(config, log);
  log(
    `store: ${config.storePath} source: ${source.name} ` +
      `window: ${config.windowMs}ms` +
      (drain ? " (drain)" : ""),
  );
  try {
    const results = await processWindows(store, source, {
      windowMs: config.windowMs,
      drain,
      agentExists: session ? (key) => session.agentExists(key) : undefined,
      recheckAbsent,
      log,
    });
    const queued = results.reduce(
      (n, r) => n + r.metricsInserted + r.metricsUpdated,
      0,
    );
    console.log(
      `processed ${results.length} window(s); ${queued} metric(s) queued or updated`,
    );
  } finally {
    await source.close();
    await store.close();
    await session?.close();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  processRecords().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
