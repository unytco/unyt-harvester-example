import { loadOpsConfig } from "../config.js";
import { hcInit } from "../holochain/hc-client.js";
import { writeCreds } from "../holochain/creds.js";

/**
 * One-time Holochain init: authorize signing credentials on the unyt cell and
 * issue an app-auth token, then persist them for the invoice job.
 *
 *   HC_ADMIN_PORT=… HC_APP_ID=unyt npm run hc:init
 *
 * The credentials do not survive a conductor restart. `invoice` and `fund`
 * refresh them automatically; run this for the other commands.
 */
export async function initHolochain(): Promise<void> {
  const config = loadOpsConfig();
  if (!config.hcAdminPort) {
    throw new Error("HC_ADMIN_PORT is required for hc:init");
  }
  console.error(
    `hc:init admin port ${config.hcAdminPort} app '${config.hcAppId}' ` +
      `-> ${config.credsPath}`,
  );
  const creds = await hcInit(config.hcAdminPort, config.hcAppId);
  await writeCreds(config.credsPath, creds);
  console.log(`wrote signing creds + token to ${config.credsPath}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  initHolochain().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
