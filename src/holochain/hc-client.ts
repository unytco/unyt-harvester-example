import {
  AdminWebsocket,
  AppWebsocket,
  WsClient,
  encodeHashToBase64,
  getSigningCredentials,
  setSigningCredentials,
} from "@holochain/client";
import { decode } from "@msgpack/msgpack";
import { EncCreds } from "./types.js";
import {
  FeeTerms,
  hfToMicro,
  latestLockedHf,
  RaveLike,
} from "../billing/funding.js";
import { readCreds, writeCreds, HcCredsFile } from "./creds.js";
import { LaneLineage, readLaneLineages, resolveLanes } from "./lanes.js";

/** Standard-base64 helpers (Buffer is a Uint8Array, so this matches base64-js). */
export const toB64 = (b: Uint8Array): string =>
  Buffer.from(b).toString("base64");
export const fromB64 = (s: string): Uint8Array =>
  new Uint8Array(Buffer.from(s, "base64"));

/**
 * Close an app websocket. Client 0.22 types the transport as the minimal
 * AppClientTransport, which has no close; on the websocket path it is a WsClient.
 */
export async function closeApp(app: AppWebsocket): Promise<void> {
  if (app.client instanceof WsClient) await app.client.close();
}

export interface SessionDeps {
  readCreds(path: string): Promise<HcCredsFile>;
  writeCreds(path: string, data: HcCredsFile): Promise<void>;
  init(adminPort: number, appId: string): Promise<HcCredsFile>;
  open(appPort: number, creds: EncCreds, token: string): Promise<HcSession>;
}

const defaultDeps: SessionDeps = {
  readCreds,
  writeCreds,
  init: hcInit,
  open: hcOpenSession,
};

/** Open a session; if the stored credentials fail, run hc:init once and retry. */
export async function hcOpenSessionWithRetry(
  config: {
    credsPath: string;
    hcAdminPort: number;
    hcAppPort: number;
    hcAppId: string;
  },
  deps: SessionDeps = defaultDeps,
  log: (m: string) => void = (m) => console.error(m),
): Promise<HcSession> {
  try {
    const stored = await deps.readCreds(config.credsPath);
    return await deps.open(config.hcAppPort, stored.hcCreds, stored.hcToken);
  } catch (err) {
    log(
      `stored credentials unusable (${err instanceof Error ? err.message : String(err)}); running hc:init`,
    );
  }
  const fresh = await deps.init(config.hcAdminPort, config.hcAppId);
  await deps.writeCreds(config.credsPath, fresh);
  return deps.open(config.hcAppPort, fresh.hcCreds, fresh.hcToken);
}

/**
 * Holochain client for creating parked spends directly from this node.
 *
 * Lifted from the original log pipeline's `hc-client.ts`. Two entry points:
 *  - `hcInit`   — one-time: authorize signing credentials on the unyt cell and
 *                 issue an app-auth token. Persist the result (see `hc:init`).
 *  - `hcReport` — per invoice: open an app connection, sign, and call
 *                 `create_parked_spend`.
 *
 * The original hard-coded the app id (`"unyt"`) when issuing the token and the
 * a fixed role id on the call; here the app id is a
 * parameter (fixes a latent bug) and the role id is passed in.
 */

export interface DecCreds {
  capSecret: Uint8Array;
  keyPair: {
    publicKey: Uint8Array;
    privateKey: Uint8Array;
    keyType: string;
  };
  signingKey: Uint8Array;
}

function encCreds(creds: DecCreds | undefined): EncCreds {
  if (!creds) {
    throw new Error("could not generate signing credentials");
  }
  return {
    cap: toB64(creds.capSecret),
    pub: toB64(creds.keyPair.publicKey),
    sec: toB64(creds.keyPair.privateKey),
    typ: creds.keyPair.keyType,
    sig: toB64(creds.signingKey),
  };
}

