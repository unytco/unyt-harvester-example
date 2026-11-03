import { test } from "node:test";
import assert from "node:assert/strict";
import {
  envDecimal,
  loadConfig,
  loadOpsConfig,
  requireLaneDefinitionIds,
} from "../src/config.js";

test("requires NOMAD_ADDR", () => {
  assert.throws(() => loadConfig({}), /NOMAD_ADDR is required/);
  assert.throws(
    () => loadConfig({ NOMAD_ADDR: "   " }),
    /NOMAD_ADDR is required/,
  );
});

test("strips trailing slashes from the Nomad address", () => {
  assert.equal(
    loadConfig({ NOMAD_ADDR: "http://h:4646///" }).nomadAddr,
    "http://h:4646",
  );
});

test("blank optional values become undefined", () => {
  const c = loadConfig({
    NOMAD_ADDR: "http://h:4646",
    NOMAD_TOKEN: "  ",
    NOMAD_REGION: "",
  });
  assert.equal(c.nomadToken, undefined);
  assert.equal(c.nomadRegion, undefined);
});

test("trims token and region when present", () => {
  const c = loadConfig({
    NOMAD_ADDR: "http://h:4646",
    NOMAD_TOKEN: "  tok  ",
    NOMAD_REGION: " eu ",
  });
  assert.equal(c.nomadToken, "tok");
  assert.equal(c.nomadRegion, "eu");
});

test("NOMAD_SKIP_VERIFY parses common truthy spellings", () => {
  for (const v of ["1", "true", "TRUE", "yes", "on"]) {
    assert.equal(
      loadConfig({ NOMAD_ADDR: "http://h", NOMAD_SKIP_VERIFY: v })
        .nomadSkipTlsVerify,
      true,
      `${v} should be truthy`,
    );
  }
  for (const v of ["", "0", "false", "no", "nope"]) {
    assert.equal(
      loadConfig({ NOMAD_ADDR: "http://h", NOMAD_SKIP_VERIFY: v })
        .nomadSkipTlsVerify,
      false,
      `${v} should be falsy`,
    );
  }
});

test("storePath defaults and can be overridden", () => {
  assert.equal(
    loadConfig({ NOMAD_ADDR: "http://h" }).storePath,
    "./unyt-harvester-example.db",
  );
  assert.equal(
    loadConfig({ NOMAD_ADDR: "http://h", STORE_PATH: " ./data.db " }).storePath,
    "./data.db",
  );
});

test("funding settings load from the env", () => {
  const c = loadOpsConfig({
    FUND_MIN_HF: "2",
    FUND_TOP_UP_HF: "10",
    BALANCE_ALERT_HF: "5",
  });
  assert.equal(c.fundMinHf, "2");
  assert.equal(c.fundTopUpHf, "10");
  assert.equal(c.balanceAlertHf, "5");
});

test("FUND_MIN_HF without FUND_TOP_UP_HF is rejected", () => {
  assert.throws(() => loadOpsConfig({ FUND_MIN_HF: "2" }), /FUND_TOP_UP_HF/);
  assert.throws(() => loadOpsConfig({ FUND_TOP_UP_HF: "2" }), /FUND_MIN_HF/);
});

test("funding settings default to off", () => {
  const c = loadOpsConfig({});
  assert.equal(c.fundMinHf, undefined);
  assert.equal(c.balanceAlertHf, undefined);
});

test("envDecimal accepts plain decimals and rejects other text", () => {
  assert.equal(envDecimal(""), undefined);
  assert.equal(envDecimal("2.5"), "2.5");
  assert.throws(() => envDecimal("abc"), /abc/);
  assert.throws(() => envDecimal("-1"), /-1/);
  assert.throws(() => envDecimal("1."), /1\./);
});

test("AGENT_REFRESH_MS defaults to five minutes and can be overridden", () => {
  assert.equal(loadConfig({ NOMAD_ADDR: "http://h" }).agentRefreshMs, 300000);
  assert.equal(
    loadConfig({ NOMAD_ADDR: "http://h", AGENT_REFRESH_MS: "60000" })
      .agentRefreshMs,
    60000,
  );
});

test("SOURCE defaults to tokens and rejects an unknown source", () => {
  const c = loadOpsConfig({});
  assert.equal(c.source, "tokens");
  assert.equal(c.tokenLogPath, "./token-usage.jsonl");
  assert.equal(loadOpsConfig({ SOURCE: "nomad" }).source, "nomad");
  assert.throws(() => loadOpsConfig({ SOURCE: "kafka" }), /SOURCE/);
});

test("requireLaneDefinitionIds refuses a real invoice run without a pinned lane", () => {
  assert.throws(
    () => requireLaneDefinitionIds(loadOpsConfig({})),
    /LANE_DEFINITION_IDS/,
  );
  assert.deepEqual(
    requireLaneDefinitionIds(loadOpsConfig({ LANE_DEFINITION_IDS: "uhCkkL" })),
    ["uhCkkL"],
  );
});
