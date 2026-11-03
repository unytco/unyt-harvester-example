import { loadConfig } from "../../config.js";
import { NomadClient } from "./client.js";
import { SqliteNomadStore } from "./store.js";
import { ingestNodeAllocations } from "./allocations.js";

/**
 * One-shot ingest: pull a node's current allocations from Nomad into the store.
 *
 *   npm run pull:allocs -- <node-id>      # one node
 *   npm run pull:allocs                   # every registered node
 *   STORE_PATH=./data.db npm run pull:allocs -- <node-id>
 *
 * This is the manual trigger for the pull-based ingest. The same
 * `ingestNodeAllocations` call will later be driven by the event-stream watcher
 * or a cron. Progress goes to stderr; a one-line-per-node summary to stdout.
 */
export async function pullAllocations(): Promise<void> {
  const config = loadConfig();
  const client = new NomadClient(config);
  const store = new SqliteNomadStore(config.storePath);

  console.error(
    `Nomad: ${config.nomadAddr} (token: ${config.nomadToken ? "set" : "none"}, ` +
      `tls-verify: ${config.nomadSkipTlsVerify ? "SKIPPED" : "on"}) ` +
      `store: ${config.storePath}`,
  );

  const argNodeId = process.argv[2]?.trim();
  let nodeIds: string[];
  if (argNodeId) {
    nodeIds = [argNodeId];
  } else {
    const stubs = await client.listNodes();
    nodeIds = stubs.map((s) => s.ID);
    console.error(`No node id given — pulling all ${nodeIds.length} node(s)`);
  }

  // Pull each node independently: one node failing (e.g. transient API error)
  // shouldn't abort the rest of the bulk run. Failures are logged and the
  // process exits non-zero so a caller/cron can detect partial failure.
  let failures = 0;
  try {
    for (const id of nodeIds) {
      try {
        const r = await ingestNodeAllocations(client, store, id);
        console.log(
          `node ${r.nodeId}: fetched=${r.fetched} ` +
            `inserted=${r.inserted} updated=${r.updated} unchanged=${r.unchanged} ` +
            `maxModifyIndex=${r.maxModifyIndex}`,
        );
      } catch (err) {
        failures++;
        console.error(
          `node ${id}: FAILED — ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  } finally {
    await store.close();
  }

  if (failures > 0) {
    console.error(`${failures}/${nodeIds.length} node(s) failed`);
    process.exitCode = 1;
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  pullAllocations().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