export function decCreds(creds: EncCreds): DecCreds {
  return {
    capSecret: fromB64(creds.cap),
    keyPair: {
      publicKey: fromB64(creds.pub),
      privateKey: fromB64(creds.sec),
      keyType: creds.typ,
    },
    signingKey: fromB64(creds.sig),
  };
}

/** Pull the alliance cell id out of an app's cell info, or throw. */
export function allianceCellId(cellInfo: any): any {
  if (
    cellInfo?.alliance?.[0]?.value &&
    "cell_id" in cellInfo.alliance[0].value
  ) {
    return cellInfo.alliance[0].value.cell_id;
  }
  throw new Error(
    "unyt app does not appear to be installed (no alliance cell)",
  );
}

/**
 * One-time initialization: authorize signing credentials on the unyt cell and
 * issue an app-authentication token. Persist `{ hcCreds, hcToken }`; the invoice
 * job loads them to sign `create_parked_spend` calls.
 */
export async function hcInit(
  hcAdminPort: number,
  hcAppId: string,
): Promise<{ hcCreds: EncCreds; hcToken: string }> {
  const admin = await AdminWebsocket.connect({
    url: new URL(`ws://127.0.0.1:${hcAdminPort}`),
    wsClientOptions: { origin: "unyt-harvester-example" },
  });

  try {
    const apps = await admin.listApps({});
    const app = apps.find((a) => a.installed_app_id === hcAppId);
    if (!app) {
      throw new Error(
        `app '${hcAppId}' is not installed (found: ${apps
          .map((a) => a.installed_app_id)
          .join(", ")})`,
      );
    }

    const cell_id = allianceCellId(app.cell_info);
    await admin.authorizeSigningCredentials(cell_id, { type: "all" });

    const hcCreds = encCreds(getSigningCredentials(cell_id));

    const hcToken = toB64(
      new Uint8Array(
        (
          await admin.issueAppAuthenticationToken({
            expiry_seconds: 0,
            installed_app_id: hcAppId,
            single_use: false,
          })
        ).token,
      ),
    );

    return { hcCreds, hcToken };
  } finally {
    await admin.client.close();
  }
}

/**
 * Every global unit's index by symbol (`get_global_units_details`). Indices are
 * assigned when a unit is registered and differ per network, so they are looked
 * up rather than hard-coded.
 */
export async function hcUnitIndexBySymbol(
  call: (fn_name: string, payload: unknown) => Promise<unknown>,
): Promise<Map<string, number>> {
  const units = (await call("get_global_units_details", null)) as Array<{
    unit_symbol: string;
    index: number;
  }>;
  return new Map(units.map((u) => [u.unit_symbol, u.index]));
}

/**
 * What's needed to tell whether an invoice on a given agreement will be payable:
 * the unit indices and HF price the agreement pins as Fixed inputs, and the HF
 * currently parked as funding on that agreement.
 */
export interface AgreementFunding {
  /** Fixed unit indices the agreement's execution code reads (stringified). */
  hfIndex?: string;
  /** Decoded price sheet, if the agreement pins one: micro-HF per unit index. */
  priceSheet?: { microHfPerUnit: Record<string, bigint> };
  /**
   * Positive HF amounts parked as funding on the agreement (stringified
   * ZFuel), largest first. Negative ("debit") parked spends are inert and
   * excluded — they reserve nothing and the execution code can't pay from them.
   */
  fundingHf: string[];
}

/**
 * Read an agreement's pinned indices/price sheet and the funding HF parked on
 * it, so a caller can check an invoice will be payable before submitting it. The
 * execution code pays a payload only from a single funding allocation that
 * covers it, so the relevant figure is the largest parked HF allocation.
 */
