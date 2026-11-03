import { loadConfig, OpsConfig } from "../config.js";
import { Source } from "./source.js";
import { tokenSource } from "./tokens/source.js";
import { nomadSource } from "./nomad/source.js";
import { SqliteNomadStore } from "./nomad/store.js";
import { NomadClient } from "./nomad/client.js";

/** The source `SOURCE` names, sharing the store's SQLite file. */
export async function openSource(
  config: OpsConfig,
  log: (msg: string) => void,
): Promise<Source> {
  switch (config.source) {
    case "tokens":
      return tokenSource({
        dbPath: config.storePath,
        logPath: config.tokenLogPath,
        log,
      });
    case "nomad": {
      // With NOMAD_ADDR set, each run also catches up from Nomad directly;
      // without it, `process` reads only what `watch` has stored.
      const client = process.env.NOMAD_ADDR
        ? new NomadClient(loadConfig())
        : undefined;
      return nomadSource({
        store: new SqliteNomadStore(config.storePath),
        client,
        log,
      });
    }
  }
}
