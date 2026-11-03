/**
 * Attribution + null handling.
 *
 * Every metric must carry a `unytPubKey` so the right Unyt agent is
 * paid. A source record with no resolvable key — none reported, one
 * that doesn't parse as a Holochain agent key, or one the network this
 * pipeline runs on does not hold — is **skipped and logged**, never thrown:
 * one unattributable record must not abort the whole run. This is the single
 * choke point every record passes through before formatting.
 */

/**
 * A Holochain `AgentPubKey` in its multibase-base64url string form: the byte
 * `u` prefix, then the 39-byte holo_hash (3-byte AgentPubKey prefix `0x842024`
 * + 32-byte key + 4-byte DHT location) as base64url — 53 chars, `uhCAk…`.
 */
const AGENT_KEY_RE = /^uhCAk[A-Za-z0-9_-]{48}$/;

/**
 * Does `s` look like a Holochain AgentPubKey? A shape check on the string form
 * (prefix + length + base64url charset), not a cryptographic validation — it's
 * enough to reject a placeholder like `"test-value"` or a truncated key from
 * ever being attributed to.
 */
export function isValidAgentKey(s: string): boolean {
  return AGENT_KEY_RE.test(s);
}

export interface Attributable {
  sourceId: string;
  /** The Unyt Agent ID as the source reports it, if any. May be malformed —
   * attribution validates it before use. */
  unytAgentId?: string | null;
  /**
   * Whether the unyt network this pipeline runs on holds the key, per the
   * app's `check_agent_exists`. `false` skips the record: a source may serve
   * several networks, and another network's harvester pays it.
   * Undefined means unchecked, which attributes as before.
   */
  onNetwork?: boolean;
}

/** Why a record couldn't be attributed — for a specific skip log. */
export type SkipReason = "missing" | "malformed" | "foreign";

/**
 * Resolve a node's attribution key (the `unytPubKey`) from its reported Unyt
 * Agent ID. Returns the key when it's present, well-formed and not known to be
 * off this network, otherwise `null` with the reason: `missing` (nothing
 * reported), `malformed` (reported but not a valid agent key) or `foreign`
 * (the network does not hold it). A `null` return means the record is dropped
 * downstream — we never attribute a metric to a source id or a placeholder.
 */
export function resolveUnytPubKey(n: Attributable): {
  key: string | null;
  reason?: SkipReason;
} {
  const raw = n.unytAgentId?.trim();
  if (!raw) {
    return { key: null, reason: "missing" };
  }
  if (!isValidAgentKey(raw)) {
    return { key: null, reason: "malformed" };
  }
  if (n.onNetwork === false) {
    return { key: null, reason: "foreign" };
  }
  return { key: raw };
}

/**
 * Partition attributable items into those with a valid key (annotated with
 * `unytPubKey`) and those skipped. Logs each skip with its reason; never throws.
 */
export function attributeOrSkip<T extends Attributable>(
  items: T[],
  log: (msg: string) => void = () => {},
): { kept: Array<T & { unytPubKey: string }>; skipped: T[] } {
  const kept: Array<T & { unytPubKey: string }> = [];
  const skipped: T[] = [];
  for (const item of items) {
    const { key, reason } = resolveUnytPubKey(item);
    if (key) {
      kept.push({ ...item, unytPubKey: key });
    } else {
      skipped.push(item);
      const detail =
        reason === "malformed"
          ? `malformed Unyt agent key ${JSON.stringify(item.unytAgentId)}`
          : reason === "foreign"
            ? `Unyt agent key ${item.unytAgentId} is not on this network`
            : "no Unyt agent key";
      log(`null-guard: skipping ${item.sourceId || "(no id)"} — ${detail}`);
    }
  }
  return { kept, skipped };
}
