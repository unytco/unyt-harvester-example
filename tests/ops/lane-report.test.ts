import { test } from "node:test";
import assert from "node:assert/strict";
import { laneReportLines } from "../../src/ops/lane-report.js";
import { LaneLineage } from "../../src/holochain/lanes.js";
import {
  DAY,
  FIRST,
  HOUR,
  LANE,
  NOW,
  SECOND,
  hash,
} from "../holochain/lane-fixture.js";

function windTunnel(): LaneLineage {
  return {
    laneId: LANE,
    name: "LLMTokens",
    abbreviation: "LLMT",
    serviceUnitIndexes: ["5", "6"],
    proofOfService: "uhCkkPOS",
    versions: [
      {
        hash: SECOND,
        effectiveStartMs: NOW + HOUR,
        expirationMs: NOW + HOUR + 30 * DAY,
      },
      { hash: FIRST, effectiveStartMs: NOW - DAY, expirationMs: NOW + HOUR },
    ],
    inForceHash: FIRST,
    readError: null,
  };
}

const iso = (ms: number) => new Date(ms).toISOString();

test("laneReportLines marks the configured version", () => {
  const lines = laneReportLines([windTunnel()], {
    agreementId: "uhCkkPOS",
    configuredLaneIds: [SECOND],
    nowMs: NOW,
  });
  assert.deepEqual(lines, [
    "LLMTokens          units=[5,6]",
    `  definition (newest):   ${SECOND}  ${iso(NOW + HOUR)} to ${iso(NOW + HOUR + 30 * DAY)}   ← LANE_DEFINITION_IDS`,
    `  definition (in force): ${FIRST}  ${iso(NOW - DAY)} to ${iso(NOW + HOUR)}`,
    "  proof_of_service:      uhCkkPOS   ← AGREEMENT_ID",
    "(1 lane)",
  ]);
});

test("laneReportLines marks an older configured version on its own line", () => {
  const lane = windTunnel();
  const third = hash(4);
  lane.versions.unshift({
    hash: third,
    effectiveStartMs: NOW + HOUR + 30 * DAY,
    expirationMs: NOW + HOUR + 60 * DAY,
  });
  lane.inForceHash = FIRST;
  const lines = laneReportLines([lane], {
    agreementId: "other",
    configuredLaneIds: [SECOND],
    nowMs: NOW,
  });
  assert.equal(
    lines[3],
    `  definition (older):    ${SECOND}  ${iso(NOW + HOUR)} to ${iso(NOW + HOUR + 30 * DAY)}   ← LANE_DEFINITION_IDS`,
  );
  assert.equal(lines[4], "  proof_of_service:      uhCkkPOS");
});

test("laneReportLines says when nothing is in force and names the next boundary", () => {
  const lane = windTunnel();
  lane.inForceHash = null;
  lane.versions[1].effectiveStartMs = NOW + HOUR;
  const lines = laneReportLines([lane], {
    agreementId: "other",
    configuredLaneIds: [],
    nowMs: NOW,
  });
  assert.equal(
    lines[2],
    `  definition (in force): none; the next begins at ${iso(NOW + HOUR)}`,
  );
});

test("a lane with no definition prints without a window", () => {
  const lines = laneReportLines(
    [
      {
        laneId: hash(9),
        name: null,
        abbreviation: null,
        serviceUnitIndexes: [],
        proofOfService: null,
        versions: [],
        inForceHash: null,
        readError: null,
      },
    ],
    { agreementId: "other", configuredLaneIds: [], nowMs: NOW },
  );
  assert.deepEqual(lines, [
    "(unnamed)          units=[]",
    "  definition (newest):   —",
    "  definition (in force): none",
    "  proof_of_service:      —",
    "(1 lane)",
  ]);
});

test("laneReportLines with no lanes", () => {
  assert.deepEqual(
    laneReportLines([], { agreementId: "x", configuredLaneIds: [], nowMs: 0 }),
    ["(no lanes)"],
  );
});

test("laneReportLines shows a lane that could not be read", () => {
  const lane = windTunnel();
  lane.readError = "no record at uhCkkX";
  const lines = laneReportLines([lane], {
    agreementId: "other",
    configuredLaneIds: [],
    nowMs: NOW,
  });
  assert.equal(lines[1], "  read error:            no record at uhCkkX");
});
