import { decodeHashFromBase64, encodeHashToBase64 } from "@holochain/client";
import { decode } from "@msgpack/msgpack";

/**
 * Which version of a lane's definition a spend must cite.
 *
 * A lane's definition has a version per edit or window extension, and their
 * windows tile: only one is in force at a time. `get_all_lane` names the
 * newest version, which is the pending one while an edit waits for its
 * boundary, and the DNA refuses a spend that cites a version whose window has
 * not begun or has ended. So each run reads every version of each configured
 * lane, asks the DNA which one is in force, and cites that.
 */

/** One transactor zome call over an open alliance cell. */
export type ZomeCall = (fnName: string, payload: unknown) => Promise<unknown>;

export interface LaneVersion {
  /** The version's ActionHash, "u"-prefixed base64url. */
  hash: string;
  effectiveStartMs: number;
  expirationMs: number;
}

export interface LaneLineage {
  /** The lane's id (its basic-properties hash). */
  laneId: string;
  name: string | null;
  abbreviation: string | null;
  /** Service-unit indices this lane defines, for example `["5","6"]`. */
  serviceUnitIndexes: string[];
  /** The agreement the lane's proof_of_service points at, if any. */
  proofOfService: string | null;
  /** Every version of the definition, newest first, ending at the lane's first. */
  versions: LaneVersion[];
  /** The version in force now, as the DNA answers it; null when none is. */
  inForceHash: string | null;
  /** Why the lineage stops short of the lane's first version; null if read whole. */
  readError: string | null;
}

export interface ResolvedLane {
  laneId: string;
  name: string;
  /** The id from LANE_DEFINITION_IDS that named this lane. */
  pinnedHash: string;
  /** The version a spend made now must cite. */
  inForceHash: string;
}

interface RawLane {
  basic_properties?: { id?: string; name?: string; abbreviation?: string };
  definition?: {
    definition_hash?: string;
    service_units?: Record<string, unknown>;
    rave_agreements?: { proof_of_service?: string };
  };
}

interface RawActionData {
  type: string;
  original_action_address?: Uint8Array;
}

interface RawRecord {
  signed_action: {
    hashed: {
      // Holochain 0.7 nests the variant under `data`; 0.6 sends it flat.
      content: RawActionData & { data?: RawActionData };
    };
  };
  entry: { Present?: { entry_type: string; entry: Uint8Array } } | string;
}

const microsToMs = (micros: number): number => Math.floor(micros / 1000);

/** One version's window, and the hash of the version it replaces. */
async function readVersion(
  call: ZomeCall,
  hash: string,
): Promise<{ version: LaneVersion; previous: string | null }> {
  const record = (await call(
    "hdk_must_get_valid_record",
    decodeHashFromBase64(hash),
  )) as RawRecord;
  const present =
    typeof record.entry === "object" ? record.entry.Present : undefined;
  if (present?.entry_type !== "App") {
    throw new Error(`lane definition ${hash} holds no content to read`);
  }
  const content = decode(present.entry) as {
    effective_start_date: number;
    expiration_date: number;
  };
  const signedContent = record.signed_action.hashed.content;
  const action = signedContent.data ?? signedContent;
  const previous =
    action.type === "Update" && action.original_action_address
      ? encodeHashToBase64(action.original_action_address)
      : null;
  return {
    version: {
      hash,
      effectiveStartMs: microsToMs(content.effective_start_date),
      expirationMs: microsToMs(content.expiration_date),
    },
    previous,
  };
}

