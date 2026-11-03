import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { AppWebsocket, setSigningCredentials } from "@holochain/client";
import {
  allianceCellId,
  closeApp,
  decCreds,
  fromB64,
  hcInit,
  hcUnitIndexBySymbol,
} from "../holochain/hc-client.js";
import { DEFAULT_PRICE_SHEET, rateToMicroHf } from "../agreement/definition.js";
import { provisionAgreement } from "../agreement/provision.js";
import { microToHf } from "../billing/funding.js";
import { generateTokens } from "../sources/tokens/generate.js";
import { parseTokenLine } from "../sources/tokens/log.js";
import {
  PROGENITOR_APP_ID,
  prepareRunDir,
  startNetwork,
  standUpHoloFuel,
} from "./network.js";
import {
  LaneConfig,
  ZomeCall,
  createProgramLane,
  wireProofOfService,
} from "./net-zero.js";

/**
 * The whole flow on a private local HoloFuel network, from an empty conductor
 * to operators holding HF:
 *
 *   npm run rehearse -- --clean
 *
 * Net Zero's two steps run from `net-zero.ts`; everything the program does —
 * provisioning, `process`, `invoice` — is the same code and the same commands
 * a live deployment runs.
 */

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const RUN = join(ROOT, ".rehearsal/run");
const MINUTE = 60_000;
const log = (m: string) => console.error(`[rehearse] ${m}`);

async function appCall(
  adminPort: number,
  appPort: number,
  appId: string,
): Promise<{ call: ZomeCall; close: () => Promise<void> }> {
  const { hcCreds, hcToken } = await hcInit(adminPort, appId);
  const app = await AppWebsocket.connect({
    url: new URL(`ws://127.0.0.1:${appPort}`),
    token: Array.from(fromB64(hcToken)),
    wsClientOptions: { origin: "unyt-harvester-example" },
  });
  const info = await app.appInfo();
  if (!info) throw new Error(`no app ${appId}`);
  const cell_id = allianceCellId(info.cell_info);
  setSigningCredentials(cell_id, decCreds(hcCreds));
  return {
    call: (fn, payload) =>
      app.callZome({ cell_id, zome_name: "transactor", fn_name: fn, payload }),
    close: () => closeApp(app),
  };
}

function run(script: string, args: string[], env: Record<string, string>) {
  log(`$ ${script} ${args.join(" ")}`);
  const r = spawnSync("node", [join(ROOT, "dist/server", script), ...args], {
    env: { ...process.env, ...env },
    stdio: "inherit",
  });
  if (r.status !== 0) throw new Error(`${script} exited ${r.status}`);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function until<T>(
  what: string,
  timeoutMs: number,
  probe: () => Promise<T | undefined>,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(2000);
  }
}

/** micro-HF each operator should be paid for the token log, at `rates`. */
function expectedPay(
  logPath: string,
  rates: { TOKIN: bigint; TOKOUT: bigint },
): Map<string, bigint> {
  const pay = new Map<string, bigint>();
  for (const line of readFileSync(logPath, "utf8").split("\n")) {
    if (!line) continue;
    const r = parseTokenLine(line);
    if (r instanceof Error) throw r;
    const owed =
      BigInt(r.promptTokens) * rates.TOKIN +
      BigInt(r.completionTokens) * rates.TOKOUT;
    pay.set(r.operator, (pay.get(r.operator) ?? 0n) + owed);
  }
  return pay;
}

