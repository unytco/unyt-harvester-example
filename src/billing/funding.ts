/**
 * HF-cost math for a parked invoice.
 *
 * Parking an invoice consumes no HF — it carries the *measures* (unit
 * counts). HF is spent later, at execute time, when the agreement's price
 * sheet converts them into HoloFuel:
 *
 *   HF = sum over units of count * micro_hf_per_unit / 10^6
 *
 * These helpers price a plan's `amount` map (unit index → integer measure) so a
 * dry-run can report the HF obligation the parked invoices will incur, and
 * whether the funding covers it. To stay exact without floating point, all HF
 * amounts here are computed in "micro-HF" — HF scaled by 10^6, matching the HF
 * unit's precision — as bigint. Format back to a decimal HF string with
 * `microToHf` for display.
 */

/** HF is stored with 6 decimal places; internal arithmetic uses HF*10^6. */
const HF_DECIMALS = 6;

/**
 * The network's spender fee on an HF spend, from the global definition's
 * `unit_fees`: `spender_pay_percent` as a fraction, `fee_cap` in micro-HF, and
 * whether the connected agent is exempt.
 */
export interface FeeTerms {
  numerator: bigint;
  denominator: bigint;
  capMicro?: bigint;
  exempt?: boolean;
}

/** The fee terms assumed when the global definition cannot be read: 1%. */
export const ASSUMED_FEE: FeeTerms = { numerator: 1n, denominator: 100n };

/**
 * The fee the network charges on spending `spendMicro`: the percent rounded up
 * on any remainder (as `ZFuel * Fraction` does), then capped.
 */
export function feeMicro(spendMicro: bigint, fee: FeeTerms): bigint {
  if (fee.exempt || spendMicro <= 0n || fee.numerator <= 0n) return 0n;
  const product = spendMicro * fee.numerator;
  let out = product / fee.denominator;
  if (product % fee.denominator !== 0n) out += 1n;
  if (fee.capMicro !== undefined && out > fee.capMicro) out = fee.capMicro;
  return out;
}
const HF_SCALE = 1_000_000n;

/** Resolved pricing for one agreement (from `hcReadFunding`). */
export interface HfPricing {
  /** micro-HF paid per unit, by unit index (stringified). */
  microHfPerUnit: Record<string, bigint>;
}

/** Parse a non-negative decimal string into `mantissa * 10^-decimals`. */
function decimalParts(value: string): { mantissa: bigint; decimals: number } {
  const [intPart, fracPart = ""] = value.trim().split(".");
  const digits = (intPart + fracPart).replace(/\s/g, "") || "0";
  return { mantissa: BigInt(digits), decimals: fracPart.length };
}

/** micro-HF for a decimal HF string (a ZFuel amount). */
export function hfToMicro(value: string): bigint {
  const { mantissa, decimals } = decimalParts(value);
  if (decimals <= HF_DECIMALS) {
    return mantissa * 10n ** BigInt(HF_DECIMALS - decimals);
  }
  const denominator = 10n ** BigInt(decimals - HF_DECIMALS);
  return (mantissa + denominator / 2n) / denominator;
}

/** Format a micro-HF bigint back to a trimmed decimal HF string. */
export function microToHf(micro: bigint): string {
  const negative = micro < 0n;
  const abs = negative ? -micro : micro;
  const whole = abs / HF_SCALE;
  const frac = abs % HF_SCALE;
  let out = whole.toString();
  if (frac > 0n) {
    out += "." + frac.toString().padStart(HF_DECIMALS, "0").replace(/0+$/, "");
  }
  return negative ? "-" + out : out;
}

export interface RaveLike {
  executed_timestamp: number;
  output: { locked?: Record<string, string | number> };
}

/** HF the newest execution holds back for the next one; "0" if none. */
export function latestLockedHf(raves: RaveLike[], hfIndex: string): string {
  const newest = raves.reduce<RaveLike | undefined>(
    (best, r) =>
      !best || r.executed_timestamp > best.executed_timestamp ? r : best,
    undefined,
  );
  const v = newest?.output.locked?.[hfIndex];
  return v === undefined ? "0" : String(v);
}

/**
 * micro-HF an invoice `amount` (unit index → integer measure) will cost at
 * execute time under `pricing`, exactly as the template computes it. Units the
 * price sheet does not price contribute nothing.
 */
export function hfCostMicro(
  amount: { [unitIndex: string]: string },
  pricing: HfPricing,
): bigint {
  let total = 0n;
  for (const [unit, measured] of Object.entries(amount)) {
    total += BigInt(measured) * (pricing.microHfPerUnit[unit] ?? 0n);
  }
  return total;
}

/** Total micro-HF parked as funding across all its (positive) allocations. */
export function fundingTotalMicro(allocations: string[]): bigint {
  return allocations.reduce((sum, a) => sum + hfToMicro(a), 0n);
}

/**
 * Largest single funding allocation, in micro-HF. At execute time each invoice
 * payload is paid from *one* allocation, so this — not the total — is what a
 * single payload's HF must fit within. `0n` if there are no allocations.
 */
export function fundingLargestMicro(allocations: string[]): bigint {
  return allocations.reduce((max, a) => {
    const v = hfToMicro(a);
    return v > max ? v : max;
  }, 0n);
}
