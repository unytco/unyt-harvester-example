import { loadOpsConfig } from "../config.js";
import { SqliteStore } from "../store/sqlite-store.js";
import { MetricRecord } from "../store/store.js";
import { isValidAgentKey } from "../pipeline/null-guard.js";
import { hcListLanes } from "../holochain/hc-client.js";
import { readCreds } from "../holochain/creds.js";
import * as reports from "../ops/reports.js";
import { laneReportLines } from "../ops/lane-report.js";

/**
 * Ops/debug CLI — read-only visibility into ingest + the metrics outbox.
 *
 *   npm run ops summary
 *   npm run ops lanes    [--json]           # conductor: lanes, newest + in-force definition
 *   npm run ops pending  [--limit N] [--json]
 *   npm run ops invoiced   [--since <ISO|ms>] [--limit N] [--json]
 *   npm run ops failures [--limit N] [--json]
 *
 * The store queries live in src/ops/reports.ts (runtime-agnostic) so the same
 * logic could back an HTTP endpoint later. `lanes` talks to the conductor (it
 * needs creds + HC_APP_PORT), the rest are store-only.
 */
export async function runOpsReport(): Promise<void> {
  const args = process.argv.slice(2);
  const cmd = args[0] ?? "summary";
  const json = args.includes("--json");
  const limit = intFlag(args, "--limit");
  const since = sinceFlag(args);

  const config = loadOpsConfig();
  const store = new SqliteStore(config.storePath);
  try {
    switch (cmd) {
      case "summary": {
        const s = await reports.summary(store);
        if (json) {
          out(s);
        } else {
          console.log(
            `pending: ${s.pending}   invoiced: ${s.invoiced}   failed: ${s.failed}`,
          );
          console.log(
            `last window: ${tsLabel(s.lastProcessedWindow)}   ` +
              `last invoice: ${tsLabel(s.lastInvoicedAt)}`,
          );
        }
        break;
      }
      case "lanes": {
        const { hcCreds, hcToken } = await readCreds(config.credsPath);
        const lanes = await hcListLanes(config.hcAppPort, hcCreds, hcToken);
        if (json) {
          out(lanes);
        } else {
          for (const line of laneReportLines(lanes, {
            agreementId: config.agreementId,
            configuredLaneIds: config.laneDefinitionIds,
            nowMs: Date.now(),
          })) {
            console.log(line);
          }
        }
        break;
      }
      case "pending":
        printMetrics(await reports.pending(store, limit ?? 100), json);
        break;
      case "invoiced":
        printMetrics(
          await reports.invoiced(store, { since, limit: limit ?? 100 }),
          json,
        );
        break;
      case "failures":
        printMetrics(await reports.failures(store, limit ?? 100), json);
        break;
      default:
        console.error(`unknown command: ${cmd}`);
        console.error(
          "commands: summary | lanes | pending | invoiced | failures",
        );
        process.exitCode = 2;
    }
  } finally {
    await store.close();
  }
}

function printMetrics(rows: MetricRecord[], json: boolean): void {
  if (json) {
    return out(rows);
  }
  if (rows.length === 0) {
    console.log("(none)");
    return;
  }
  for (const m of rows) {
    const tail =
      m.status === "invoiced"
        ? `invoiced ${tsLabel(m.invoicedAt)}`
        : m.attempts > 0
          ? `attempts=${m.attempts} err=${m.lastError ?? ""}`
          : "pending";
    console.log(
      `${m.metricKey.padEnd(22)} ${tsLabel(m.windowStart)} ` +
        `${m.unytPubKey.slice(0, 12).padEnd(12)} b=${m.value.padStart(6)}  ${tail}`,
    );
  }
  console.log(`(${rows.length} row${rows.length === 1 ? "" : "s"})`);
}

function out(v: unknown): void {
  console.log(JSON.stringify(v, null, 2));
}

function tsLabel(ms: number | null): string {
  return ms && ms > 0 ? new Date(ms).toISOString() : "—";
}

function intFlag(args: string[], name: string): number | undefined {
  const i = args.indexOf(name);
  if (i < 0 || i + 1 >= args.length) {
    return undefined;
  }
  const n = Number(args[i + 1]);
  return Number.isFinite(n) ? n : undefined;
}

function sinceFlag(args: string[]): number | undefined {
  const i = args.indexOf("--since");
  if (i < 0 || i + 1 >= args.length) {
    return undefined;
  }
  const raw = args[i + 1];
  const n = Number(raw);
  if (Number.isFinite(n)) {
    return n;
  }
  const d = Date.parse(raw);
  return Number.isNaN(d) ? undefined : d;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runOpsReport().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
