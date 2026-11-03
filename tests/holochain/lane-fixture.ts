import { decodeHashFromBase64, encodeHashToBase64 } from "@holochain/client";
import { encode } from "@msgpack/msgpack";
import { ZomeCall } from "../../src/holochain/lanes.js";

/** A "u"-prefixed ActionHash whose 36 payload bytes are all `fill`. */
export const hash = (fill: number): string =>
  encodeHashToBase64(
    new Uint8Array([0x84, 0x29, 0x24, ...Array(36).fill(fill)]),
  );

export const HOUR = 3_600_000;
export const DAY = 24 * HOUR;
export const NOW = 20_000 * DAY;

export interface FakeVersion {
  hash: string;
  /** The version this one replaces; null for the lane's first version. */
  previous: string | null;
  startMs: number;
  expiryMs: number;
}

export interface FakeLane {
  laneId: string;
  name: string;
  /** The newest definition hash; null for a lane with no definition yet. */
  newest: string | null;
}

export interface LaneFixture {
  lanes: FakeLane[];
  versions: FakeVersion[];
  /** `get_lane_definitions_in_force`: newest hash → the hash in force. */
  inForce: Record<string, string>;
}

/** The three transactor calls the lane reader makes, answered from a fixture. */
export function fakeLaneCalls(
  fixture: LaneFixture,
): ZomeCall & { calls: string[] } {
  const calls: string[] = [];
  const call: ZomeCall = async (fnName, payload) => {
    calls.push(fnName);
    switch (fnName) {
      case "get_all_lane":
        return fixture.lanes.map((lane) => ({
          basic_properties: {
            id: lane.laneId,
            name: lane.name,
            abbreviation: lane.name,
          },
          definition:
            lane.newest === null
              ? undefined
              : {
                  definition_hash: lane.newest,
                  service_units: { "5": {}, "6": {} },
                  rave_agreements: { proof_of_service: "uhCkkPOS" },
                },
        }));
      case "get_lane_definitions_in_force":
        return (payload as Uint8Array[])
          .map((bytes) => fixture.inForce[encodeHashToBase64(bytes)])
          .filter((h): h is string => h !== undefined)
          .map((h) => decodeHashFromBase64(h));
      case "hdk_must_get_valid_record": {
        const wanted = encodeHashToBase64(payload as Uint8Array);
        const version = fixture.versions.find((v) => v.hash === wanted);
        if (!version) throw new Error(`no record at ${wanted}`);
        return {
          signed_action: {
            hashed: {
              hash: payload,
              // Holochain 0.7: common fields under `header`, the variant under
              // `data`, tagged by `type`.
              content: {
                header: { timestamp: version.startMs * 1000 },
                data: version.previous
                  ? {
                      type: "Update",
                      original_action_address: decodeHashFromBase64(
                        version.previous,
                      ),
                    }
                  : { type: "Create" },
              },
            },
          },
          entry: {
            Present: {
              entry_type: "App",
              entry: encode({
                effective_start_date: version.startMs * 1000,
                expiration_date: version.expiryMs * 1000,
              }),
            },
          },
        };
      }
      default:
        throw new Error(`unexpected zome call ${fnName}`);
    }
  };
  return Object.assign(call, { calls });
}

export const LANE = hash(1);
export const FIRST = hash(2);
export const SECOND = hash(3);

/** The brief's LLMTokens lane: the first version is in force until NOW + 1h,
 * the second (newest) begins then and runs 30 days. */
export function windTunnelFixture(): LaneFixture {
  return {
    lanes: [{ laneId: LANE, name: "LLMTokens", newest: SECOND }],
    versions: [
      {
        hash: FIRST,
        previous: null,
        startMs: NOW - DAY,
        expiryMs: NOW + HOUR,
      },
      {
        hash: SECOND,
        previous: FIRST,
        startMs: NOW + HOUR,
        expiryMs: NOW + HOUR + 30 * DAY,
      },
    ],
    inForce: { [SECOND]: FIRST },
  };
}
