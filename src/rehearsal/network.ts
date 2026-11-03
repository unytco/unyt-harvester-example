import { ChildProcess, spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  AdminWebsocket,
  AgentPubKey,
  encodeHashToBase64,
  decodeHashFromBase64,
} from "@holochain/client";

/**
 * A private HoloFuel network on this machine: one conductor, the production
 * `unyt.happ`, a fresh random network seed and a stand-in progenitor. It has
 * the production DNA and unit layout but a different DNA hash, so it never
 * meets MainNet or any other network.
 */

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const BIN = join(ROOT, ".rehearsal/bin");
const ORIGIN = "unyt-harvester-example";
export const PROGENITOR_APP_ID = "unyt-progenitor";

/**
 * A rehearsal starts from nothing: a directory an earlier run used is removed
 * with `clean`, and refused without it, so a stale conductor is never reused.
 */
export function prepareRunDir(dir: string, clean: boolean): void {
  if (!existsSync(dir)) return;
  if (!clean) {
    throw new Error(
      `${dir} exists from an earlier run; run npm run rehearse -- --clean`,
    );
  }
  rmSync(dir, { recursive: true, force: true });
}

export function newNetworkSeed(): string {
  return randomUUID();
}

/** Throw unless the installed DNA carries the seed this network generated. */
export function assertSeedApplied(
  modifiers: { network_seed: string },
  seed: string,
): void {
  if (modifiers.network_seed !== seed) {
    throw new Error(
      `network seed not applied: installed DNA has ` +
        `${JSON.stringify(modifiers.network_seed)}, expected ${seed}`,
    );
  }
}

export interface LocalNetwork {
  dir: string;
  adminPort: number;
  appPort: number;
  seed: string;
  dnaHash: string;
  progenitor: string;
  admin: AdminWebsocket;
  /** A new agent key in this conductor's keystore. */
  newAgent(): Promise<string>;
  /** Install the unyt app on this network for `agent` (a new key if absent). */
  installAgent(appId: string, agent?: string): Promise<string>;
  stop(): Promise<void>;
}

async function waitForReady(child: ChildProcess, logPath: string) {
  let output = "";
  await new Promise<void>((resolveReady, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`conductor not ready after 60s; see ${logPath}`)),
      60_000,
    );
    const onData = (chunk: Buffer) => {
      output += chunk.toString();
      writeFileSync(logPath, output);
      if (output.includes("Conductor ready.")) {
        clearTimeout(timer);
        resolveReady();
      }
    };
    child.stdout?.on("data", onData);
    child.stderr?.on("data", onData);
    child.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`conductor exited (${code}); see ${logPath}`));
    });
  });
  // Keep the log current after startup.
  child.stdout?.on("data", (c: Buffer) =>
    writeFileSync(logPath, (output += c)),
  );
  child.stderr?.on("data", (c: Buffer) =>
    writeFileSync(logPath, (output += c)),
  );
}

