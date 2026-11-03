import { DatabaseSync } from "node:sqlite";
import {
  AgentPresence,
  AgentPresenceRow,
  InvoiceClaim,
  MetricRecord,
  MetricUpsertResult,
  MetricsSummary,
  Store,
} from "./store.js";

/**
 * SQLite-backed `Store` — the only `Store` backend (ARCHITECTURE §3).
 *
 * `node:sqlite` is synchronous; the async `Store` contract is satisfied by
 * returning resolved promises, which also keeps the door open for an
 * inherently-async backend without changing the interface.
 *
 * Pass `":memory:"` for an ephemeral DB (tests). The schema is created on open,
 * so a fresh file or `:memory:` is immediately usable.
 */
export class SqliteStore implements Store {
  #db: DatabaseSync;

  constructor(path = ":memory:") {
    this.#db = new DatabaseSync(path);
    // WAL is active for the file-backed store (the production default); it's a
    // no-op for :memory: but harmless. Better concurrency for the read/write mix
    // a future stream watcher + scheduled job will produce.
    this.#db.exec("PRAGMA journal_mode = WAL;");
    // Wait (rather than fail immediately) for a competing writer's lock: the
    // long-lived `watch` writer and the periodic `process`/`invoice` runs open
    // the same file concurrently, and WAL still serializes writes. Without this,
    // the loser gets SQLITE_BUSY on contention.
    this.#db.exec("PRAGMA busy_timeout = 5000;");
    this.#migrate();
  }

  #migrate(): void {
    this.#db.exec(`
      -- Generic pipeline metadata (e.g. the event-stream resume index).
      CREATE TABLE IF NOT EXISTS meta (
        key   TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );

      -- Metrics outbox (aggregation output + dispatch lifecycle). The UNIQUE
      -- key makes aggregation idempotent ("analyzed once") and mirrors the
      -- per-window dedup.
      CREATE TABLE IF NOT EXISTS metrics (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        source_id     TEXT NOT NULL,
        part          INTEGER NOT NULL DEFAULT 0,
        unyt_pub_key  TEXT NOT NULL,
        metric_key    TEXT NOT NULL,
        window_start  INTEGER NOT NULL,
        window_end    INTEGER NOT NULL,
        value         TEXT NOT NULL,
        status        TEXT NOT NULL DEFAULT 'pending',
        attempts      INTEGER NOT NULL DEFAULT 0,
        last_error    TEXT,
        created_at    INTEGER NOT NULL,
        invoiced_at   INTEGER,
        invoice_key   TEXT,
        UNIQUE (source_id, metric_key, window_start, part)
      );
      CREATE INDEX IF NOT EXISTS idx_metrics_status
        ON metrics (status, window_start);

      -- Plans an invoice run committed to; removed once their spend is parked.
      CREATE TABLE IF NOT EXISTS invoice_claim (
        key             TEXT PRIMARY KEY,
        payee           TEXT NOT NULL,
        period_start    INTEGER NOT NULL,
        amount          TEXT NOT NULL,
        spender_payload TEXT NOT NULL
      );