export async function hcReadFunding(
  hcAppPort: number,
  hcCreds: EncCreds,
  hcToken: string,
  agreementId: string,
): Promise<AgreementFunding> {
  const creds = decCreds(hcCreds);
  const token: number[] = Array.from(fromB64(hcToken));
  const eaId = fromB64(agreementId.substring(1));

  const app = await AppWebsocket.connect({
    url: new URL(`ws://127.0.0.1:${hcAppPort}`),
    token,
    wsClientOptions: { origin: "unyt-harvester-example" },
  });

  try {
    const info = await app.appInfo();
    const cell_id = allianceCellId(info.cell_info);
    setSigningCredentials(cell_id, creds);

    const call = (fn_name: string, payload: unknown) =>
      app.callZome({ cell_id, zome_name: "transactor", fn_name, payload });

    // Indices and price-sheet hash are pinned on the agreement as Fixed inputs.
    const agreement = (await call("get_smart_agreement", eaId)) as {
      input_rules: Array<{ name: string; instruction: unknown }>;
    };
    const fixed = (name: string): string | undefined => {
      const rule = agreement.input_rules.find((r) => r.name === name);
      const inst = rule?.instruction as { Fixed?: unknown } | undefined;
      return inst && typeof inst === "object" && "Fixed" in inst
        ? String(inst.Fixed)
        : undefined;
    };
    const hfIndex = fixed("hf_index");

    let priceSheet: AgreementFunding["priceSheet"];
    const priceSheetHash = fixed("price_sheet_data_blob_hash");
    if (priceSheetHash) {
      const blob = (await call(
        "get_data_blob",
        fromB64(priceSheetHash.substring(1)),
      )) as { data: { data: Uint8Array } };
      const raw = decode(blob.data.data) as {
        micro_hf_per_unit?: Record<string, string>;
      };
      priceSheet = {
        microHfPerUnit: Object.fromEntries(
          Object.entries(raw.micro_hf_per_unit ?? {}).map(([unit, rate]) => [
            unit,
            BigInt(rate),
          ]),
        ),
      };
    }

    // Parked funding HF: the parked spends on the agreement carrying the HF
    // unit. Only POSITIVE amounts fund the agreement — the execution code reads
    // the stored amount directly and pays from allocations whose HF is >= the
    // cost. A negative ("debit") parked spend reserves nothing and can't pay
    // (it's an inert no-op), so it does not count toward available funding.
    const parked = (await call("get_parked_links_by_ea", eaId)) as Array<{
      amount?: Record<string, string | number>;
    }>;
    const fundingHf =
      hfIndex === undefined
        ? []
        : parked
            .map((p) => p.amount?.[hfIndex])
            .filter((v): v is string | number => v !== undefined)
            // Keep the parked HF as its ZFuel decimal string (rates and amounts
            // can be fractional); Number() is used only to order and drop
            // non-positive ("debit") allocations, not for the payment math.
            .map((v) => String(v))
            .filter((s) => Number(s) > 0)
            .sort((a, b) => Number(b) - Number(a));

    return { hfIndex, priceSheet, fundingHf };
  } finally {
    await closeApp(app);
  }
}

/**
 * Every lane the conductor knows about, with all versions of its definition
 * and the one in force. `ops lanes` prints this so an operator can pin the
 * lane in `LANE_DEFINITION_IDS`: a parked invoice must pin its lane, because
 * the app only auto-resolves a lane when every one of its service units is
 * present in the amount.
 */
export async function hcListLanes(
  hcAppPort: number,
  hcCreds: EncCreds,
  hcToken: string,
): Promise<LaneLineage[]> {
  const creds = decCreds(hcCreds);
  const token: number[] = Array.from(fromB64(hcToken));

  const app = await AppWebsocket.connect({
    url: new URL(`ws://127.0.0.1:${hcAppPort}`),
    token,
    wsClientOptions: { origin: "unyt-harvester-example" },
  });

  try {
    const info = await app.appInfo();
    const cell_id = allianceCellId(info.cell_info);
    setSigningCredentials(cell_id, creds);
    return await readLaneLineages((fn_name, payload) =>
      app.callZome({ cell_id, zome_name: "transactor", fn_name, payload }),
    );
  } finally {
    await closeApp(app);
  }
}

