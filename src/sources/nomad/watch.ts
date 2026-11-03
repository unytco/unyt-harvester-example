import { loadConfig } from "../../config.js";
import { NomadClient } from "./client.js";
import { SqliteNomadStore } from "./store.js";
import { StreamWatcher } from "./watch-stream.js";

/**
 * Long-lived entrypoint: watch the Nomad event stream, recording node
 * up/down transitions and re-pulling allocations for nodes that change.
 *
 *   npm run watch
 *   FLUSH_INTERVAL_MS=5000 STORE_PATH=./data.db npm run watch
 *
 * Ctrl-C (SIGINT/SIGTERM) aborts cleanly: the stream closes, dirty nodes are
 * drained, and the store is closed. The resume index is persisted as it runs,
 * so a restart picks up where it left off.
 */
export async function watchNomadEvents(): Promise<void> {
  const config = loadConfig();
  const client = new NomadClient(config);
  const store = new SqliteNomadStore(config.storePath);
  const watcher = new StreamWatcher(client, store, {
    flushIntervalMs: config.flushIntervalMs,
    idleTimeoutMs: config.idleTimeoutMs,
    agentRefreshMs: config.agentRefreshMs,
  });

  console.error(
    `Nomad: ${config.nomadAddr} (token: ${config.nomadToken ? "set" : "none"}, ` +
      `tls-verify: ${config.nomadSkipTlsVerify ? "SKIPPED" : "on"}) ` +
      `store: ${config.storePath} flush: ${config.flushIntervalMs}ms ` +
      `idle-timeout: ${config.idleTimeoutMs}ms agent-refresh: ${config.agentRefreshMs}ms`,
  );

  const controller = new AbortController();
  for (const sig of ["SIGINT", "SIGTERM"] as const) {
    process.on(sig, () => {
      console.error(`\n${sig} — shutting down...`);
      controller.abort();
    });
  }

  try {
    await watcher.run(controller.signal);
  } finally {
    await store.close();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  watchNomadEvents().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
