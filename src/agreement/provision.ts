import { decode as msgpackDecode } from "@msgpack/msgpack";
import { decodeHashFromBase64 } from "@holochain/client";
import {
  AGREEMENT_TITLE,
  PriceSheet,
  codeTemplatePayload,
  priceSheetPayload,
  smartAgreementPayload,
} from "./definition.js";
import { hcUnitIndexBySymbol } from "../holochain/hc-client.js";

export type ZomeCall = (fn: string, payload: unknown) => Promise<any>;

/** Parse `--price SYMBOL=rate` values into a price sheet. */
export function parsePrices(values: string[]): PriceSheet {
  const hfPerUnit: Record<string, string> = {};
  for (const v of values) {
    const [symbol, rate] = v.split("=");
    if (!symbol || rate === undefined) {
      throw new Error(
        `--price ${v}: expected SYMBOL=rate, e.g. TOKIN=0.000001`,
      );
    }
    hfPerUnit[symbol.trim()] = rate.trim();
  }
  return { hfPerUnit };
}

export interface RotationFlags {
  /** The agreement whose code template and price sheet are reused. */
  from?: string;
  newTemplate: boolean;
  newPriceSheet: boolean;
  /** Whether a rate flag was passed. */
  ratesGiven: boolean;
}

export interface RotationPlan {
  publishTemplate: boolean;
  publishPriceSheet: boolean;
}

/**
 * Which parts a run publishes. Without `--from` both are published. With it,
 * each part is reused unless its `--new-*` flag asks for a fresh one; rate
 * flags only make sense when a price sheet is published.
 */
export function rotationPlan(flags: RotationFlags): RotationPlan {
  if (flags.from === undefined) {
    if (flags.newTemplate || flags.newPriceSheet) {
      throw new Error(
        "--new-template and --new-price-sheet need --from <ea_id>; without it both are published",
      );
    }
    return { publishTemplate: true, publishPriceSheet: true };
  }
  if (flags.ratesGiven && !flags.newPriceSheet) {
    throw new Error(
      "--price is ignored when the price sheet is reused; add --new-price-sheet",
    );
  }
  return {
    publishTemplate: flags.newTemplate,
    publishPriceSheet: flags.newPriceSheet,
  };
}

/** The reusable parts of an existing agreement, from `get_smart_agreement`. */
export function reusableParts(agreement: {
  code_template_id: string;
  input_rules: Array<{ name: string; instruction: unknown }>;
}): { templateHash: string; priceSheetHash: string } {
  const rule = agreement.input_rules.find(
    (r) => r.name === "price_sheet_data_blob_hash",
  );
  const instruction = rule?.instruction as { Fixed?: unknown } | undefined;
  if (!instruction || typeof instruction !== "object" || !instruction.Fixed) {
    throw new Error("agreement pins no price_sheet_data_blob_hash Fixed input");
  }
  return {
    templateHash: agreement.code_template_id,
    priceSheetHash: String(instruction.Fixed),
  };
}

export interface ProvisionOptions {
  /** The harvester agent: holds both roles and is the executor. */
  harvesterPubKey: string;
  prices: PriceSheet;
  title?: string;
  /** Public tag; the Unyt UI groups agreements into folders by tag. */
  tag?: string;
  /** Rotate: reuse this agreement's parts unless `plan` republishes them. */
  from?: string;
  plan?: RotationPlan;
  log?: (msg: string) => void;
}

export interface ProvisionResult {
  agreementId: string;
  templateHash: string;
  priceSheetHash: string;
}

/**
 * Publish the price sheet and code template (or reuse an earlier agreement's)
 * and create the smart agreement that pins them, as the connected agent. The
 * roles and executor are fixed once the agreement exists.
 */
export async function provisionAgreement(
  call: ZomeCall,
  opts: ProvisionOptions,
): Promise<ProvisionResult> {
  const log = opts.log ?? (() => {});
  const plan = opts.plan ?? { publishTemplate: true, publishPriceSheet: true };
  const units = await hcUnitIndexBySymbol(call);
  const hfIndex = units.get("HF");
  if (hfIndex === undefined) throw new Error("network has no HF unit");

  let templateHash: string | undefined;
  let priceSheetHash: string | undefined;
  if (opts.from !== undefined) {
    const reused = reusableParts(
      await call("get_smart_agreement", decodeHashFromBase64(opts.from)),
    );
    if (!plan.publishTemplate) templateHash = reused.templateHash;
    if (!plan.publishPriceSheet) {
      priceSheetHash = reused.priceSheetHash;
      const blob = (await call(
        "get_data_blob",
        decodeHashFromBase64(priceSheetHash),
      )) as { data: { data: Uint8Array } };
      log(
        `reusing price sheet ${JSON.stringify(msgpackDecode(blob.data.data))}`,
      );
    }
  }

  if (priceSheetHash === undefined) {
    priceSheetHash = String(
      await call("create_data_blob", priceSheetPayload(opts.prices, units)),
    );
    log(`price_sheet_hash=${priceSheetHash}`);
  }
  if (templateHash === undefined) {
    templateHash = String(
      await call("create_code_template", codeTemplatePayload()),
    );
    log(`template_hash=${templateHash}`);
  }
  // The smart agreement's code_template_id is raw bytes on the wire, unlike
  // the base64 string the price sheet's Fixed input takes.
  const agreementId = String(
    await call(
      "create_smart_agreement",
      smartAgreementPayload({
        codeTemplateId: Array.from(decodeHashFromBase64(templateHash)),
        priceSheetHash,
        hfIndex,
        harvesterPubKey: opts.harvesterPubKey,
        title: opts.title ?? AGREEMENT_TITLE,
        tag: opts.tag,
      }),
    ),
  );
  log(`AGREEMENT_ID=${agreementId}`);
  return { agreementId, templateHash, priceSheetHash };
}