/** A single parked-spend invoice for one payee. */
export interface ParkedSpend {
  /** The smart agreement this spend is parked on (base64 ActionHash, "u"-prefixed). */
  agreementId: string;
  /** Capability role id authorized to create the spend. */
  ctRoleId: string;
  /** Unit-index → stringified ZFuel amount, e.g. { "0": "86400", "1": "12" }. */
  amount: { [unitIndex: string]: string };
  /** Arbitrary JSON the agreement interprets (payee, period, breakdown). */
  spenderPayload: unknown;
  /**
   * Lane definitions the spend applies under, as base64 "u"-prefixed
   * ActionHashes. Maps to the real zome's `lane_definitions: Vec<ActionHash>`
   * (which is `#[serde(default)]`, so an empty list is valid).
   */
  laneDefinitionIds?: string[];
}

export interface AgreementBalances {
  hfIndex?: string;
  /** Positive parked HF allocations on the agreement, decimal strings. */
  parkedHf: string[];
  /** HF held by the latest execution's `output.locked`; "0" if none. */
  lockedHf: string;
  /** The connected agent's HF ledger balance; "0" if none. */
  balanceHf: string;
  /** The connected agent's applied HF credit limit; absent if unread. */
  creditHf?: string;
  /** Parked spends under `invoicer` that no execution has settled. */
  parkedInvoices?: number;
  /**
   * The spender fee on HF from the global definition in force; absent when it
   * could not be read.
   */
  hfFee?: FeeTerms;
  /** Decimal places the HF unit allows; absent when it could not be read. */
  hfPrecision?: number;
}

/**
 * The HF unit's fee terms from the global definition in force, and whether the
 * connected agent is exempt from them. A unit the definition does not list is
 * not charged.
 */
export function hfFeeTerms(
  globalDef: unknown,
  hfIndex: string,
  agent: string,
): FeeTerms {
  const fees = (
    globalDef as {
      system_rave_agreements?: {
        compute_transaction_fee?: {
          unit_fees?: Array<{
            unit_index: number | string;
            spender_pay_percent: { numerator: number; denominator: number };
            fee_cap?: string | number | null;
            exempt_agents?: string[];
          }>;
        };
      };
    }
  ).system_rave_agreements?.compute_transaction_fee?.unit_fees;
  const fee = fees?.find((f) => String(f.unit_index) === hfIndex);
  if (!fee) return { numerator: 0n, denominator: 1n };
  return {
    numerator: BigInt(fee.spender_pay_percent.numerator),
    denominator: BigInt(fee.spender_pay_percent.denominator),
    ...(fee.fee_cap !== undefined && fee.fee_cap !== null
      ? { capMicro: hfToMicro(String(fee.fee_cap)) }
      : {}),
    exempt: (fee.exempt_agents ?? []).includes(agent),
  };
}

/** The decimal places a monetary unit allows, from `get_global_units_details`. */
export function unitPrecision(
  units: unknown,
  index: string,
): number | undefined {
  const unit = (
    units as Array<{
      index: number;
      unit_type?: { MonetaryUnit?: { precision?: number } };
    }>
  ).find((u) => String(u.index) === index);
  return unit?.unit_type?.MonetaryUnit?.precision;
}

/**
 * Long-lived Holochain session that batches many parked-spend commits (and an
 * execute) over a single AppWebsocket. Setup — connect, appInfo, signing creds,
 * whoami — is paid once; each report is a single zome call. The invoice job
 * uses this to avoid the 4-roundtrip per-spend cost of `hcReport`.
 */
