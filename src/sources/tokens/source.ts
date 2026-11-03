import { DatabaseSync } from "node:sqlite";
import { existsSync, readFileSync } from "node:fs";
import { IngestResult, Measurement, Source } from "../source.js";
import { parseTokenLine } from "./log.js";

export const TOKEN_METRICS = {
  input: "inputTokens",
  output: "outputTokens",
} as const;

export interface TokenSourceOptions {
  /** SQLite file for the request table (the harvester's store file is fine). */
  dbPath: string;
  /** The JSON-lines usage log to read. */
  logPath: string;
  log?: (msg: string) => void;
}

/**
 * Source of truth for LLM token use: a usage log the payer's own gateway
 * writes. Each ingest reads the log from where the last one stopped and
 * stores each request once, by its id.
 */
export function tokenSource(opts: TokenSourceOptions): Source {
  const db = new DatabaseSync(opts.dbPath);
  const log = opts.log ?? (() => {});
  db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS token_request (
      id                TEXT PRIMARY KEY,
      ts                INTEGER NOT NULL,
      operator          TEXT NOT NULL,
      model             TEXT NOT NULL,
      prompt_tokens     INTEGER NOT NULL,
      completion_tokens INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_token_request_ts ON token_request (ts);
    CREATE TABLE IF NOT EXISTS token_log_cursor (
      path   TEXT PRIMARY KEY,
      offset INTEGER NOT NULL
    );
  `);

  return {
    name: "tokens",

    async ingest(): Promise<IngestResult> {
      const result: IngestResult = { inserted: 0, ignored: 0, earliest: null };
      if (!existsSync(opts.logPath)) {
        log(`tokens: ${opts.logPath} does not exist yet`);
        return result;
      }
      const bytes = readFileSync(opts.logPath);
      const row = db
        .prepare(`SELECT offset FROM token_log_cursor WHERE path = ?`)
        .get(opts.logPath) as { offset: number } | undefined;
      // A log shorter than the cursor was replaced; read it from the start.
      // Request ids keep the re-read from counting anything twice.
      const start = row && row.offset <= bytes.length ? row.offset : 0;
      // Only complete lines; a line still being written is read next time.
      const end = bytes.lastIndexOf(0x0a) + 1;
      if (end <= start) return result;

      const insert = db.prepare(`
        INSERT OR IGNORE INTO token_request
          (id, ts, operator, model, prompt_tokens, completion_tokens)
        VALUES (?, ?, ?, ?, ?, ?)
      `);
      db.exec("BEGIN");
      try {
        const lines = bytes.subarray(start, end).toString("utf8").split("\n");
        for (const text of lines) {
          if (!text.trim()) continue;
          const r = parseTokenLine(text);
          if (r instanceof Error) {
            log(`tokens: skipping bad line: ${r.message}`);
            continue;
          }
          const info = insert.run(
            r.id,
            r.ts,
            r.operator,
            r.model,
            r.promptTokens,
            r.completionTokens,
          );
          if (Number(info.changes) > 0) {
            result.inserted++;
            result.earliest =
              result.earliest === null ? r.ts : Math.min(result.earliest, r.ts);
          } else {
            result.ignored++;
          }
        }
        db.prepare(
          `INSERT INTO token_log_cursor (path, offset) VALUES (?, ?)
           ON CONFLICT(path) DO UPDATE SET offset = excluded.offset`,
        ).run(opts.logPath, end);
        db.exec("COMMIT");
      } catch (err) {
        db.exec("ROLLBACK");
        throw err;
      }
      return result;
    },

    async measure(windowStart: number, windowEnd: number) {
      const rows = db
        .prepare(
          `SELECT operator,
                  SUM(prompt_tokens) AS input,
                  SUM(completion_tokens) AS output
           FROM token_request WHERE ts >= ? AND ts < ?
           GROUP BY operator ORDER BY operator`,
        )
        .all(windowStart, windowEnd) as {
        operator: string;
        input: number;
        output: number;
      }[];
      const out: Measurement[] = [];
      for (const r of rows) {
        for (const [metricKey, value] of [
          [TOKEN_METRICS.input, r.input],
          [TOKEN_METRICS.output, r.output],
        ] as const) {
          if (value > 0) {
            out.push({
              sourceId: r.operator,
              operatorKey: r.operator,
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

    async close() {
      db.close();
    },
  };
}
