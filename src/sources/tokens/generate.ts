import { writeFileSync } from "node:fs";

export interface GenerateOptions {
  /** Log file to write (replaced). */
  path: string;
  /** Unyt AgentPubKeys of the operators serving requests. */
  operators: string[];
  /** ms epoch of the first minute. */
  start: number;
  minutes: number;
  requestsPerMinute: number;
  /** Same seed, same log. */
  seed: number;
}

const MODELS = ["sample-small", "sample-large"];

/** Small seeded PRNG (mulberry32), so a rehearsal is repeatable. */
function random(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Write a synthetic token-use log: `requestsPerMinute` requests in each of
 * `minutes` minutes, each served by a random operator.
 */
export function generateTokens(opts: GenerateOptions): void {
  const next = random(opts.seed);
  const between = (low: number, high: number) =>
    low + Math.floor(next() * (high - low + 1));
  const lines: string[] = [];
  for (let minute = 0; minute < opts.minutes; minute++) {
    for (let n = 0; n < opts.requestsPerMinute; n++) {
      const ts = opts.start + minute * 60_000 + Math.floor(next() * 60_000);
      lines.push(
        JSON.stringify({
          id: `req-${opts.seed}-${minute}-${n}`,
          ts,
          operator: opts.operators[between(0, opts.operators.length - 1)],
          model: MODELS[between(0, MODELS.length - 1)],
          usage: {
            prompt_tokens: between(50, 2000),
            completion_tokens: between(10, 800),
          },
        }),
      );
    }
  }
  writeFileSync(opts.path, lines.join("\n") + "\n");
}