export interface HcSession {
  report(spend: ParkedSpend): Promise<void>;
  /** `invoice_key`s in the payloads of the spends parked on the agreement. */
  parkedInvoiceKeys(agreementId: string): Promise<Set<string>>;
  /** Whether this network holds the agent (the app's `check_agent_exists`). */
  agentExists(agentPubKey: string): Promise<boolean>;
  execute(
    agreementId: string,
    laneDefinitionIds?: string[],
    executorInputs?: Record<string, unknown>,
  ): Promise<ExecuteResult>;
  /**
   * Accept a RAVE allocation addressed to this agent: commits the receipt that
   * puts it on the ledger. Returns the receipt hash.
   */
  acceptRave(raveHash: string, note?: string): Promise<string>;
  balances(agreementId: string): Promise<AgreementBalances>;
  /** Every global unit's index by symbol. */
  unitIndexBySymbol(): Promise<Map<string, number>>;
  /**
   * The lane definition hashes a spend made now must cite: each id in
   * `LANE_DEFINITION_IDS` resolved to its lane's version in force. Logs one
   * line per lane. Throws when an id names no lane or nothing is in force.
   */
  resolveLanes(
    configuredIds: string[],
    log?: (message: string) => void,
  ): Promise<string[]>;
  agent: string;
  close(): Promise<void>;
}

/** Open an HcSession — reuses one AppWebsocket across all subsequent calls. */
export async function hcOpenSession(
  hcAppPort: number,
  hcCreds: EncCreds,
  hcToken: string,
): Promise<HcSession> {
  const creds = decCreds(hcCreds);
  const token: number[] = Array.from(fromB64(hcToken));
  const app = await AppWebsocket.connect({
    url: new URL(`ws://127.0.0.1:${hcAppPort}`),
    token,
    wsClientOptions: { origin: "unyt-harvester-example" },
  });
  const info = await app.appInfo();
  if (!info) throw new Error("appInfo returned null");
  const cell_id = allianceCellId(info.cell_info);
  setSigningCredentials(cell_id, creds);
  const call = (fn_name: string, payload: unknown) =>
    app.callZome({ cell_id, zome_name: "transactor", fn_name, payload });
  const executor = (await call("whoami", null)) as Uint8Array;
  return makeSession({ call, executor, close: () => closeApp(app) });
}

/** The transactor zome calls a session is built from; a test passes fakes. */
export interface SessionCalls {
  call(fn_name: string, payload: unknown): Promise<unknown>;
  /** The connected agent (`whoami`). */
  executor: Uint8Array;
  close(): Promise<void>;
  /** Clock for lane window checks; defaults to `Date.now`. */
  now?: () => number;
}

