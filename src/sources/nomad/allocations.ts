import { NomadClient } from "./client.js";
import { parseAllocation } from "./parse.js";
import { NomadStore, UpsertResult } from "./store.js";

/** Outcome of pulling and storing one node's allocations. */
export interface PullResult extends UpsertResult {
  nodeId: string;
  /** Total allocations returned by Nomad for this node. */
  fetched: number;
  /** Highest allocation ModifyIndex seen this pull (0 if none). */
  maxModifyIndex: number;
}

/**
 * Pull the current allocation set for one node from Nomad and store it.
 *
 * This is the pull-based ingest path: a single point-in-time refresh of a node's
 * "current state". It's idempotent (the store upsert no-ops on stale rows), so a
 * trigger — manual now, the event-stream watcher or a cron later — can call it
 * repeatedly and safely.
 *
 * @param now  ms-epoch clock, injectable for tests; defaults to `Date.now`.
 */
export async function ingestNodeAllocations(
  client: NomadClient,
  store: NomadStore,
  nodeId: string,
  now: () => number = Date.now,
): Promise<PullResult> {
  const observedAt = now();
  const raw = await client.listNodeAllocations(nodeId);
  const allocs = raw.map((a) => parseAllocation(a, observedAt));

  const upserted = await store.upsertAllocations(allocs);

  const maxModifyIndex = allocs.reduce(
    (max, a) => (a.modifyIndex > max ? a.modifyIndex : max),
    0,
  );

  await store.setNodeSync({
    nodeId,
    lastModifyIndex: maxModifyIndex,
    lastSyncedAt: observedAt,
  });

  return {
    nodeId,
    fetched: allocs.length,
    maxModifyIndex,
    ...upserted,
  };
}
