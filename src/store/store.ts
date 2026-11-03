/**
 * Storage layer
 *
 * One `Store` interface behind the concrete SQLite backend. Domain/ingest code
 * depends only on this interface, never on a concrete backend.
 *
 * The interface is async even though the SQLite backend is synchronous, so an
 * inherently-async backend could be swapped in without touching callers.
 */

/**
 * Lifecycle of an outbox metric record: `pending`, then `parking` once an
 * invoice run has claimed it for a spend (see `claimPlan`), then `invoiced`
 * once that spend is known to be parked.
 */
export type MetricStatus = "pending" | "parking" | "invoiced";

/** A plan an invoice run has committed to, before or after parking it. */
export interface InvoiceClaim {
  /** The spend's `invoice_key`. */
  key: string;
  payee: string;
  periodStart: number;
  amount: { [unitIndex: string]: string };
  spenderPayload: unknown;
  recordIds: number[];
}

/**
 * A metric record in the outbox plus its lifecycle. Aggregation inserts these as
 * `pending` ("analyzed"); the invoice job rolls them into a parked spend and
 * flips them to `invoiced`. The natural key (nodeId, metricKey, windowStart)
 * makes aggregation idempotent ("analyzed once"). `invoicedAt` is set when
 * a parked spend covers the record.
 */
export interface MetricRecord {
  /** Set by the store on insert; absent on new records. */
  id?: number;
  /** The source's own id for what was measured (an operator id, a node id). */
  sourceId: string;
  /** The operator's Unyt AgentPubKey, validated at attribution time. */
  unytPubKey: string;
  /** e.g. inputTokens, outputTokens. */
  metricKey: string;
  /** Aggregation window [windowStart, windowEnd); windowStart is the record timestamp. */
  windowStart: number;
  windowEnd: number;
  /** The metric amount: a stringified non-negative integer (bigint-safe). */
  value: string;
  status: MetricStatus;
  attempts: number;
  lastError: string | null;
  createdAt: number;
  invoicedAt: number | null;
}

/** Result of inserting metric records (idempotent by natural key). */
export interface MetricUpsertResult {
  inserted: number;
  /** Pending rows whose value changed (late records for a window). */
  updated: number;
  /** Already present with the same value. */
  skipped: number;
}

/** What the network has said so far about whether it holds an agent key. */
export interface AgentPresenceRow {
  presence: AgentPresence | null;
  checks: number;
  checkedAt: number | null;
  /** Earliest window skipped because the network lacked the key; null if none. */
  firstSkippedWindow: number | null;
}

/**
 * The network's answer to `check_agent_exists` for a node's key. `present` is
 * final. `absent` is rechecked by later runs up to a cap, because the zome also
 * answers false while a new agent's entry has not reached this conductor yet.
 */
export type AgentPresence = "present" | "absent";

/** Counts and cursors for ops visibility. */
export interface MetricsSummary {
  pending: number;
  invoiced: number;
  failed: number;
  lastProcessedWindow: number;
  lastInvoicedAt: number | null;
}

export interface Store {
  // ── Metrics outbox ───────────────────────────────────────────────────────

  /**
   * Record each window's measured total. `value` is the window's whole total;
   * the store bills only what no invoiced or claimed row for the same (sourceId,
   * metricKey, windowStart) already covers. That difference is one `pending`
   * row, inserted, updated, or removed as the total changes. Invoiced rows are
   * never touched, so re-measuring a window never double-counts, and a late
   * record for an invoiced window is billed in a follow-up spend.
   */
  upsertMetrics(records: MetricRecord[]): Promise<MetricUpsertResult>;

  /**
   * Claim pending rows for one spend: store the plan and set its rows to
   * `parking`, in one transaction. Refused (false) if any row is no longer
   * pending at the value the plan was built from, so a concurrent `process`
   * never changes what a spend pays for.
   */
  claimPlan(
    claim: Omit<InvoiceClaim, "recordIds"> & {
      rows: Array<{ id: number; value: string }>;
    },
  ): Promise<boolean>;

  /** Claims not yet known to be parked, oldest first. */
  claimedPlans(): Promise<InvoiceClaim[]>;

  /** The claim's spend is parked: its rows become `invoiced`. */
  markClaimInvoiced(key: string, invoicedAt: number): Promise<void>;

  /** The network's answers so far for an agent key, or null if never asked. */
  getAgentPresence(agentId: string): Promise<AgentPresenceRow | null>;

  /** Remember a window skipped because the network lacked the key (keeps the earliest). */
  noteSkippedWindow(agentId: string, windowStart: number): Promise<void>;

  /** Keys with skipped windows still to measure again. */
  skippedAgents(): Promise<string[]>;

  /** Forget the skipped windows once they have been measured again. */
  clearSkippedWindow(agentId: string): Promise<void>;

  /** Record one `check_agent_exists` answer for an agent key. */
  setAgentPresence(
    agentId: string,
    present: boolean,
    checkedAt: number,
  ): Promise<void>;

  /** Oldest `pending` metric records, up to `limit`. */
  pendingMetrics(limit?: number): Promise<MetricRecord[]>;

  /**
   * Mark records `invoiced` with the invoice timestamp — the terminal state of
   * the direct-to-Holochain path, set once a parked spend has been created for
   * them.
   */
  markInvoiced(ids: number[], invoicedAt: number): Promise<void>;

  /** Record a failed dispatch attempt (increments attempts, keeps it pending). */
  markFailed(id: number, error: string): Promise<void>;

  /** Recently `invoiced` records, newest first (ops visibility). */
  recentlyInvoiced(opts?: {
    since?: number;
    limit?: number;
  }): Promise<MetricRecord[]>;

  /** Counts + cursors for ops visibility. */
  metricsSummary(): Promise<MetricsSummary>;

  /** The last fully-processed aggregation window start (0 if none). */
  lastProcessedWindow(): Promise<number>;

  /** Advance the aggregation cursor. */
  setLastProcessedWindow(windowStart: number): Promise<void>;

  /** Generic key/value metadata (e.g. the persisted payment-authorization proof). */
  getMeta(key: string): Promise<string | undefined>;
  setMeta(key: string, value: string): Promise<void>;

  /** Release backend resources (close DB handles, etc.). */
  close(): Promise<void>;
}