/** Every lane with all versions of its definition and the one in force. */
export async function readLaneLineages(call: ZomeCall): Promise<LaneLineage[]> {
  const lanes = (await call("get_all_lane", null)) as RawLane[];
  const out: LaneLineage[] = [];
  for (const lane of lanes) {
    const newest = lane.definition?.definition_hash ?? null;
    // A lane that cannot be read is reported on that lane, so it does not
    // block resolving the others.
    const versions: LaneVersion[] = [];
    let inForceHash: string | null = null;
    let readError: string | null = null;
    try {
      const seen = new Set<string>();
      let next = newest;
      while (next && !seen.has(next)) {
        seen.add(next);
        const { version, previous } = await readVersion(call, next);
        versions.push(version);
        next = previous;
      }
      if (newest) {
        const [inForce] = (await call("get_lane_definitions_in_force", [
          decodeHashFromBase64(newest),
        ])) as Uint8Array[];
        inForceHash = inForce ? encodeHashToBase64(inForce) : null;
      }
    } catch (err) {
      readError = err instanceof Error ? err.message : String(err);
    }
    if (
      !readError &&
      inForceHash &&
      !versions.some((v) => v.hash === inForceHash)
    ) {
      readError = `the version in force, ${inForceHash}, is not in the lineage read from ${newest}`;
    }
    out.push({
      laneId: lane.basic_properties?.id ?? "",
      name: lane.basic_properties?.name ?? null,
      abbreviation: lane.basic_properties?.abbreviation ?? null,
      serviceUnitIndexes: Object.keys(
        lane.definition?.service_units ?? {},
      ).sort((a, b) => Number(a) - Number(b)),
      proofOfService:
        lane.definition?.rave_agreements?.proof_of_service ?? null,
      versions,
      inForceHash,
      readError,
    });
  }
  return out;
}

function laneLabel(lane: LaneLineage): string {
  return lane.name ?? lane.abbreviation ?? lane.laneId;
}

/**
 * Map each configured id to its lane's version in force. An id may be any
 * version of the lane. Throws when an id names no lane, when nothing is in
 * force, or when the version in force has expired with nothing after it.
 */
export function resolveLaneDefinitions(
  configuredIds: string[],
  lanes: LaneLineage[],
  nowMs: number,
): ResolvedLane[] {
  const resolved: ResolvedLane[] = [];
  for (const pinnedHash of configuredIds) {
    const lane = lanes.find((l) =>
      l.versions.some((v) => v.hash === pinnedHash),
    );
    if (!lane) {
      const unread = lanes
        .filter((l) => l.readError)
        .map((l) => `could not read lane ${laneLabel(l)}: ${l.readError}`);
      throw new Error(
        `LANE_DEFINITION_IDS names ${pinnedHash}, which is no version of any lane's definition read` +
          (unread.length
            ? ` (${unread.join("; ")})`
            : "; run `ops lanes` to list them"),
      );
    }
    if (resolved.some((r) => r.laneId === lane.laneId)) {
      continue;
    }
    const name = laneLabel(lane);
    if (lane.readError) {
      throw new Error(`could not read lane ${name}: ${lane.readError}`);
    }
    const inForce = lane.versions.find((v) => v.hash === lane.inForceHash);
    if (!inForce) {
      const starts = lane.versions
        .map((v) => v.effectiveStartMs)
        .filter((start) => start > nowMs);
      const next = starts.length ? Math.min(...starts) : undefined;
      throw new Error(
        `lane ${name}: no definition is in force` +
          (next === undefined
            ? ""
            : `; the next begins at ${new Date(next).toISOString()}`),
      );
    }
    if (inForce.expirationMs <= nowMs) {
      throw new Error(
        `lane ${name}: definition ${inForce.hash} expired at ${new Date(inForce.expirationMs).toISOString()} and nothing replaces it; extend the lane's windows`,
      );
    }
    resolved.push({
      laneId: lane.laneId,
      name,
      pinnedHash,
      inForceHash: inForce.hash,
    });
  }
  return resolved;
}

const short = (hash: string): string => `${hash.slice(0, 10)}…`;

/** One log line per lane, written once per run. */
export function laneResolutionLine(lane: ResolvedLane): string {
  return lane.pinnedHash === lane.inForceHash
    ? `lane ${lane.name}: pinned ${short(lane.pinnedHash)} is in force`
    : `lane ${lane.name}: pinned ${short(lane.pinnedHash)} → in force ${short(lane.inForceHash)}`;
}

/** The lane definition hashes a spend made now must cite. */
export async function resolveLanes(
  call: ZomeCall,
  configuredIds: string[],
  nowMs: number,
  log: (message: string) => void,
): Promise<string[]> {
  if (configuredIds.length === 0) {
    return [];
  }
  const resolved = resolveLaneDefinitions(
    configuredIds,
    await readLaneLineages(call),
    nowMs,
  );
  for (const lane of resolved) {
    log(laneResolutionLine(lane));
  }
  return resolved.map((lane) => lane.inForceHash);
}
