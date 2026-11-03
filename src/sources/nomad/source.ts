import { IngestResult, Measurement, Source } from "../source.js";
import { NomadClient } from "./client.js";
import { NomadStore } from "./store.js";
import { StreamWatcher } from "./watch-stream.js";
import { computeTestSeconds, computeUptimeSeconds } from "./aggregate.js";

/**
 * Nomad as the source of truth: the Wind Tunnel program pays node operators
 * for keeping a node available (`nomadAvailability`, seconds ready) and for
 * the tests it runs (`nomadTestTime`, seconds of running allocations). Each
 * node names its operator in the Nomad client meta `unyt_agent_id`.
 *
 * The long-running `watch` command keeps the tables current from Nomad's event
 * stream. `ingest` is a one-shot catch-up (node snapshot plus an allocation
 * pull per node) for runs without `watch`; it needs a client.
 */
export const NOMAD_METRICS = {
  availability: "nomadAvailability",
  testTime: "nomadTestTime",
} as const;

export function nomadSource(opts: {
  store: NomadStore;
  client?: NomadClient;
  log?: (msg: string) => void;
}): Source {
  const { store, client } = opts;
  return {
    name: "nomad",

    async ingest(): Promise<IngestResult> {
      if (!client) return { inserted: 0, ignored: 0, earliest: null };
      const watcher = new StreamWatcher(client, store, { log: opts.log });
      await watcher.reconcile();
      const { pulled } = await watcher.flush();
      // No earliest time is reported, so windows before the cursor are not
      // measured again: events a catch-up pulls for them are not counted, and
      // a first run measures only the latest complete window.
      return { inserted: pulled, ignored: 0, earliest: null };
    },

    async measure(windowStart: number, windowEnd: number) {
      const out: Measurement[] = [];
      for (const nodeId of await store.allNodeIds()) {
        const operatorKey = (await store.getNodeAgent(nodeId)) ?? "";
        const values: Array<[string, number]> = [
          [
            NOMAD_METRICS.availability,
            computeUptimeSeconds(
              await store.nodeStatusHistory(nodeId),
              windowStart,
              windowEnd,
            ),
          ],
          [
            NOMAD_METRICS.testTime,
            computeTestSeconds(
              await store.allocationsForNode(nodeId),
              windowStart,
              windowEnd,
            ),
          ],
        ];
        for (const [metricKey, value] of values) {
          if (value > 0) {
            out.push({
              sourceId: nodeId,
              operatorKey,
              metricKey,
              windowStart,
              windowEnd,
              value: String(value),
            });
          }
        }
      }
      return out;
    },

    close: () => store.close(),
  };
}
