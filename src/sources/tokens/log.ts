/**
 * The synthetic token-use log: one JSON object per line, one line per LLM
 * request, with the `usage` block in the OpenAI API format:
 *
 *   {"id":"req-1","ts":1730000000000,"operator":"uhCAk…","model":"m",
 *    "usage":{"prompt_tokens":120,"completion_tokens":48}}
 *
 * `operator` is the Unyt AgentPubKey of whoever served the request.
 */
export interface TokenRequest {
  id: string;
  /** ms epoch when the request was served. */
  ts: number;
  operator: string;
  model: string;
  promptTokens: number;
  completionTokens: number;
}

export function parseTokenLine(line: string): TokenRequest | Error {
  let data: unknown;
  try {
    data = JSON.parse(line);
  } catch (err) {
    return new Error(`not JSON: ${(err as Error).message}`);
  }
  if (!data || typeof data !== "object") return new Error("not an object");
  const d = data as Record<string, unknown>;
  const usage = (d.usage ?? {}) as Record<string, unknown>;
  if (typeof d.id !== "string" || !d.id) return new Error("id missing");
  if (!Number.isInteger(d.ts)) return new Error("ts must be an integer");
  if (typeof d.operator !== "string") return new Error("operator missing");
  for (const field of ["prompt_tokens", "completion_tokens"]) {
    const n = usage[field];
    if (!Number.isInteger(n) || (n as number) < 0) {
      return new Error(`usage.${field} must be a non-negative integer`);
    }
  }
  return {
    id: d.id,
    ts: d.ts as number,
    operator: d.operator,
    model: typeof d.model === "string" ? d.model : "",
    promptTokens: usage.prompt_tokens as number,
    completionTokens: usage.completion_tokens as number,
  };
}