/** Build an HcSession over an already-connected cell. */
export function makeSession({
  call,
  executor,
  close,
  now = Date.now,
}: SessionCalls): HcSession {
  const agent = encodeHashToBase64(executor);

  return {
    unitIndexBySymbol: () => hcUnitIndexBySymbol(call),
    async parkedInvoiceKeys(agreementId: string): Promise<Set<string>> {
      const parked = (await call(
        "get_parked_links_by_ea",
        fromB64(agreementId.substring(1)),
      )) as Array<{
        details?: {
          ParkedSpend?: { attached_payload?: { invoice_key?: unknown } };
        };
      }>;
      const keys = new Set<string>();
      for (const p of parked) {
        const key = p.details?.ParkedSpend?.attached_payload?.invoice_key;
        if (typeof key === "string") keys.add(key);
      }
      return keys;
    },
    async agentExists(agentPubKey: string): Promise<boolean> {
      const result = await call(
        "check_agent_exists",
        fromB64(agentPubKey.substring(1)),
      );
      if (typeof result !== "boolean") {
        throw new Error(
          `check_agent_exists returned ${JSON.stringify(result)}, expected a boolean`,
        );
      }
      return result;
    },
    async report(spend: ParkedSpend): Promise<void> {
      await call("create_parked_spend", {
        ea_id: fromB64(spend.agreementId.substring(1)),
        executor,
        ct_role_id: spend.ctRoleId,
        amount: spend.amount,
        spender_payload: spend.spenderPayload,
        lane_definitions: (spend.laneDefinitionIds ?? []).map((id) =>
          fromB64(id.substring(1)),
        ),
      });
    },
    async execute(
      agreementId: string,
      laneDefinitionIds: string[] = [],
      executorInputs: Record<string, unknown> = {},
    ): Promise<ExecuteResult> {
      const eaId = fromB64(agreementId.substring(1));
      const globalDef = (await call("get_current_global_definition", null)) as {
        id: string;
      };
      const result = (await call("execute_rave", {
        executor_inputs: executorInputs,
        ea_id: eaId,
        global_definition: fromB64(globalDef.id.substring(1)),
        lane_definitions: laneDefinitionIds.map((id) =>
          fromB64(id.substring(1)),
        ),
      })) as
        | [{ output?: { unyt_allocation?: unknown[] } }, Uint8Array | undefined]
        | undefined;
      const hash = result?.[1];
      return {
        allocations: result?.[0]?.output?.unyt_allocation?.length ?? 0,
        raveHash:
          hash instanceof Uint8Array ? encodeHashToBase64(hash) : undefined,
      };
    },
    async acceptRave(raveHash: string, note?: string): Promise<string> {
      const receipt = await call("create_receipt_from_rave", {
        hash: raveHash,
        note: note ?? null,
      });
      return String(receipt);
    },
    agent,
    resolveLanes(configuredIds, log = (m) => console.error(m)) {
      return resolveLanes(call, configuredIds, now(), log);
    },
    async balances(agreementId: string): Promise<AgreementBalances> {
      const eaId = fromB64(agreementId.substring(1));
      const agreement = (await call("get_smart_agreement", eaId)) as {
        input_rules: Array<{ name: string; instruction: unknown }>;
      };
      const rule = agreement.input_rules.find((r) => r.name === "hf_index");
      const inst = rule?.instruction as { Fixed?: unknown } | undefined;
      const hfIndex =
        inst && typeof inst === "object" && "Fixed" in inst
          ? String(inst.Fixed)
          : undefined;
      if (hfIndex === undefined) {
        return { hfIndex, parkedHf: [], lockedHf: "0", balanceHf: "0" };
      }
      const parked = (await call("get_parked_links_by_ea", eaId)) as Array<{
        amount?: Record<string, string | number>;
        details?: { ParkedSpend?: { ct_role_id?: string } };
      }>;
      const parkedHf = parked
        .map((p) => p.amount?.[hfIndex])
        .filter((v): v is string | number => v !== undefined)
        .map(String)
        .filter((s) => Number(s) > 0);
      const parkedInvoices = parked.filter(
        (p) => p.details?.ParkedSpend?.ct_role_id === "invoicer",
      ).length;
      const raves = (await call(
        "get_raves_for_smart_agreement",
        eaId,
      )) as Array<{
        details: { RAVE?: RaveLike };
      }>;
      const lockedHf = latestLockedHf(
        raves.map((t) => t.details.RAVE).filter((r): r is RaveLike => !!r),
        hfIndex,
      );
      const ledger = (await call("get_ledger", null)) as {
        balance?: Record<string, string | number>;
      };
      const balanceHf = String(ledger.balance?.[hfIndex] ?? "0");
      let creditHf: string | undefined;
      try {
        const limit = (await call(
          "get_my_current_applied_credit_limit",
          null,
        )) as Record<string, string | number>;
        creditHf = String(limit?.[hfIndex] ?? "0");
      } catch {}
      // Fee terms and precision only cap the park; the caller assumes a fee
      // when they cannot be read.
      let hfFee: FeeTerms | undefined;
      let hfPrecision: number | undefined;
      try {
        const globalDef = await call("get_current_global_definition", null);
        hfFee = hfFeeTerms(globalDef, hfIndex, agent);
      } catch {}
      try {
        const units = await call("get_global_units_details", null);
        hfPrecision = unitPrecision(units, hfIndex);
      } catch {}
      return {
        hfIndex,
        parkedHf,
        lockedHf,
        balanceHf,
        creditHf,
        parkedInvoices,
        hfFee,
        hfPrecision,
      };
    },
    close,
  };
}

/**
 * Make the `create_parked_spend` call into the holochain unyt app — i.e. submit
 * one invoice. Opens and closes an app connection per call. For batches, prefer
 * `hcOpenSession` which reuses one connection across many spends.
 */
