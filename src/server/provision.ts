import * as readline from "node:readline/promises";
import { parseArgs } from "node:util";
import {
  AdminWebsocket,
  AppWebsocket,
  setSigningCredentials,
  decodeHashFromBase64,
  encodeHashToBase64,
} from "@holochain/client";
import {
  hcInit,
  allianceCellId,
  decCreds,
  fromB64,
  closeApp,
} from "../holochain/hc-client.js";
import {
  AGREEMENT_TITLE,
  DEFAULT_PRICE_SHEET,
} from "../agreement/definition.js";
import {
  parsePrices,
  provisionAgreement,
  rotationPlan,
} from "../agreement/provision.js";
import {
  PIPELINE_ORIGIN,
  appInterfacePort,
} from "../holochain/app-interface.js";

/**
 * Author the proof-of-service agreement as the connected agent: publish the
 * price sheet and the embedded code template, then create the smart agreement
 * that pins them. Prints the resulting `ea_id` on stdout.
 *
 *   npm run provision -- --harvester-pubkey uhCAk... \
 *     --price TOKIN=0.000001 --price TOKOUT=0.000004 --yes
 *
 * Rotating an existing agreement: `--from <ea_id>` reuses its code template
 * and price sheet; `--new-template` / `--new-price-sheet` republish one part.
 *
 * Flags:
 *   --harvester-pubkey <b64> the agent holding both roles and executing
 *                            (default: the connected agent)
 *   --price SYMBOL=rate      HF per unit, repeatable (default TOKIN/TOKOUT rates)
 *   --from <ea_id>           reuse this agreement's template and price sheet
 *   --new-template           with --from: publish a new code template
 *   --new-price-sheet        with --from: publish a new price sheet
 *   --title <str>            agreement title
 *   --tag <str>              public tag the Unyt UI groups by
 *   --admin-port / --app-port / --app-id   override HC_ADMIN_PORT / HC_APP_PORT / HC_APP_ID
 *   --yes                    skip the confirmation prompt
 */
export async function provisionCli(): Promise<void> {
  const { values } = parseArgs({
    options: {
      "harvester-pubkey": { type: "string" },
      price: { type: "string", multiple: true },
      from: { type: "string" },
      "new-template": { type: "boolean", default: false },
      "new-price-sheet": { type: "boolean", default: false },
      title: { type: "string", default: AGREEMENT_TITLE },
      tag: { type: "string", default: "proof-of-service" },
      "admin-port": { type: "string" },
      "app-port": { type: "string" },
      "app-id": { type: "string" },
      yes: { type: "boolean", default: false },
    },
  });
  const adminPort = Number(values["admin-port"] ?? process.env.HC_ADMIN_PORT);
  const appId = values["app-id"] ?? process.env.HC_APP_ID ?? "unyt";
  if (!Number.isInteger(adminPort) || adminPort <= 0) {
    throw new Error("missing --admin-port or HC_ADMIN_PORT");
  }
  const appPortArg = values["app-port"] ?? process.env.HC_APP_PORT?.trim();
  const givenAppPort = appPortArg ? Number(appPortArg) : undefined;
  const prices = values.price ? parsePrices(values.price) : DEFAULT_PRICE_SHEET;
  if (values.from !== undefined) decodeHashFromBase64(values.from);
  if (values["harvester-pubkey"] !== undefined) {
    decodeHashFromBase64(values["harvester-pubkey"]);
  }
  const plan = rotationPlan({
    from: values.from,
    newTemplate: values["new-template"],
    newPriceSheet: values["new-price-sheet"],
    ratesGiven: values.price !== undefined,
  });

  const { hcCreds, hcToken } = await hcInit(adminPort, appId);
  const admin = await AdminWebsocket.connect({
    url: new URL(`ws://127.0.0.1:${adminPort}`),
    wsClientOptions: { origin: PIPELINE_ORIGIN },
  });
  let appPort: number;
  try {
    appPort = await appInterfacePort(admin, appId, givenAppPort);
  } finally {
    await admin.client.close();
  }
  const app = await AppWebsocket.connect({
    url: new URL(`ws://127.0.0.1:${appPort}`),
    token: Array.from(fromB64(hcToken)),
    wsClientOptions: { origin: PIPELINE_ORIGIN },
  });
  try {
    const info = await app.appInfo();
    if (!info) throw new Error("appInfo returned null");
    const cell_id = allianceCellId(info.cell_info);
    setSigningCredentials(cell_id, decCreds(hcCreds));
    const call = (fn: string, payload: unknown): Promise<any> =>
      app.callZome({ cell_id, zome_name: "transactor", fn_name: fn, payload });
    const creator = encodeHashToBase64(await call("whoami", null));
    const harvesterPubKey = values["harvester-pubkey"] ?? creator;

    console.error(
      `[provision] about to create smart agreement:\n` +
        `  title:   ${values.title}\n` +
        `  app:     ${appId}\n` +
        `  prices:  ${JSON.stringify(prices.hfPerUnit)} HF per unit` +
        (values.from ? ` (rotating ${values.from})` : "") +
        `\n  invoicer, funder, executor: ${harvesterPubKey}`,
    );
    if (!values.yes) {
      const rl = readline.createInterface({
        input: process.stdin,
        output: process.stderr,
      });
      const answer = await rl.question(
        `[provision] this cannot be undone. Type "yes" to proceed: `,
      );
      rl.close();
      if (answer.trim() !== "yes") throw new Error("aborted");
    }
    const r = await provisionAgreement(call, {
      harvesterPubKey,
      prices,
      title: values.title,
      tag: values.tag,
      from: values.from,
      plan,
      log: (m) => console.error(`[provision] ${m}`),
    });
    console.log(r.agreementId);
  } finally {
    await closeApp(app);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  provisionCli().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
