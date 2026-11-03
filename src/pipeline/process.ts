import { Store } from "../store/store.js";
import { Measurement, Source } from "../sources/source.js";
import { buildMetric } from "./format.js";
import { attributeOrSkip, isValidAgentKey } from "./null-guard.js";

export interface ProcessOptions {
  /** Aggregation window length in ms (default one day). */
  windowMs?: number;
  /** ms-epoch clock, injectable for tests. */
  now?: () => number;
  log?: (msg: string) => void;
  /**
   * Asks the unyt network whether it holds an agent key (the app's
   * `check_agent_exists`). When set, every valid key with no final answer is
   * asked, and a key the network does not hold is skipped. A thrown error
   * aborts the run before the cursor advances. Unset: no checks; stored
   * answers still apply.
   */
  agentExists?: (agentPubKey: string) => Promise<boolean>;
  /**
   * How many `false` answers to accept before a key is left as absent for
   * good. The zome also answers `false` while a new agent's entry has not
   * reached this conductor, so an absent key is rechecked once per run until
   * the cap. Default 3.
   */
  maxPresenceChecks?: number;
  /** Ask every absent key again this run, past the cap. */
  recheckAbsent?: boolean;
  /**
   * Also measure the in-progress window up to `now`, so a final run loses
   * nothing. The window is measured again in full on a later run.
   */
  drain?: boolean;
}

export interface WindowResult {
  windowStart: number;
  windowEnd: number;
  operators: number;
  skipped: number;
  metricsInserted: number;
  metricsUpdated: number;
}

const ONE_DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_MAX_PRESENCE_CHECKS = 3;

/**
 * Ingest new records from the source, then measure every window from the
 * earliest one they touch (or the cursor) through the last complete window
 * into the metrics outbox. Re-measuring is safe: the outbox bills only what
 * is not already invoiced (see `Store.upsertMetrics`).
 */
export async function processWindows(
  store: Store,
  source: Source,
  opts: ProcessOptions = {},
): Promise<WindowResult[]> {
  const windowMs = opts.windowMs ?? ONE_DAY_MS;
  const now = (opts.now ?? Date.now)();
  const log = opts.log ?? (() => {});
  const align = (t: number) => Math.floor(t / windowMs) * windowMs;

  const ingested = await source.ingest();
  log(
    `${source.name}: ${ingested.inserted} new record(s), ` +
      `${ingested.ignored} already stored`,
  );

  const latestCompleteStart = align(now) - windowMs;
  const cursor = await store.lastProcessedWindow();
  let from = cursor > 0 ? cursor + windowMs : latestCompleteStart;
  if (ingested.earliest !== null) {
    from = Math.min(from, align(ingested.earliest));
  }
  const windows: Array<[number, number]> = [];
  for (let start = Math.max(0, from); start <= latestCompleteStart;) {
    windows.push([start, start + windowMs]);
    start += windowMs;
  }
  if (opts.drain && now > latestCompleteStart + windowMs) {
    windows.push([latestCompleteStart + windowMs, now]);
  }

  const measured = new Map<string, Measurement[]>();
  for (const [start, end] of windows) {
    measured.set(`${start}`, await source.measure(start, end));
  }

  let nowPresent: string[] = [];
  if (opts.agentExists) {
    const keys = new Set([
      ...[...measured.values()].flat().map((m) => m.operatorKey),
      ...(await store.skippedAgents()),
    ]);
    nowPresent = await checkAgentPresence(
      store,
      [...keys],
      opts.agentExists,
      opts.recheckAbsent
        ? Number.POSITIVE_INFINITY
        : (opts.maxPresenceChecks ?? DEFAULT_MAX_PRESENCE_CHECKS),
      now,
      log,
    );
  }

  // A key the network lacked earlier was skipped; now that it is here, measure
  // the windows it missed again.
  const firstWindow = windows[0]?.[0] ?? latestCompleteStart + windowMs;
  let earliestSkipped = firstWindow;
  for (const key of nowPresent) {
    const skipped = (await store.getAgentPresence(key))?.firstSkippedWindow;
    if (skipped != null) earliestSkipped = Math.min(earliestSkipped, skipped);
  }
  for (let start = firstWindow - windowMs; start >= earliestSkipped;) {
    windows.unshift([start, start + windowMs]);
    measured.set(`${start}`, await source.measure(start, start + windowMs));
    start -= windowMs;
  }

  const results: WindowResult[] = [];
  for (const [start, end] of windows) {
    results.push(
      await recordWindow(
        store,
        measured.get(`${start}`)!,
        start,
        end,
        now,
        log,
      ),
    );
  }
  for (const key of nowPresent) await store.clearSkippedWindow(key);
  if (latestCompleteStart >= 0 && latestCompleteStart > cursor) {
    await store.setLastProcessedWindow(latestCompleteStart);
  }
  return results;
}

/**
 * Ask the network about every valid key that has no final answer: unchecked
 * keys, and absent keys still under the check cap. Throws on the first failed
 * call so a conductor outage delays aggregation rather than dropping payees.
 * Returns the keys found present this run.
 */
async function checkAgentPresence(
  store: Store,
  keys: string[],
  agentExists: (agentPubKey: string) => Promise<boolean>,
  maxChecks: number,
  now: number,
  log: (msg: string) => void,
): Promise<string[]> {
  const found: string[] = [];
  for (const key of keys) {
    if (!isValidAgentKey(key)) continue;
    const current = await store.getAgentPresence(key);
    if (current?.presence === "present") continue;
    if (current?.presence === "absent" && current.checks >= maxChecks) continue;
    const present = await agentExists(key);
    await store.setAgentPresence(key, present, now);
    if (present) found.push(key);
    const checks = (current?.checks ?? 0) + 1;
    log(
      `presence: key ${key} ` +
        (present
          ? "is on this network"
          : `is not on this network (check ${checks}` +
            (Number.isFinite(maxChecks) ? `/${maxChecks}` : "") +
            (checks >= maxChecks ? ", giving up)" : ")")),
    );
  }
  return found;
}

async function recordWindow(
  store: Store,
  measurements: Measurement[],
  windowStart: number,
  windowEnd: number,
  createdAt: number,
  log: (msg: string) => void,
): Promise<WindowResult> {
  const items = await Promise.all(
    measurements.map(async (m) => {
      const presence = await store.getAgentPresence(m.operatorKey);
      return {
        ...m,
        unytAgentId: m.operatorKey,
        onNetwork: presence?.presence
          ? presence.presence === "present"
          : undefined,
      };
    }),
  );
  const { kept, skipped } = attributeOrSkip(items, log);
  for (const item of skipped) {
    if (item.onNetwork === false) {
      await store.noteSkippedWindow(item.operatorKey, windowStart);
    }
  }
  const records = kept.map((m) =>
    buildMetric({
      sourceId: m.sourceId,
      unytPubKey: m.unytPubKey,
      metricKey: m.metricKey,
      windowStart,
      windowEnd,
      value: BigInt(m.value),
      createdAt,
    }),
  );
  const r = await store.upsertMetrics(records);
  const operators = new Set(kept.map((m) => m.unytPubKey)).size;
  log(
    `process: window ${new Date(windowStart).toISOString()} — ` +
      `${operators} operator(s), ${skipped.length} skipped, ` +
      `${r.inserted} queued, ${r.updated} updated`,
  );
  return {
    windowStart,
    windowEnd,
    operators,
    skipped: skipped.length,
    metricsInserted: r.inserted,
    metricsUpdated: r.updated,
  };
}
