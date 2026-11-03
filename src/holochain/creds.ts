import * as fs from "node:fs/promises";
import { EncCreds } from "./types.js";

/**
 * On-disk Holochain signing creds + app-auth token, written by `hc:init` and
 * read by the invoice job. These are regenerated on every Holochain restart, so
 * the file is transient bookkeeping, not a long-lived secret store.
 */
export interface HcCredsFile {
  hcCreds: EncCreds;
  hcToken: string;
}

export async function writeCreds(
  path: string,
  data: HcCredsFile,
): Promise<void> {
  await fs.writeFile(path, JSON.stringify(data, null, 2) + "\n", {
    encoding: "utf8",
    mode: 0o600,
  });
}

export async function readCreds(path: string): Promise<HcCredsFile> {
  const data = JSON.parse(await fs.readFile(path, "utf8"));
  if (
    !data ||
    typeof data !== "object" ||
    typeof data.hcToken !== "string" ||
    !data.hcCreds ||
    typeof data.hcCreds !== "object"
  ) {
    throw new Error(`invalid hc creds file at ${path} — re-run hc:init`);
  }
  return data as HcCredsFile;
}