export async function hcReport(
  hcAppPort: number,
  hcAppId: string,
  hcCreds: EncCreds,
  hcToken: string,
  spend: ParkedSpend,
): Promise<void> {
  const creds = decCreds(hcCreds);
  const token: number[] = Array.from(fromB64(hcToken));

  const app = await AppWebsocket.connect({
    url: new URL(`ws://127.0.0.1:${hcAppPort}`),
    token,
    wsClientOptions: { origin: "unyt-harvester-example" },
  });

  try {
    const info = await app.appInfo();
    const cell_id = allianceCellId(info.cell_info);
    setSigningCredentials(cell_id, creds);

    // A given executor must match the agreement's authorized executor. This
    // node is the executor, so pass this cell's own agent.
    const executor = (await app.callZome({
      cell_id,
      zome_name: "transactor",
      fn_name: "whoami",
      payload: null,
    })) as Uint8Array;

    await app.callZome({
      cell_id,
      zome_name: "transactor",
      fn_name: "create_parked_spend",
      payload: {
        // Holochain hashes are "u"-prefixed base64url; drop the prefix to decode.
        ea_id: fromB64(spend.agreementId.substring(1)),
        executor,
        ct_role_id: spend.ctRoleId,
        amount: spend.amount,
        spender_payload: spend.spenderPayload,
        // Real CreateParkedSpendInput field (Vec<ActionHash>, #[serde(default)]);
        // each is a "u"-prefixed base64 ActionHash, decoded like ea_id.
        lane_definitions: (spend.laneDefinitionIds ?? []).map((id) =>
          fromB64(id.substring(1)),
        ),
      },
    });
  } finally {
    await closeApp(app);
  }
}

/** Outcome of executing an agreement's RAVE. */
export interface ExecuteResult {
  /** Number of unyt allocations the execution produced (0 if none/unknown). */
  allocations: number;
  /** The committed RAVE's ActionHash, base64; absent when the call returned none. */
  raveHash?: string;
}

/**
 * Execute the agreement's RAVE: run the smart agreement over its parked spends,
 * paying operators from the parked funding HF. The pipeline runs this after
 * parking the period's invoices so the agreement drains without a manual step.
 *
 * The executor must be the agreement's authorized executor (the harvester agent) —
 * the pipeline node runs with those credentials. Opens and closes
 * its own app connection.
 */
export async function hcExecuteAgreement(
  hcAppPort: number,
  hcCreds: EncCreds,
  hcToken: string,
  agreementId: string,
  laneDefinitionIds: string[] = [],
): Promise<ExecuteResult> {
  const creds = decCreds(hcCreds);
  const token: number[] = Array.from(fromB64(hcToken));
  const eaId = fromB64(agreementId.substring(1));

  const app = await AppWebsocket.connect({
    url: new URL(`ws://127.0.0.1:${hcAppPort}`),
    token,
    wsClientOptions: { origin: "unyt-harvester-example" },
  });

  try {
    const info = await app.appInfo();
    const cell_id = allianceCellId(info.cell_info);
    setSigningCredentials(cell_id, creds);

    const call = (fn_name: string, payload: unknown) =>
      app.callZome({ cell_id, zome_name: "transactor", fn_name, payload });

    // execute_rave pins the current global definition; its id is a "u"-prefixed
    // base64 ActionHash, decoded like ea_id.
    const globalDef = (await call("get_current_global_definition", null)) as {
      id: string;
    };

    const result = (await call("execute_rave", {
      executor_inputs: {},
      ea_id: eaId,
      global_definition: fromB64(globalDef.id.substring(1)),
      lane_definitions: laneDefinitionIds.map((id) => fromB64(id.substring(1))),
    })) as [{ output?: { unyt_allocation?: unknown[] } }, unknown] | undefined;

    const allocations = result?.[0]?.output?.unyt_allocation?.length ?? 0;
    return { allocations };
  } finally {
    await closeApp(app);
  }
}
