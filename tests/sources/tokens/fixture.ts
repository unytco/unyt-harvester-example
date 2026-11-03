import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const ALICE = "uhCAkEgwsRQmYpVUGWSdNyziQgQZu1sfXVlVIR0sbEZJBd5N6wYr_";
export const BOB = "uhCAkPXBHhz7XY3hFJJUoqxC73V5xQs_WX5FWfC7MidwR1-ijNXVL";

export const MINUTE = 60_000;

export function tempLog(): string {
  return join(mkdtempSync(join(tmpdir(), "tokens-")), "usage.jsonl");
}

export function line(
  id: string,
  ts: number,
  operator: string,
  prompt: number,
  completion: number,
): string {
  return (
    JSON.stringify({
      id,
      ts,
      operator,
      model: "sample-model",
      usage: { prompt_tokens: prompt, completion_tokens: completion },
    }) + "\n"
  );
}
