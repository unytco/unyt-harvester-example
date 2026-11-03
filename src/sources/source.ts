/**
 * A source of truth the payer trusts. It records raw work (requests served,
 * time online) and reports it as per-operator measurements over a window.
 * Everything downstream — attribution, billing, invoicing — only sees these.
 */

/** One operator's measured amount of one metric over one window. */
export interface Measurement {
  /** The source's own id for what was measured (an operator id, a node id). */
  sourceId: string;
  /** The operator's Unyt AgentPubKey as the source reports it (validated downstream). */
  operatorKey: string;
  metricKey: string;
  /** Window [windowStart, windowEnd), ms epoch. */
  windowStart: number;
  windowEnd: number;
  /** Non-negative integer, as a string so it stays bigint-safe. */
  value: string;
}

export interface IngestResult {
  inserted: number;
  /** Records already stored (re-read or duplicated). */
  ignored: number;
  /**
   * Earliest timestamp among newly inserted records, or null. Windows from
   * here on are measured again, so late records are counted.
   */
  earliest: number | null;
}

export interface Source {
  name: string;
  /** Pull new raw records into the source's own tables. Idempotent. */
  ingest(): Promise<IngestResult>;
  /** Measurements for the window [windowStart, windowEnd). */
  measure(windowStart: number, windowEnd: number): Promise<Measurement[]>;
  close(): Promise<void>;
}
