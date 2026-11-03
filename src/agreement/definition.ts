import { encode as msgpackEncode } from "@msgpack/msgpack";
import {
  executionCodeRhai,
  agreementDefinitionInput,
  runtimeInputSignature,
  outputSignature,
} from "./template.generated.js";

/**
 * The proof-of-service agreement, defined once: the price sheet, the code
 * template and the smart agreement that pins them together. The `provision`
 * command and the rehearsal build their zome-call payloads here.
 *
 * Shapes are the transactor zome's own, as JSON: enum variants are externally
 * tagged, unit variants are bare strings, byte fields are number arrays.
 */

export const AGREEMENT_TITLE = "Token use proof of service";

/** Parks invoices. */
export const INVOICER_ROLE = "invoicer";
/** Parks the HF that funds the agreement. */
export const FUNDER_ROLE = "funder";

export const ROLE_DISPLAY_NAMES: Record<string, string> = {
  [INVOICER_ROLE]: "Measured work invoices",
  [FUNDER_ROLE]: "Operator payment funding",
};

export interface PriceSheet {
  /** HF paid per unit, by unit symbol, as a decimal string (e.g. "0.000001"). */
  hfPerUnit: Record<string, string>;
}

/** Default rates: output tokens cost four times input tokens. */
export const DEFAULT_PRICE_SHEET: PriceSheet = {
  hfPerUnit: { TOKIN: "0.000001", TOKOUT: "0.000004" },
};

/**
 * Integer micro-HF for a decimal HF rate. The template prices with exact
 * integer arithmetic, so a rate finer than one micro-HF is refused here
 * rather than rounded.
 */
export function rateToMicroHf(rate: string): bigint {
  const match = /^(\d+)(?:\.(\d+))?$/.exec(rate.trim());
  if (!match) {
    throw new Error(
      `rate ${JSON.stringify(rate)} is not a non-negative decimal`,
    );
  }
  const fraction = match[2] ?? "";
  if (fraction.replace(/0+$/, "").length > 6) {
    throw new Error(
      `rate ${rate} has more than 6 decimal places (one micro-HF)`,
    );
  }
  return (
    BigInt(match[1]) * 1_000_000n + BigInt(fraction.padEnd(6, "0").slice(0, 6))
  );
}

/**
 * The price sheet body the rhai reads from `get_data_blob(hash).data`:
 * micro-HF per unit, keyed by the unit's index on this network.
 */
export function priceSheetBytes(
  sheet: PriceSheet,
  unitIndexBySymbol: Map<string, number>,
): number[] {
  const microHfPerUnit: Record<string, string> = {};
  for (const [symbol, rate] of Object.entries(sheet.hfPerUnit)) {
    const index = unitIndexBySymbol.get(symbol);
    if (index === undefined) {
      throw new Error(`unknown unit symbol ${symbol}`);
    }
    microHfPerUnit[String(index)] = rateToMicroHf(rate).toString();
  }
  return Array.from(msgpackEncode({ micro_hf_per_unit: microHfPerUnit }));
}

/** The `create_data_blob` payload carrying the price sheet. */
export function priceSheetPayload(
  sheet: PriceSheet,
  unitIndexBySymbol: Map<string, number>,
) {
  return {
    version: "1.0.0",
    data: priceSheetBytes(sheet, unitIndexBySymbol),
    doc_def_hash: null,
    tags: [],
    permissions: "Default",
  };
}

/** The `create_code_template` payload: the embedded rhai and its signatures. */
export function codeTemplatePayload() {
  return {
    version: "1.0.0",
    title: AGREEMENT_TITLE,
    execution_engine: "Rhai",
    execution_code: Array.from(msgpackEncode(executionCodeRhai)),
    agreement_definition_input: agreementDefinitionInput,
    runtime_input_signature: runtimeInputSignature,
    output_signature: outputSignature,
    one_time_run: false,
    aggregate_execution: true,
    tags: [{ Public: "proof-of-service" }],
    permissions: "Default",
  };
}

export interface SmartAgreementInputs {
  /** The code template's ActionHash, as raw bytes or its base64 form. */
  codeTemplateId: number[] | string;
  /** The price sheet blob's ActionHash, base64 ("u"-prefixed). */
  priceSheetHash: string;
  hfIndex: number;
  /** The one harvester agent: both roles and the executor. */
  harvesterPubKey: string;
  title?: string;
  /** Public tag; the Unyt UI groups agreements into folders by tag. */
  tag?: string;
}

/**
 * The `create_smart_agreement` payload. Every property of the runtime input
 * signature needs a matching input rule, required or not, or the integrity
 * validation rejects the entry.
 */
export function smartAgreementPayload(inputs: SmartAgreementInputs) {
  const fixed = (value: string) => ({ Fixed: value });
  const providedBy = (role: string) => ({ ProvidedBy: role });
  const role = (ctRoleId: string) => ({
    ct_role_id: ctRoleId,
    display_name: ROLE_DISPLAY_NAMES[ctRoleId],
    description: ROLE_DISPLAY_NAMES[ctRoleId],
    qualification: { Authorized: [inputs.harvesterPubKey] },
  });
  return {
    title: inputs.title ?? AGREEMENT_TITLE,
    version: "0.0.0",
    code_template_id: inputs.codeTemplateId,
    input_rules: [
      {
        name: "invoicer_allocations",
        instruction: providedBy(INVOICER_ROLE),
      },
      {
        name: "funder_allocations",
        instruction: providedBy(FUNDER_ROLE),
      },
      { name: "invoice_payloads", instruction: providedBy(INVOICER_ROLE) },
      {
        name: "price_sheet_data_blob_hash",
        instruction: fixed(inputs.priceSheetHash),
      },
      { name: "hf_index", instruction: fixed(String(inputs.hfIndex)) },
      // The carried lock and the predecessor RAVE come from the engine; `unlock`
      // is the executor's per-run flag that reclaims the held HF to the harvester.
      {
        name: "previous_execution",
        instruction: { Custom: "GetPreviousExecution" },
      },
      { name: "harvester_pub_key", instruction: fixed(inputs.harvesterPubKey) },
      { name: "unlock", instruction: "ExecutorProvided" },
    ],
    roles: [role(INVOICER_ROLE), role(FUNDER_ROLE)],
    executor_rules: { AuthorizedExecutor: inputs.harvesterPubKey },
    tags: inputs.tag ? [{ Public: inputs.tag }] : [],
    permissions: "Default",
  };
}

/**
 * The input names the embedded runtime input signature declares, under both
 * `consumed_inputs` (parked spends) and `inputs` (fixed and engine values).
 */
export function runtimeInputNames(): string[] {
  const groups = runtimeInputSignature.properties as Record<
    string,
    { properties: Record<string, unknown> }
  >;
  return Object.values(groups).flatMap((group) =>
    Object.keys(group.properties),
  );
}