async function rehearse(): Promise<void> {
  prepareRunDir(RUN, process.argv.includes("--clean"));

  const network = await startNetwork(RUN, { log });
  try {
    const { adminPort, appPort } = network;

    // The program's agents: the harvester, and the operators it pays.
    const harvester = await network.installAgent("harvester");
    const operators = [
      await network.installAgent("operator-1"),
      await network.installAgent("operator-2"),
    ];
    log(`harvester ${harvester}`);

    // HoloFuel as MainNet has it, with the harvester's HF credit lifted.
    log("standing up HoloFuel (unyt_cli progenitor holofuel setup)");
    await standUpHoloFuel(network, {
      harvester,
      harvesterCreditHf: "1000",
    });

    // Net Zero: create the program's lane, with the harvester as its editor.
    const progenitor = await appCall(adminPort, appPort, PROGENITOR_APP_ID);
    const laneConfig = JSON.parse(
      readFileSync(join(ROOT, "config/lanes/llm-tokens.json"), "utf8"),
    ) as LaneConfig;
    const firstWindowMs = MINUTE;
    const { laneId } = await createProgramLane(
      progenitor.call,
      laneConfig,
      harvester,
      { firstWindowMs },
    );
    const laneCreatedAt = Date.now();
    log(`Net Zero created lane ${laneId}`);

    // The program: publish its agreement.
    const harvesterApp = await appCall(adminPort, appPort, "harvester");
    const { agreementId } = await provisionAgreement(harvesterApp.call, {
      harvesterPubKey: harvester,
      prices: DEFAULT_PRICE_SHEET,
      log,
    });
    const units = await hcUnitIndexBySymbol(harvesterApp.call);
    const hfIndex = String(units.get("HF"));
    await harvesterApp.close();

    // Net Zero: point the lane at the agreement. The new version comes into
    // force when the lane's first window ends.
    const definitionId = await wireProofOfService(
      progenitor.call,
      laneId,
      agreementId,
      { durationMs: 30 * 24 * 60 * MINUTE },
    );
    await progenitor.close();
    log(`Net Zero wired proof_of_service → ${agreementId}`);

    // Three minutes of synthetic token use, in windows that have ended.
    const tokenLog = join(RUN, "token-usage.jsonl");
    const start = Math.floor(Date.now() / MINUTE) * MINUTE - 3 * MINUTE;
    generateTokens({
      path: tokenLog,
      operators,
      start,
      minutes: 3,
      requestsPerMinute: 10,
      seed: 1,
    });

    const env = {
      STORE_PATH: join(RUN, "harvester.db"),
      SOURCE: "tokens",
      TOKEN_LOG_PATH: tokenLog,
      WINDOW_MS: String(MINUTE),
      INVOICE_PERIOD_MS: String(MINUTE),
      AGREEMENT_ID: agreementId,
      LANE_DEFINITION_IDS: definitionId,
      HC_ADMIN_PORT: String(adminPort),
      HC_APP_PORT: String(appPort),
      HC_APP_ID: "harvester",
      HC_CREDS_PATH: join(RUN, "harvester-hc-creds.json"),
      FUND_MIN_HF: "50",
      FUND_TOP_UP_HF: "100",
    };
    run("hc-init.js", [], env);
    run("process.js", [], env);

    const inForceAt = laneCreatedAt + firstWindowMs + 5_000;
    if (Date.now() < inForceAt) {
      log(
        `waiting ${Math.ceil((inForceAt - Date.now()) / 1000)}s for the wired lane version`,
      );
      await sleep(inForceAt - Date.now());
    }
    run("invoice.js", ["--drain"], env);

    // Each operator accepts the HF the execution allocated to it.
    const expected = expectedPay(tokenLog, {
      TOKIN: rateToMicroHf(DEFAULT_PRICE_SHEET.hfPerUnit.TOKIN),
      TOKOUT: rateToMicroHf(DEFAULT_PRICE_SHEET.hfPerUnit.TOKOUT),
    });
    let failed = false;
    for (const [i, operator] of operators.entries()) {
      const app = await appCall(adminPort, appPort, `operator-${i + 1}`);
      try {
        const incoming = await until(
          "an incoming payment",
          120_000,
          async () => {
            const raves = (await app.call(
              "get_incoming_raves",
              null,
            )) as Array<{
              id: string;
            }>;
            return raves.length > 0 ? raves : undefined;
          },
        );
        for (const rave of incoming) {
          await app.call("create_receipt_from_rave", {
            hash: rave.id,
            note: null,
          });
        }
        const ledger = (await app.call("get_ledger", null)) as {
          balance?: Record<string, string | number>;
        };
        const paid = String(ledger.balance?.[hfIndex] ?? "0");
        const want = microToHf(expected.get(operator) ?? 0n);
        const ok =
          Number(paid) > 0 &&
          Number(paid).toFixed(6) === Number(want).toFixed(6);
        failed ||= !ok;
        console.log(
          `operator-${i + 1} ${operator.slice(0, 12)}…  paid ${paid} HF  expected ${want} HF  ${ok ? "ok" : "MISMATCH"}`,
        );
      } finally {
        await app.close();
      }
    }
    if (failed)
      throw new Error("rehearsal FAIL: an operator was not paid as priced");
    console.log("rehearsal PASS");
  } finally {
    await network.stop();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  rehearse().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
