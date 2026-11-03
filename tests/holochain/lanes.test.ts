import { test } from "node:test";
import assert from "node:assert/strict";
import {
  readLaneLineages,
  resolveLaneDefinitions,
  resolveLanes,
} from "../../src/holochain/lanes.js";
import {
  DAY,
  FIRST,
  HOUR,
  LANE,
  NOW,
  SECOND,
  fakeLaneCalls,
  hash,
  windTunnelFixture,
} from "./lane-fixture.js";

test("readLaneLineages walks each lane from newest to first and asks the DNA what is in force", async () => {
  const call = fakeLaneCalls(windTunnelFixture());
  const lanes = await readLaneLineages(call);
  assert.equal(lanes.length, 1);
  const lane = lanes[0];
  assert.equal(lane.laneId, LANE);
  assert.equal(lane.name, "LLMTokens");
  assert.deepEqual(lane.serviceUnitIndexes, ["5", "6"]);
  assert.equal(lane.proofOfService, "uhCkkPOS");
  assert.deepEqual(
    lane.versions.map((v) => v.hash),
    [SECOND, FIRST],
  );
  assert.equal(lane.versions[1].effectiveStartMs, NOW - DAY);
  assert.equal(lane.versions[1].expirationMs, NOW + HOUR);
  assert.equal(lane.inForceHash, FIRST);
  // One in-force call per lane; the result cannot be mapped by position.
  assert.equal(
    call.calls.filter((c) => c === "get_lane_definitions_in_force").length,
    1,
  );
});

test("a lane without a definition is read with no versions", async () => {
  const fixture = windTunnelFixture();
  fixture.lanes.push({ laneId: hash(9), name: "Empty", newest: null });
  const lanes = await readLaneLineages(fakeLaneCalls(fixture));
  assert.equal(lanes.length, 2);
  assert.deepEqual(lanes[1].versions, []);
  assert.equal(lanes[1].inForceHash, null);
  // Resolution ignores it: the pinned LLMTokens lane still resolves.
  const resolved = resolveLaneDefinitions([SECOND], lanes, NOW);
  assert.equal(resolved.length, 1);
});

test("a pinned newest version that has not begun resolves to the earlier version in force", async () => {
  const lines: string[] = [];
  const cited = await resolveLanes(
    fakeLaneCalls(windTunnelFixture()),
    [SECOND],
    NOW,
    (m) => lines.push(m),
  );
  assert.deepEqual(cited, [FIRST]);
  assert.deepEqual(lines, [
    `lane LLMTokens: pinned ${SECOND.slice(0, 10)}… → in force ${FIRST.slice(0, 10)}…`,
  ]);
});

test("a pinned version that expired resolves to the newest version in force", async () => {
  // Past the boundary: the second version is in force and the first expired.
  const fixture = windTunnelFixture();
  fixture.inForce = { [SECOND]: SECOND };
  const later = NOW + 2 * HOUR;
  const cited = await resolveLanes(
    fakeLaneCalls(fixture),
    [FIRST],
    later,
    () => {},
  );
  assert.deepEqual(cited, [SECOND]);
});

test("a pinned version that is in force logs that and cites itself", async () => {
  const lines: string[] = [];
  const cited = await resolveLanes(
    fakeLaneCalls(windTunnelFixture()),
    [FIRST],
    NOW,
    (m) => lines.push(m),
  );
  assert.deepEqual(cited, [FIRST]);
  assert.deepEqual(lines, [
    `lane LLMTokens: pinned ${FIRST.slice(0, 10)}… is in force`,
  ]);
});

test("nothing in force fails the run naming the lane and the next boundary", async () => {
  // Both versions begin in the future; the DNA answers with nothing.
  const fixture = windTunnelFixture();
  fixture.versions[0].startMs = NOW + HOUR;
  fixture.versions[0].expiryMs = NOW + 2 * HOUR;
  fixture.versions[1].startMs = NOW + 2 * HOUR;
  fixture.inForce = {};
  await assert.rejects(
    resolveLanes(fakeLaneCalls(fixture), [SECOND], NOW, () => {}),
    new RegExp(
      `lane LLMTokens: no definition is in force; the next begins at ${new Date(NOW + HOUR).toISOString()}`,
    ),
  );
});

test("an expired version with no replacement fails the run", async () => {
  // A single version, begun and expired. The DNA still answers with it.
  const fixture = windTunnelFixture();
  fixture.lanes[0].newest = FIRST;
  fixture.versions = [fixture.versions[0]];
  fixture.inForce = { [FIRST]: FIRST };
  const later = NOW + 2 * HOUR;
  await assert.rejects(
    resolveLanes(fakeLaneCalls(fixture), [FIRST], later, () => {}),
    new RegExp(
      `lane LLMTokens: definition ${FIRST} expired at ${new Date(NOW + HOUR).toISOString()} and nothing replaces it`,
    ),
  );
});

test("a configured hash that belongs to no lane fails the run", async () => {
  const stranger = hash(7);
  await assert.rejects(
    resolveLanes(fakeLaneCalls(windTunnelFixture()), [stranger], NOW, () => {}),
    new RegExp(`LANE_DEFINITION_IDS names ${stranger}, which is no version`),
  );
});

test("two pinned versions of one lane cite it once", async () => {
  const cited = await resolveLanes(
    fakeLaneCalls(windTunnelFixture()),
    [FIRST, SECOND],
    NOW,
    () => {},
  );
  assert.deepEqual(cited, [FIRST]);
});

test("an empty configuration cites nothing and reads nothing", async () => {
  const call = fakeLaneCalls(windTunnelFixture());
  assert.deepEqual(await resolveLanes(call, [], NOW, () => {}), []);
  assert.deepEqual(call.calls, []);
});

test("a lane that cannot be read does not block resolving another", async () => {
  const fixture = windTunnelFixture();
  const broken = hash(8);
  fixture.lanes.unshift({ laneId: hash(9), name: "Broken", newest: broken });
  const cited = await resolveLanes(
    fakeLaneCalls(fixture),
    [SECOND],
    NOW,
    () => {},
  );
  assert.deepEqual(cited, [FIRST]);
  const lanes = await readLaneLineages(fakeLaneCalls(fixture));
  assert.match(lanes[0].readError ?? "", new RegExp(`no record at ${broken}`));
});

test("a pinned hash on a lane that could not be read names the read error", async () => {
  const fixture = windTunnelFixture();
  // The first version's record is missing, so the walk stops at the newest.
  fixture.versions = [fixture.versions[1]];
  await assert.rejects(
    resolveLanes(fakeLaneCalls(fixture), [FIRST], NOW, () => {}),
    new RegExp(`could not read lane LLMTokens: no record at ${FIRST}`),
  );
});

test("an in-force version missing from the lineage is a read error, not 'nothing in force'", async () => {
  const fixture = windTunnelFixture();
  fixture.versions = [fixture.versions[1]];
  await assert.rejects(
    resolveLanes(fakeLaneCalls(fixture), [SECOND], NOW, () => {}),
    /could not read lane LLMTokens/,
  );
});
