import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createProgramLane,
  wireProofOfService,
  LaneConfig,
} from "../../src/rehearsal/net-zero.js";

const EDITOR = "uhCAkwVCV9IeFnzNfa73VbXL246eBcVqxpl3_RZnU0xnpvX5MXnpE";
const MINUTE_US = 60_000_000;

const config: LaneConfig = {
  basic_properties: {
    name: "LLMTokens",
    abbreviation: "LLMT",
    description: "d",
    url: "u",
    theme: "#000",
  },
  unit_definitions: [
    {
      unit_type: { MeasurementUnit: { precision: 6 } },
      unit_symbol: "TOKIN",
      unit_name: "Input tokens",
      unit_description: "-",
      unit_color: "#111",
    },
  ],
};

/** An existing lane, as get_all_lane returns it. */
const existing = {
  basic_properties: { id: "uhCkkWTL", name: "WindTunnel", abbreviation: "WTL" },
  definition: {
    origin_id: "uhCkkWTL",
    definition_hash: "uhCkkWTLdef",
    effective_start_date: 1,
    expiration_date: 2,
    rave_agreements: {
      credit_limit_adjustment: null,
      bridging_agreement: null,
      proof_of_service: "uhCkkPOS",
    },
    special_agents: {
      bridging_agent: { pub_key: "x", address_book_data: null },
    },
    additional_rave_agreements: [],
    additional_special_agents: [],
    service_units: { "5": "uhCkkU5" },
  },
};

test("createProgramLane sends the lane units and names the editor", async () => {
  const calls: Array<[string, any]> = [];
  const created = {
    basic_properties: { id: "uhCkkNEWLANE", name: "LLMTokens" },
    definition: { ...existing.definition, definition_hash: "uhCkkNEWDEF" },
  };
  let lanes: unknown[] = [existing];
  const r = await createProgramLane(
    async (fn, payload) => {
      calls.push([fn, payload]);
      if (fn === "get_all_lane") return lanes;
      lanes = [existing, created];
      // initialize_lane answers with the lane's first definition hash.
      return "uhCkkNEWDEF";
    },
    config,
    EDITOR,
    { now: () => 1_000, firstWindowMs: 90_000 },
  );
  assert.deepEqual(
    calls.map(([fn]) => fn),
    ["get_all_lane", "initialize_lane", "get_all_lane"],
  );
  const init = calls[1][1];
  assert.deepEqual(init.basic_properties.lane_editors, [EDITOR]);
  assert.equal(init.basic_properties.name, "LLMTokens");
  assert.deepEqual(init.unit_definitions, config.unit_definitions);
  assert.equal(init.definition.effective_start_date, 1_000_000);
  assert.equal(init.definition.expiration_date, 1_000_000 + 1.5 * MINUTE_US);
  assert.equal("origin_id" in init.definition, false);
  assert.equal("definition_hash" in init.definition, false);
  assert.deepEqual(init.definition.service_units, {});
  assert.deepEqual(r, { laneId: "uhCkkNEWLANE", definitionId: "uhCkkNEWDEF" });
});

test("wireProofOfService keeps the lane's units and windows and sets proof_of_service", async () => {
  const calls: Array<[string, any]> = [];
  const lane = {
    ...existing,
    basic_properties: { id: "uhCkkNEWLANE", name: "LLMTokens" },
    definition: { ...existing.definition, origin_id: "uhCkkNEWLANE" },
  };
  await wireProofOfService(
    async (fn, payload) => {
      calls.push([fn, payload]);
      return fn === "get_all_lane" ? [existing, lane] : new Uint8Array(39);
    },
    "uhCkkNEWLANE",
    "uhCkkAGREEMENT",
    { durationMs: 60_000 },
  );
  const update = calls.find(([fn]) => fn === "update_lane_definition")![1];
  assert.equal(update.origin_id, "uhCkkNEWLANE");
  assert.equal(update.rave_agreements.proof_of_service, "uhCkkAGREEMENT");
  assert.deepEqual(update.service_units, { "5": "uhCkkU5" });
  assert.deepEqual(update.special_agents, existing.definition.special_agents);
  assert.equal(update.expiration_date - update.effective_start_date, MINUTE_US);
  assert.equal("definition_hash" in update, false);
});
