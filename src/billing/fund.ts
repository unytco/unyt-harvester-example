import {
  ASSUMED_FEE,
  FeeTerms,
  feeMicro,
  hfToMicro,
  microToHf,
} from "./funding.js";
import { AgreementBalances, ParkedSpend } from "../holochain/hc-client.js";

/** Role under which the harvester agent parks HF that funds the agreement. */
export const FUNDER_ROLE = "funder";

export interface FundInput {
  availableMicro: bigint; // parked + locked
  minMicro: bigint;
  topUpMicro: bigint;
  balanceMicro: bigint;
  /** The agent's HF credit limit; a park may take the balance down to -credit. */
  creditMicro?: bigint;
  /** The HF spender fee; 1% is assumed when unknown. */
  fee?: FeeTerms;
  /** Decimal places the HF unit allows; micro-HF when unknown. */
  precision?: number;
}
export interface FundDecision {
  /** micro-HF to park now; 0n when nothing is needed or nothing is available. */
  parkMicro: bigint;
}

/**
 * The most `spendableMicro` (the balance plus any credit limit) can park once
 * the network's spender fee on that park is paid from it too, rounded down to
 * the unit's precision. A park whose fee goes past it is refused.
 */
export function parkableMicro(
  balanceMicro: bigint,
  fee: FeeTerms = ASSUMED_FEE,
  precision = 6,
): bigint {
  if (balanceMicro <= 0n) return 0n;
  const fits = (park: bigint) => park + feeMicro(park, fee) <= balanceMicro;
  // Candidates for the largest fitting park: the whole balance (no fee), the
  // balance less the cap (capped fee), the balance split by the percent.
  const candidates = [
    balanceMicro,
    (balanceMicro * fee.denominator) / (fee.denominator + fee.numerator),
  ];
  if (fee.capMicro !== undefined) candidates.push(balanceMicro - fee.capMicro);
  const step = 10n ** BigInt(6 - precision);
  let best = 0n;
  for (let park of candidates) {
    park -= park % step;
    // The percent rounds up, so a split can overshoot by one step at most.
    while (park > 0n && !fits(park)) park -= step;
    if (park > best) best = park;
  }
  return best;
}

/**
 * Park the top-up when the agreement's available HF is below the floor, but
 * never more than the agent can pay with the fee on it: an over-sized park
 * fails validation and would block the invoice run that triggered it.
 */
export function decideFunding(i: FundInput): FundDecision {
  if (i.availableMicro >= i.minMicro) return { parkMicro: 0n };
  const parkable = parkableMicro(
    i.balanceMicro + (i.creditMicro ?? 0n),
    i.fee,
    i.precision,
  );
  const park = i.topUpMicro < parkable ? i.topUpMicro : parkable;
  return { parkMicro: park > 0n ? park : 0n };
}

export interface FundSession {
  balances(agreementId: string): Promise<AgreementBalances>;
  report(spend: ParkedSpend): Promise<void>;
}
export interface FundOptions {
  agreementId: string;
  laneDefinitionIds: string[];
  fixedHf?: string;
  minHf?: string;
  topUpHf?: string;
  log?: (m: string) => void;
}
export interface FundResult {
  parkedHf: string; // "0" when nothing parked
  availableHfBefore: string;
  balanceHfAfter: string;
}

/** Available HF is the parked allocations plus the latest execution's held HF. */
export function availableMicro(b: AgreementBalances): bigint {
  return b.parkedHf.reduce(
    (sum, hf) => sum + hfToMicro(hf),
    hfToMicro(b.lockedHf),
  );
}

function feePercent(fee: FeeTerms = ASSUMED_FEE): string {
  if (fee.exempt || fee.numerator <= 0n) return "no";
  const scaled = (fee.numerator * 10000n) / fee.denominator;
  const whole = scaled / 100n;
  const frac = scaled % 100n;
  const percent =
    frac === 0n ? `${whole}` : `${whole}.${frac.toString().padStart(2, "0")}`;
  return fee.capMicro === undefined
    ? `${percent}%`
    : `${percent}% (capped at ${microToHf(fee.capMicro)} HF)`;
}

export async function ensureFunded(
  session: FundSession,
  opts: FundOptions,
): Promise<FundResult> {
  const log = opts.log ?? (() => {});
  const b = await session.balances(opts.agreementId);
  if (b.hfIndex === undefined) {
    throw new Error(`agreement ${opts.agreementId} pins no hf_index`);
  }
  const available = availableMicro(b);
  const balance = hfToMicro(b.balanceHf);

  let parkMicro: bigint;
  if (opts.fixedHf !== undefined) {
    parkMicro = hfToMicro(opts.fixedHf);
  } else if (opts.minHf !== undefined && opts.topUpHf !== undefined) {
    const { parkMicro: decidedPark } = decideFunding({
      availableMicro: available,
      minMicro: hfToMicro(opts.minHf),
      topUpMicro: hfToMicro(opts.topUpHf),
      balanceMicro: balance,
      creditMicro: hfToMicro(b.creditHf ?? "0"),
      fee: b.hfFee,
      precision: b.hfPrecision,
    });
    parkMicro = decidedPark;
  } else {
    throw new Error("give fixedHf, or both minHf and topUpHf");
  }

  const result: FundResult = {
    parkedHf: microToHf(parkMicro),
    availableHfBefore: microToHf(available),
    balanceHfAfter: microToHf(balance - parkMicro),
  };
  if (parkMicro === 0n) {
    if (opts.minHf !== undefined) {
      const belowFloor = available < hfToMicro(opts.minHf);
      log(
        belowFloor
          ? `fund: available ${result.availableHfBefore} HF < min ${opts.minHf} but the agent has no spendable HF, nothing parked`
          : `fund: available ${result.availableHfBefore} HF >= min ${opts.minHf}, nothing parked`,
      );
    }
    return result;
  }
  const spend: ParkedSpend = {
    agreementId: opts.agreementId,
    ctRoleId: FUNDER_ROLE,
    amount: { [b.hfIndex]: result.parkedHf },
    spenderPayload: {},
    laneDefinitionIds: opts.laneDefinitionIds,
  };
  await session.report(spend);
  if (opts.fixedHf !== undefined) {
    log(`fund: parked ${result.parkedHf} HF (fixed)`);
  } else if (parkMicro < hfToMicro(opts.topUpHf!)) {
    log(
      `fund: parked ${result.parkedHf} HF (balance ${b.balanceHf} HF less ${feePercent(b.hfFee)} fee)`,
    );
  } else {
    log(
      `fund: parked ${result.parkedHf} HF (available was ${result.availableHfBefore})`,
    );
  }
  return result;
}
