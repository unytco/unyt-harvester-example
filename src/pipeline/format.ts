import { MetricRecord } from "../store/store.js";

/**
 * Build a `pending` outbox record from an aggregated value. The
 * (sourceId, metricKey, windowStart) tuple is the idempotency key. The value is a
 * bigint-safe stringified non-negative integer.
 */
export function buildMetric(args: {
  sourceId: string;
  unytPubKey: string;
  metricKey: string;
  windowStart: number;
  windowEnd: number;
  value: number | bigint;
  createdAt: number;
}): MetricRecord {
  return {
    sourceId: args.sourceId,
    unytPubKey: args.unytPubKey,
    metricKey: args.metricKey,
    windowStart: args.windowStart,
    windowEnd: args.windowEnd,
    value: intString(args.value),
    status: "pending",
    attempts: 0,
    lastError: null,
    createdAt: args.createdAt,
    invoicedAt: null,
  };
}

function intString(value: number | bigint): string {
  if (typeof value === "bigint") {
    return (value < 0n ? 0n : value).toString();
  }
  return Math.max(0, Math.trunc(value)).toString();
}