      -- The network's check_agent_exists answers, per agent key.
      CREATE TABLE IF NOT EXISTS agent_presence (
        agent_id   TEXT PRIMARY KEY,
        presence   TEXT,
        checks     INTEGER NOT NULL DEFAULT 0,
        checked_at INTEGER,
        first_skipped_window INTEGER
      );
    `);
  }

  async upsertMetrics(records: MetricRecord[]): Promise<MetricUpsertResult> {
    const invoicedSum = this.#db.prepare(`
      SELECT value FROM metrics WHERE source_id = ? AND metric_key = ?
        AND window_start = ? AND status IN ('invoiced', 'parking')
    `);
    const pendingRow = this.#db.prepare(`
      SELECT id, value FROM metrics WHERE source_id = ? AND metric_key = ?
        AND window_start = ? AND status = 'pending'
    `);
    const nextPart = this.#db.prepare(`
      SELECT COALESCE(MAX(part), -1) + 1 AS part FROM metrics
      WHERE source_id = ? AND metric_key = ? AND window_start = ?
    `);
    const insert = this.#db.prepare(`
      INSERT INTO metrics (
        source_id, part, unyt_pub_key, metric_key, window_start, window_end,
        value, status, attempts, last_error, created_at, invoiced_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const update = this.#db.prepare(
      `UPDATE metrics SET value = ?, window_end = ? WHERE id = ?`,
    );
    const remove = this.#db.prepare(`DELETE FROM metrics WHERE id = ?`);
    const result: MetricUpsertResult = { inserted: 0, updated: 0, skipped: 0 };
    this.#db.prepare("BEGIN").run();
    try {
      for (const m of records) {
        const key = [m.sourceId, m.metricKey, m.windowStart] as const;
        const covered = (invoicedSum.all(...key) as { value: string }[]).reduce(
          (n, r) => n + BigInt(r.value),
          0n,
        );
        const owed = BigInt(m.value) - covered;
        const pending = pendingRow.get(...key) as
          { id: number; value: string } | undefined;
        if (pending) {
          if (owed <= 0n) {
            remove.run(pending.id);
            result.updated++;
          } else if (BigInt(pending.value) !== owed) {
            update.run(owed.toString(), m.windowEnd, pending.id);
            result.updated++;
          } else {
            result.skipped++;
          }
        } else if (owed > 0n) {
          const { part } = nextPart.get(...key) as { part: number };
          insert.run(
            m.sourceId,
            part,
            m.unytPubKey,
            m.metricKey,
            m.windowStart,
            m.windowEnd,
            owed.toString(),
            "pending",
            m.attempts,
            m.lastError,
            m.createdAt,
            null,
          );
          result.inserted++;
        } else {
          result.skipped++;
        }
      }
      this.#db.prepare("COMMIT").run();
    } catch (err) {
      this.#db.prepare("ROLLBACK").run();
      throw err;
    }
    return result;
  }

  async claimPlan(
    claim: Omit<InvoiceClaim, "recordIds"> & {
      rows: Array<{ id: number; value: string }>;
    },
  ): Promise<boolean> {
    const current = this.#db.prepare(
      `SELECT status, value FROM metrics WHERE id = ?`,
    );
    const claimRow = this.#db.prepare(
      `UPDATE metrics SET status = 'parking', invoice_key = ? WHERE id = ?`,
    );
    this.#db.prepare("BEGIN").run();
    try {
      for (const r of claim.rows) {
        const row = current.get(r.id) as
          { status: string; value: string } | undefined;
        if (row?.status !== "pending" || row.value !== r.value) {
          this.#db.prepare("ROLLBACK").run();
          return false;
        }
      }
      this.#db
        .prepare(
          `INSERT INTO invoice_claim (key, payee, period_start, amount, spender_payload)
           VALUES (?, ?, ?, ?, ?)`,
        )
        .run(
          claim.key,
          claim.payee,
          claim.periodStart,
          JSON.stringify(claim.amount),
          JSON.stringify(claim.spenderPayload),
        );
      for (const r of claim.rows) claimRow.run(claim.key, r.id);
      this.#db.prepare("COMMIT").run();
      return true;
    } catch (err) {
      this.#db.prepare("ROLLBACK").run();
      throw err;
    }
  }

  async claimedPlans(): Promise<InvoiceClaim[]> {
    const claims = this.#db
      .prepare(`SELECT * FROM invoice_claim ORDER BY period_start, key`)
      .all() as Record<string, unknown>[];
    const ids = this.#db.prepare(
      `SELECT id FROM metrics WHERE invoice_key = ? AND status = 'parking' ORDER BY id`,
    );
    return claims.map((c) => ({
      key: c.key as string,
      payee: c.payee as string,
      periodStart: c.period_start as number,
      amount: JSON.parse(c.amount as string),
      spenderPayload: JSON.parse(c.spender_payload as string),
      recordIds: (ids.all(c.key as string) as { id: number }[]).map(
        (r) => r.id,
      ),
    }));
  }

  async markClaimInvoiced(key: string, invoicedAt: number): Promise<void> {
    this.#db.prepare("BEGIN").run();
    try {
      this.#db
        .prepare(
          `UPDATE metrics SET status = 'invoiced', invoiced_at = ?
           WHERE invoice_key = ? AND status = 'parking'`,
        )
        .run(invoicedAt, key);
      this.#db.prepare(`DELETE FROM invoice_claim WHERE key = ?`).run(key);
      this.#db.prepare("COMMIT").run();
    } catch (err) {
      this.#db.prepare("ROLLBACK").run();
      throw err;
    }
  }

  async getAgentPresence(agentId: string): Promise<AgentPresenceRow | null> {
    const row = this.#db
      .prepare(`SELECT * FROM agent_presence WHERE agent_id = ?`)
      .get(agentId) as Record<string, unknown> | undefined;
    if (!row) return null;
    return {
      presence: (row.presence as AgentPresence | null) ?? null,
      checks: row.checks as number,
      checkedAt: (row.checked_at as number | null) ?? null,
      firstSkippedWindow: (row.first_skipped_window as number | null) ?? null,
    };
  }

  async noteSkippedWindow(agentId: string, windowStart: number): Promise<void> {
    this.#db
      .prepare(
        `INSERT INTO agent_presence (agent_id, first_skipped_window) VALUES (?, ?)
         ON CONFLICT(agent_id) DO UPDATE SET first_skipped_window =
           MIN(COALESCE(agent_presence.first_skipped_window, excluded.first_skipped_window),
               excluded.first_skipped_window)`,
      )
      .run(agentId, windowStart);
  }

  async skippedAgents(): Promise<string[]> {
    return (
      this.#db
        .prepare(
          `SELECT agent_id FROM agent_presence
           WHERE first_skipped_window IS NOT NULL ORDER BY agent_id`,
        )
        .all() as { agent_id: string }[]
    ).map((r) => r.agent_id);
  }

  async clearSkippedWindow(agentId: string): Promise<void> {
    this.#db
      .prepare(
        `UPDATE agent_presence SET first_skipped_window = NULL WHERE agent_id = ?`,
      )
      .run(agentId);
  }

  async setAgentPresence(
    agentId: string,
    present: boolean,
    checkedAt: number,
  ): Promise<void> {
    this.#db
      .prepare(
        `INSERT INTO agent_presence (agent_id, presence, checks, checked_at)
         VALUES (?, ?, 1, ?)
         ON CONFLICT(agent_id) DO UPDATE SET
           presence = excluded.presence,
           checks = agent_presence.checks + 1,
           checked_at = excluded.checked_at`,
      )
      .run(agentId, present ? "present" : "absent", checkedAt);
  }

  async pendingMetrics(limit = 500): Promise<MetricRecord[]> {
    const rows = this.#db
      .prepare(
        `SELECT * FROM metrics WHERE status = 'pending'
         ORDER BY window_start ASC, id ASC LIMIT ?`,
      )
      .all(limit) as Record<string, unknown>[];
    return rows.map(rowToMetric);
  }

  async markInvoiced(ids: number[], invoicedAt: number): Promise<void> {
    if (ids.length === 0) {
      return;
    }
    const placeholders = ids.map(() => "?").join(",");
    this.#db
      .prepare(
        `UPDATE metrics SET status = 'invoiced', invoiced_at = ?
         WHERE id IN (${placeholders})`,
      )
      .run(invoicedAt, ...ids);
  }

  async markFailed(id: number, error: string): Promise<void> {
    // Stays 'pending' so the next dispatch retries it; attempts/last_error
    // record the trouble for ops.
    this.#db
      .prepare(
        `UPDATE metrics SET attempts = attempts + 1, last_error = ? WHERE id = ?`,
      )
      .run(error, id);
  }

  async recentlyInvoiced(
    opts: { since?: number; limit?: number } = {},
  ): Promise<MetricRecord[]> {
    const since = opts.since ?? 0;
    const limit = opts.limit ?? 100;
    const rows = this.#db
      .prepare(
        `SELECT * FROM metrics WHERE status = 'invoiced' AND invoiced_at >= ?
         ORDER BY invoiced_at DESC, id DESC LIMIT ?`,
      )
      .all(since, limit) as Record<string, unknown>[];
    return rows.map(rowToMetric);
  }

  async metricsSummary(): Promise<MetricsSummary> {
    const count = (sql: string): number =>
      Number((this.#db.prepare(sql).get() as { c: number }).c);
    const lastInvoiced = this.#db
      .prepare(
        `SELECT MAX(invoiced_at) m FROM metrics WHERE status = 'invoiced'`,
      )
      .get() as { m: number | null };
    return {
      pending: count(`SELECT COUNT(*) c FROM metrics WHERE status = 'pending'`),
      invoiced: count(
        `SELECT COUNT(*) c FROM metrics WHERE status = 'invoiced'`,
      ),
      failed: count(
        `SELECT COUNT(*) c FROM metrics WHERE status = 'pending' AND attempts > 0`,
      ),
      lastProcessedWindow: await this.lastProcessedWindow(),
      lastInvoicedAt: lastInvoiced.m ?? null,
    };
  }

  async lastProcessedWindow(): Promise<number> {
    const row = this.#db
      .prepare(`SELECT value FROM meta WHERE key = 'last_processed_window'`)
      .get() as { value: string } | undefined;
    return row ? Number(row.value) : 0;
  }

  async setLastProcessedWindow(windowStart: number): Promise<void> {
    this.#db
      .prepare(
        `INSERT INTO meta (key, value) VALUES ('last_processed_window', ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      )
      .run(String(windowStart));
  }

  async getMeta(key: string): Promise<string | undefined> {
    const row = this.#db
      .prepare(`SELECT value FROM meta WHERE key = ?`)
      .get(key) as { value: string } | undefined;
    return row?.value;
  }

  async setMeta(key: string, value: string): Promise<void> {
    this.#db
      .prepare(
        `INSERT INTO meta (key, value) VALUES (?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      )
      .run(key, value);
  }

  async close(): Promise<void> {
    this.#db.close();
  }
}

function rowToMetric(row: Record<string, unknown>): MetricRecord {
  return {
    id: row.id as number,
    sourceId: row.source_id as string,
    unytPubKey: row.unyt_pub_key as string,
    metricKey: row.metric_key as string,
    windowStart: row.window_start as number,
    windowEnd: row.window_end as number,
    value: row.value as string,
    status: row.status as MetricRecord["status"],
    attempts: row.attempts as number,
    lastError: (row.last_error as string | null) ?? null,
    createdAt: row.created_at as number,
    invoicedAt: (row.invoiced_at as number | null) ?? null,
  };
}
