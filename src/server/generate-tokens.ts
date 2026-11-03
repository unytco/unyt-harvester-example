import { parseArgs } from "node:util";
import { generateTokens } from "../sources/tokens/generate.js";

/**
 * Write a synthetic token-use log for the given operators.
 *
 *   npm run generate-tokens -- --operator uhCAk... --operator uhCAk... \
 *     --minutes 3 --per-minute 20 --seed 1 --out token-usage.jsonl
 *
 * `--start` (ms epoch) defaults to the start of the minute `--minutes` ago,
 * so the whole log falls in already-elapsed windows.
 */
export function generateTokensCli(): void {
  const { values } = parseArgs({
    options: {
      operator: { type: "string", multiple: true },
      minutes: { type: "string", default: "3" },
      "per-minute": { type: "string", default: "20" },
      seed: { type: "string", default: "1" },
      start: { type: "string" },
      out: { type: "string", default: "token-usage.jsonl" },
    },
  });
  const operators = values.operator ?? [];
  if (operators.length === 0) {
    throw new Error("at least one --operator <agent key> is required");
  }
  const minutes = Number(values.minutes);
  const start =
    values.start !== undefined
      ? Number(values.start)
      : Math.floor(Date.now() / 60_000) * 60_000 - minutes * 60_000;
  generateTokens({
    path: values.out,
    operators,
    start,
    minutes,
    requestsPerMinute: Number(values["per-minute"]),
    seed: Number(values.seed),
  });
  console.log(`wrote ${values.out}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    generateTokensCli();
  } catch (err) {
    console.error(err);
    process.exit(1);
  }
}
