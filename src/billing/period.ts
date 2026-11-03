/**
 * Invoice-period math — the configurable invoice periodicity (critical design
 * need #2).
 *
 * The aggregation window (how finely raw usage is bucketed into the outbox) and
 * the invoice period (how often we actually park a spend) are separate knobs.
 * The invoice period is a multiple of, and aligned the same way as, the
 * aggregation window, so each period rolls up one or more whole windows. Periods
 * are epoch-aligned: `periodStart = floor(t / periodMs) * periodMs`.
 */

/** The invoice period containing timestamp `t` (ms epoch). */
export function periodStartFor(t: number, periodMs: number): number {
  if (periodMs <= 0) {
    throw new Error("periodMs must be positive");
  }
  return Math.floor(t / periodMs) * periodMs;
}

/** Exclusive end of the period starting at `periodStart`. */
export function periodEnd(periodStart: number, periodMs: number): number {
  return periodStart + periodMs;
}

/**
 * A period is invoiceable only once fully elapsed. `aggregatedThrough` is the
 * end of the last aggregation window committed to the outbox; the period must be
 * both elapsed (`now`) and fully aggregated, else we would under-bill.
 */
export function isPeriodComplete(
  periodStart: number,
  periodMs: number,
  now: number,
  aggregatedThrough: number,
): boolean {
  const end = periodEnd(periodStart, periodMs);
  return end <= now && end <= aggregatedThrough;
}
