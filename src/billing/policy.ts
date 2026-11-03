/**
 * Billing policy — the configurable business decision of *what* we actually
 * invoice for, and how each captured metric maps onto an agreement price-sheet
 * unit.
 *
 * The policy is data, not code: it is loaded from an editable JSON file
 * (`POLICY_PATH`) so the decision can change over time without a redeploy. It is
 * applied at invoice time to *not-yet-invoiced* periods only, so changing it
 * never rewrites an already-parked invoice — history is whatever policy was in
 * force when the period was invoiced. The active policy `version` is stamped
 * into each spend's payload for audit.
 */

/** How one captured metric key contributes to an invoice. */
export interface BillingRule {
  /** The aggregated metric key, e.g. "inputTokens". */
  metricKey: string;
  /** Symbol of the lane unit this metric is billed under, e.g. "TOKIN". */
  unitSymbol: string;
  /**
   * Integer multiplier applied to the raw aggregated value before billing
   * (default 1). Kept integer to stay bigint-safe: the measure billed onto a
   * unit is always an integer count. Fractional pricing lives on the
   * agreement's price sheet (HF per unit), not here. Several keys may map to
   * one unit, in which case their scaled values sum.
   */
  scale?: number;
  /** Set false to capture-but-not-bill a metric. Default true. */
  include?: boolean;
}

/** The complete invoicing policy. */
export interface BillingPolicy {
  /** Opaque version/label recorded with every invoice for audit. */
  version: string;
  /** Capability role id authorized to create the parked spend. */
  ctRoleId: string;
  /** One rule per metric key we know about. */
  rules: BillingRule[];
}

/** A rule whose unit symbol has been looked up on the network. */
export interface ResolvedRule extends BillingRule {
  unitIndex: number;
}

/** A policy whose unit symbols have been looked up on the network. */
export interface ResolvedPolicy extends BillingPolicy {
  rules: ResolvedRule[];
}

/**
 * Default policy: bill input and output tokens as raw counts. The HF each
 * token costs is set by the agreement's price sheet, not by this policy.
 */
export const DEFAULT_POLICY: BillingPolicy = {
  version: "default-1",
  ctRoleId: "invoicer",
  rules: [
    { metricKey: "inputTokens", unitSymbol: "TOKIN", scale: 1, include: true },
    {
      metricKey: "outputTokens",
      unitSymbol: "TOKOUT",
      scale: 1,
      include: true,
    },
  ],
};

/**
 * Attach each rule's unit index. Indices are assigned when a unit is
 * registered and differ between networks, so they are read from the network
 * (`hcUnitIndexBySymbol`) rather than written into the policy.
 */
export function resolveRuleUnits(
  policy: BillingPolicy,
  unitIndexBySymbol: Map<string, number>,
): ResolvedPolicy {
  return {
    ...policy,
    rules: policy.rules.map((r) => {
      const unitIndex = unitIndexBySymbol.get(r.unitSymbol);
      if (unitIndex === undefined) {
        throw new Error(
          `unknown unit symbol ${r.unitSymbol} (network has: ${[
            ...unitIndexBySymbol.keys(),
          ].join(", ")})`,
        );
      }
      return { ...r, unitIndex };
    }),
  };
}

/**
 * Load the billing policy from `path` (JSON), or return `DEFAULT_POLICY` when no
 * path is given. Throws if the file is present but malformed — a billing config
 * error should fail loudly, not silently fall back.
 */
export async function loadPolicy(path?: string): Promise<BillingPolicy> {
  if (!path) {
    return DEFAULT_POLICY;
  }
  const { readFile } = await import("node:fs/promises");
  const raw = await readFile(path, "utf8");
  return validatePolicy(JSON.parse(raw));
}

/** Validate a parsed object as a BillingPolicy, throwing on any problem. */
export function validatePolicy(data: unknown): BillingPolicy {
  if (!data || typeof data !== "object") {
    throw new Error("policy must be a JSON object");
  }
  const p = data as Record<string, unknown>;
  if (typeof p.version !== "string" || !p.version) {
    throw new Error("policy.version must be a non-empty string");
  }
  if (typeof p.ctRoleId !== "string" || !p.ctRoleId) {
    throw new Error("policy.ctRoleId must be a non-empty string");
  }
  if (!Array.isArray(p.rules) || p.rules.length === 0) {
    throw new Error("policy.rules must be a non-empty array");
  }
  const seen = new Set<string>();
  const rules: BillingRule[] = p.rules.map((r, i) => {
    if (!r || typeof r !== "object") {
      throw new Error(`policy.rules[${i}] must be an object`);
    }
    const rule = r as Record<string, unknown>;
    if (typeof rule.metricKey !== "string" || !rule.metricKey) {
      throw new Error(
        `policy.rules[${i}].metricKey must be a non-empty string`,
      );
    }
    if (seen.has(rule.metricKey)) {
      throw new Error(`policy.rules: duplicate metricKey "${rule.metricKey}"`);
    }
    seen.add(rule.metricKey);
    if (typeof rule.unitSymbol !== "string" || !rule.unitSymbol) {
      throw new Error(
        `policy.rules[${i}].unitSymbol must be a non-empty string`,
      );
    }
    const scale = rule.scale ?? 1;
    if (!Number.isInteger(scale) || (scale as number) < 0) {
      throw new Error(
        `policy.rules[${i}].scale must be a non-negative integer`,
      );
    }
    const include = rule.include ?? true;
    if (typeof include !== "boolean") {
      throw new Error(`policy.rules[${i}].include must be a boolean`);
    }
    return {
      metricKey: rule.metricKey,
      unitSymbol: rule.unitSymbol,
      scale: scale as number,
      include,
    };
  });
  return { version: p.version, ctRoleId: p.ctRoleId, rules };
}

/**
 * Apply the policy to one payee's summed metric totals for a period, producing
 * the parked-spend `amount` map (unit index → stringified integer). Each measure
 * is billed as its raw aggregated count times the rule's
 * integer `scale`; the fractional HF a second costs is applied later by the
 * agreement's price sheet at execute time, not here. Excluded or unknown metric
 * keys contribute nothing; zero-valued units are omitted so an idle payee yields
 * an empty map (and is then skipped — no DHT commit).
 */
export function applyPolicy(
  policy: ResolvedPolicy,
  totals: { [metricKey: string]: bigint },
): { [unitIndex: string]: string } {
  const byUnit = new Map<number, bigint>();
  for (const rule of policy.rules) {
    if (rule.include === false) {
      continue;
    }
    const raw = totals[rule.metricKey];
    if (raw === undefined || raw <= 0n) {
      continue;
    }
    const scaled = raw * BigInt(rule.scale ?? 1);
    if (scaled <= 0n) {
      continue;
    }
    byUnit.set(rule.unitIndex, (byUnit.get(rule.unitIndex) ?? 0n) + scaled);
  }
  const amount: { [unitIndex: string]: string } = {};
  for (const [unitIndex, value] of byUnit) {
    amount[String(unitIndex)] = value.toString();
  }
  return amount;
}
