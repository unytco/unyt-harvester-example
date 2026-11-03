import { test } from "node:test";
import assert from "node:assert/strict";
import { ingestNodeAllocations } from "../../../src/sources/nomad/allocations.js";
import { SqliteNomadStore } from "../../../src/sources/nomad/store.js";
import { NomadClient } from "../../../src/sources/nomad/client.js";
import { NomadAllocStub } from "../../../src/sources/nomad/types.js";

/** A NomadClient stand-in that returns a fixed allocation list. */
function fakeClient(allocs: Partial<NomadAllocStub>[]): NomadClient {
  return {
    listNodeAllocations: async () => allocs as NomadAllocStub[],
  } as unknown as NomadClient;
}

test("ingest pulls, stores, and records node sync", async () => {
  const store = new SqliteNomadStore(":memory:");
  const client = fakeClient([
    { ID: "a1", NodeID: "n1", ModifyIndex: 5 },
    { ID: "a2", NodeID: "n1", ModifyIndex: 12 },
  ]);

  const r = await ingestNodeAllocations(client, store, "n1", () => 1000);
  assert.equal(r.fetched, 2);
  assert.equal(r.inserted, 2);
  assert.equal(r.maxModifyIndex, 12);

  assert.equal((await store.allocationsForNode("n1")).length, 2);
  assert.deepEqual(await store.getNodeSync("n1"), {
    nodeId: "n1",
    lastModifyIndex: 12,
    lastSyncedAt: 1000,
  });
  await store.close();
});

test("re-ingest is idempotent", async () => {
  const store = new SqliteNomadStore(":memory:");
  const client = fakeClient([{ ID: "a1", NodeID: "n1", ModifyIndex: 5 }]);
  await ingestNodeAllocations(client, store, "n1", () => 1);
  const again = await ingestNodeAllocations(client, store, "n1", () => 2);
  assert.equal(again.inserted, 0);
  assert.equal(again.unchanged, 1);
  await store.close();
});

test("ingesting a node with no allocations is a clean no-op", async () => {
  const store = new SqliteNomadStore(":memory:");
  const r = await ingestNodeAllocations(fakeClient([]), store, "n1", () => 1);
  assert.deepEqual(
    {
      fetched: r.fetched,
      inserted: r.inserted,
      maxModifyIndex: r.maxModifyIndex,
    },
    { fetched: 0, inserted: 0, maxModifyIndex: 0 },
  );
  await store.close();
});
