import { MetricRecord, MetricsSummary, Store } from "../store/store.js";

/**
 * Read-only query functions for ops visibility. Runtime-agnostic: the local
 * `ops` CLI calls these, and an HTTP `GET /status` handler could reuse them
 * unchanged.
 */

export function summary(store: Store): Promise<MetricsSummary> {
  return store.metricsSummary();
}

export function pending(store: Store, limit = 100): Promise<MetricRecord[]> {
  return store.pendingMetrics(limit);
}

export function invoiced(
  store: Store,
  opts: { since?: number; limit?: number } = {},
): Promise<MetricRecord[]> {
  return store.recentlyInvoiced(opts);
}

/** Pending records that have failed at least one dispatch attempt. */
export async function failures(
  store: Store,
  limit = 100,
): Promise<MetricRecord[]> {
  const p = await store.pendingMetrics(limit);
  return p.filter((m) => m.attempts > 0);
}
