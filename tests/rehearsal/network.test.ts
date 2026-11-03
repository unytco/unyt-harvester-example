import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  assertSeedApplied,
  newNetworkSeed,
  prepareRunDir,
} from "../../src/rehearsal/network.js";

test("two startNetwork seeds differ", () => {
  const a = newNetworkSeed();
  const b = newNetworkSeed();
  assert.notEqual(a, b);
  assert.match(a, /^[0-9a-f-]{36}$/);
});

test("assertSeedApplied accepts the installed seed", () => {
  assert.doesNotThrow(() => assertSeedApplied({ network_seed: "s-1" }, "s-1"));
});

test("assertSeedApplied refuses a DNA without the generated seed", () => {
  assert.throws(
    () => assertSeedApplied({ network_seed: "" }, "s-1"),
    /network seed not applied/,
  );
  assert.throws(
    () => assertSeedApplied({ network_seed: "s-2" }, "s-1"),
    /network seed not applied/,
  );
});

test("prepareRunDir refuses a used directory unless told to clean it", () => {
  const dir = mkdtempSync(join(tmpdir(), "rehearsal-"));
  writeFileSync(join(dir, "network.json"), "{}");
  assert.throws(() => prepareRunDir(dir, false), /--clean/);
  prepareRunDir(dir, true);
  assert.equal(existsSync(dir), false);
  assert.doesNotThrow(() => prepareRunDir(dir, false));
});