export async function startNetwork(
  dir: string,
  opts: {
    adminPort?: number;
    appPort?: number;
    log?: (m: string) => void;
  } = {},
): Promise<LocalNetwork> {
  const adminPort = opts.adminPort ?? 18800;
  const appPort = opts.appPort ?? 30000;
  const log = opts.log ?? (() => {});
  mkdirSync(dir, { recursive: true });

  const child = spawn(
    "bash",
    [
      join(ROOT, "rehearsal/conductor.sh"),
      join(dir, "conductor"),
      String(adminPort),
    ],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  const stop = async () => {
    if (child.exitCode !== null) return;
    const exited = new Promise((r) => child.once("exit", r));
    child.kill("SIGTERM");
    await exited;
  };
  try {
    await waitForReady(child, join(dir, "conductor.log"));
    const admin = await AdminWebsocket.connect({
      url: new URL(`ws://127.0.0.1:${adminPort}`),
      wsClientOptions: { origin: ORIGIN },
    });
    const happ = readFileSync(join(BIN, "unyt.happ"));
    const seed = newNetworkSeed();
    const progenitorKey = await admin.generateAgentPubKey();
    const progenitor = encodeHashToBase64(progenitorKey);
    // Every agent installs with the same modifiers, so they share one DNA.
    const modifiers = {
      network_seed: seed,
      properties: { progenitor_pubkey: progenitor },
    };
    const install = async (appId: string, agentKey: AgentPubKey) => {
      const info = await admin.installApp({
        source: { type: "bytes", value: happ },
        agent_key: agentKey,
        installed_app_id: appId,
        network_seed: seed,
        roles_settings: {
          alliance: { type: "provisioned", value: { modifiers } },
        },
      });
      await admin.enableApp({ installed_app_id: appId });
      const cell = info.cell_info.alliance[0];
      if (cell.type !== "provisioned") throw new Error("no provisioned cell");
      return cell.value.cell_id;
    };

    const cellId = await install(PROGENITOR_APP_ID, progenitorKey);
    const def = await admin.getDnaDefinition(cellId);
    assertSeedApplied(def.modifiers, seed);
    await admin.attachAppInterface({ port: appPort, allowed_origins: "*" });
    const dnaHash = encodeHashToBase64(cellId[0]);
    writeFileSync(
      join(dir, "network.json"),
      JSON.stringify(
        { seed, dnaHash, progenitor, adminPort, appPort },
        null,
        2,
      ),
    );
    log(`network seed ${seed}, DNA ${dnaHash}, progenitor ${progenitor}`);

    const newAgent = async () =>
      encodeHashToBase64(await admin.generateAgentPubKey());
    return {
      dir,
      adminPort,
      appPort,
      seed,
      dnaHash,
      progenitor,
      admin,
      newAgent,
      async installAgent(appId: string, agent?: string) {
        const key = agent ?? (await newAgent());
        await install(appId, decodeHashFromBase64(key));
        return key;
      },
      async stop() {
        await admin.client.close();
        await stop();
      },
    };
  } catch (err) {
    await stop();
    throw err;
  }
}

/**
 * Stand up HoloFuel the way MainNet has it, with `unyt_cli progenitor holofuel
 * setup`: the HF unit and the network's own lanes and agreements. Every role
 * the command asks for gets a fresh key. The harvester is named a special
 * agent, which lifts its HF credit limit by `harvesterCreditHf`, so it can
 * fund payments on a network with no HF yet.
 */
export async function standUpHoloFuel(
  network: LocalNetwork,
  opts: { harvester: string; harvesterCreditHf: string },
): Promise<void> {
  const role = async (flag: string) => [`--${flag}`, await network.newAgent()];
  const flags = [
    ...(await role("hot-reserver")),
    ...(await role("hot-bridging-agent")),
    ...(await role("windtunnel-admin")),
    ...(await role("pricing-oracle")),
    ...(await role("fee-collector")),
    ...(await role("oracle")),
    ...(await role("global-infra-account")),
    ...(await role("holo-hosting-infra-account")),
    ...(await role("windtunnel-infra-account")),
    "--special-agent",
    `${opts.harvester}=${opts.harvesterCreditHf}`,
    "--no-hot-bridging-agreement",
  ];
  const r = unytCli(network, ["progenitor", "holofuel", "setup", ...flags]);
  writeFileSync(join(network.dir, "holofuel-setup.json"), r);
}

/** Run `unyt_cli` as the progenitor; returns stdout, throws on failure. */
export function unytCli(network: LocalNetwork, args: string[]): string {
  const r = spawnSync(
    join(BIN, "unyt_cli"),
    [
      "--admin-port",
      String(network.adminPort),
      "--app-port",
      String(network.appPort),
      "--app-id",
      PROGENITOR_APP_ID,
      "--conductor-config",
      join(network.dir, "conductor/config.yaml"),
      // The conductor's keystore runs in-process, so unyt_cli signs with a
      // capability grant instead of reaching lair.
      "--allow-cap-grant-signing",
      ...args,
    ],
    { encoding: "utf8", timeout: 300_000 },
  );
  if (r.status !== 0) {
    throw new Error(
      `unyt_cli ${args.join(" ")} failed: ${r.stderr || r.error}`,
    );
  }
  return r.stdout;
}

/** `--check`: stand up a network, print what it holds, and stop it. */
async function check(): Promise<void> {
  const dir = join(ROOT, ".rehearsal/check");
  const network = await startNetwork(dir, { log: (m) => console.error(m) });
  try {
    const harvester = await network.newAgent();
    await standUpHoloFuel(network, { harvester, harvesterCreditHf: "1000" });
    const units = JSON.parse(unytCli(network, ["progenitor", "units", "list"]));
    const lanes = JSON.parse(unytCli(network, ["progenitor", "lane", "list"]));
    console.log(`seed:  ${network.seed}`);
    console.log(`dna:   ${network.dnaHash}`);
    console.log(
      `units: ${units.map((u: any, i: number) => `${u.index ?? i}:${u.unit_symbol}`).join(" ")}`,
    );
    console.log(
      `lanes: ${lanes.map((l: any) => l.basic_properties?.name ?? "?").join(", ")}`,
    );
  } finally {
    await network.stop();
  }
}

if (
  import.meta.url === `file://${process.argv[1]}` &&
  process.argv.includes("--check")
) {
  check().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
