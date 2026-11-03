/**
 * Typed runtime config, loaded from the environment.
 */

/**
 * Config for every command except the Nomad source's own tools.
 */
export type SourceName = "tokens" | "nomad";

export interface OpsConfig {
  /** Path to the SQLite store file. `:memory:` for an ephemeral DB. */
  storePath: string;
  /** Which source of truth `process` reads. Default `tokens`. */
  source: SourceName;
  /** The token source's usage log (JSON lines). */
  tokenLogPath: string;
  /** Aggregation window length (ms). Default one day. */
  windowMs: number;
  /**
   * Invoice period length (ms) — how often a parked spend is created. A multiple
   * of `windowMs`; each period rolls up whole aggregation windows. Default one
   * day.
   */
  invoicePeriodMs: number;
  /** The single smart agreement parked spends are attached to. */
  agreementId: string;
  /** Lane definitions the spends apply under (base64 ActionHashes); default none. */
  laneDefinitionIds: string[];
  /** Path to the editable billing-policy JSON. Default policy if unset. */
  policyPath?: string;
  /** Path to the persisted Holochain signing creds + token (written by `hc:init`). */
  credsPath: string;
  /** Holochain admin websocket port (used only by `hc:init`). */
  hcAdminPort: number;
  /** Holochain app websocket port (used by the invoice job). */
  hcAppPort: number;
  /** Installed app id of the unyt app. */
  hcAppId: string;
  /** Park a top-up when the agreement's available HF is below this. Unset: no auto-fund. */
  fundMinHf?: string;
  fundTopUpHf?: string;
  /** Alert when the harvester agent's HF balance is below this. Unset: no alert. */
  balanceAlertHf?: string;
}

/** Full config, adding the Nomad-facing settings the watcher/pull need. */
export interface Config extends OpsConfig {
  /** Base URL of the Nomad server, e.g. http://127.0.0.1:4646 (no trailing slash). */
  nomadAddr: string;
  /** ACL token sent as X-Nomad-Token. Undefined when ACLs are disabled. */
  nomadToken?: string;
  /** Optional non-default region. */
  nomadRegion?: string;
  /** Skip TLS cert validation (the `curl -k` equivalent). For self-signed/dev. */
  nomadSkipTlsVerify: boolean;
  /** Watcher: how often to drain allocation re-pulls (coalesces bursts). */
  flushIntervalMs: number;
  /** Watcher: reconnect if no stream activity within this window. */
  idleTimeoutMs: number;
  /** Watcher: how often to re-read every node's advertised agent id. */
  agentRefreshMs: number;
}

/** Parse a truthy env flag: "1", "true", "yes", "on" (case-insensitive). */
function envBool(value: string | undefined): boolean {
  return ["1", "true", "yes", "on"].includes(
    (value ?? "").trim().toLowerCase(),
  );
}

/** Parse a positive integer env value, falling back to `fallback`. */
function envInt(value = "", fallback: number): number {
  const n = Number(value.trim());
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

/** A non-negative decimal string, or undefined when unset. Rejects other text. */
export function envDecimal(value: string | undefined): string | undefined {
  const s = (value ?? "").trim();
  if (!s) return undefined;
  if (!/^\d+(\.\d+)?$/.test(s))
    throw new Error(`expected a decimal HF amount, got "${s}"`);
  return s;
}

/** Config for every command; the Nomad source adds `loadConfig`. */
export function loadOpsConfig(env: NodeJS.ProcessEnv = process.env): OpsConfig {
  const day = 24 * 60 * 60 * 1000;
  const fundMinHf = envDecimal(env.FUND_MIN_HF);
  const fundTopUpHf = envDecimal(env.FUND_TOP_UP_HF);
  if ((fundMinHf === undefined) !== (fundTopUpHf === undefined)) {
    throw new Error("FUND_MIN_HF and FUND_TOP_UP_HF must be set together");
  }
  const source = env.SOURCE?.trim() || "tokens";
  if (source !== "tokens" && source !== "nomad") {
    throw new Error(`SOURCE must be tokens or nomad, not ${source}`);
  }
  return {
    storePath: env.STORE_PATH?.trim() || "./unyt-harvester-example.db",
    source,
    tokenLogPath: env.TOKEN_LOG_PATH?.trim() || "./token-usage.jsonl",
    windowMs: envInt(env.WINDOW_MS, day),
    invoicePeriodMs: envInt(env.INVOICE_PERIOD_MS, day),
    agreementId: env.AGREEMENT_ID?.trim() || "",
    laneDefinitionIds: (env.LANE_DEFINITION_IDS?.trim() || "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
    policyPath: env.POLICY_PATH?.trim() || undefined,
    credsPath: env.HC_CREDS_PATH?.trim() || "./harvester-hc-creds.json",
    hcAdminPort: envInt(env.HC_ADMIN_PORT, 0),
    hcAppPort: envInt(env.HC_APP_PORT, 0),
    hcAppId: env.HC_APP_ID?.trim() || "unyt",
    fundMinHf,
    fundTopUpHf,
    balanceAlertHf: envDecimal(env.BALANCE_ALERT_HF),
  };
}

/**
 * Full config (adds Nomad settings) for the watcher/pull tools. Throws if
 * NOMAD_ADDR is missing so those commands fail loudly.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const nomadAddr = env.NOMAD_ADDR?.trim();
  if (!nomadAddr) {
    throw new Error(
      "NOMAD_ADDR is required (e.g. http://127.0.0.1:4646). Copy env.example to .env.",
    );
  }

  return {
    ...loadOpsConfig(env),
    nomadAddr: nomadAddr.replace(/\/+$/, ""),
    nomadToken: env.NOMAD_TOKEN?.trim() || undefined,
    nomadRegion: env.NOMAD_REGION?.trim() || undefined,
    nomadSkipTlsVerify: envBool(env.NOMAD_SKIP_VERIFY),
    flushIntervalMs: envInt(env.FLUSH_INTERVAL_MS, 2000),
    idleTimeoutMs: envInt(env.IDLE_TIMEOUT_MS, 60000),
    agentRefreshMs: envInt(env.AGENT_REFRESH_MS, 300000),
  };
}

/**
 * The lane ids a real invoice run cites. Required: the app only finds a lane
 * on its own when a spend carries every one of the lane's units, so an
 * operator with only some units in a period could never be paid.
 */
export function requireLaneDefinitionIds(config: OpsConfig): string[] {
  if (config.laneDefinitionIds.length === 0) {
    throw new Error(
      "LANE_DEFINITION_IDS is required: your lane's definition hash " +
        "(`npm run ops lanes` prints it)",
    );
  }
  return config.laneDefinitionIds;
}
