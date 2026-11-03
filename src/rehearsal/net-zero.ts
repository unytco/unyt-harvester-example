import { encodeHashToBase64 } from "@holochain/client";

/**
 * Stands in for the HoloFuel network operator (Net Zero). On MainNet you ask
 * Net Zero to do these two steps; see README. Here the rehearsal's own
 * progenitor does them, so the rest of the flow runs exactly as it would live.
 */

export type ZomeCall = (fn: string, payload: unknown) => Promise<any>;

/** The lane a program asks Net Zero for: its name and its own units. */
export interface LaneConfig {
  basic_properties: {
    name: string;
    abbreviation: string;
    description: string;
    url: string;
    theme: string;
  };
  unit_definitions: Array<{
    unit_type: unknown;
    unit_symbol: string;
    unit_name: string;
    unit_description: string;
    unit_color: string;
  }>;
}

interface LaneExt {
  basic_properties: { id: string; name?: string };
  definition: Record<string, any> & {
    origin_id: string;
    effective_start_date: number;
    expiration_date: number;
    rave_agreements: Record<string, unknown> & { proof_of_service: string };
  };
}

/** The definition fields a create or update takes (the ext adds two ids). */
function definitionFields(d: LaneExt["definition"]) {
  const { origin_id, definition_hash, ...fields } = d;
  void origin_id;
  void definition_hash;
  return fields;
}

/**
 * Create the program's lane with its units, naming `laneEditor` (the program's
 * agent) as the lane's editor. The lane's special agents and agreements are
 * copied from an existing lane that bridges nothing; `proof_of_service` stays
 * that lane's until `wireProofOfService` points it at the program's agreement.
 *
 * The first window is short, because the wired version is placed after it
 * (lane windows tile) and the rehearsal waits for it to come into force.
 */
export async function createProgramLane(
  call: ZomeCall,
  config: LaneConfig,
  laneEditor: string,
  opts: { now?: () => number; firstWindowMs: number },
): Promise<{ laneId: string; definitionId: string }> {
  const now = (opts.now ?? Date.now)();
  const lanes = (await call("get_all_lane", null)) as LaneExt[];
  const template =
    lanes.find((l) => !l.definition.rave_agreements.bridging_agreement) ??
    lanes[0];
  if (!template) throw new Error("the network has no lane to copy from");
  const definitionId = String(
    await call("initialize_lane", {
      basic_properties: {
        ...config.basic_properties,
        lane_editors: [laneEditor],
      },
      definition: {
        ...definitionFields(template.definition),
        effective_start_date: now * 1000,
        expiration_date: (now + opts.firstWindowMs) * 1000,
        // initialize_lane registers the units and fills this in.
        service_units: {},
      },
      unit_definitions: config.unit_definitions,
    }),
  );
  // initialize_lane answers with the first definition's hash; the lane's id
  // is its basic-properties hash.
  const created = ((await call("get_all_lane", null)) as LaneExt[]).find(
    (l) => l.definition.definition_hash === definitionId,
  );
  if (!created) throw new Error(`new lane ${definitionId} not readable yet`);
  return { laneId: created.basic_properties.id, definitionId };
}

/**
 * Point the lane's `proof_of_service` at the program's agreement. The new
 * version starts where the current one ends and runs for `durationMs`.
 * Returns the new definition's hash.
 */
export async function wireProofOfService(
  call: ZomeCall,
  laneId: string,
  agreementId: string,
  opts: { durationMs: number },
): Promise<string> {
  const lanes = (await call("get_all_lane", null)) as LaneExt[];
  const lane = lanes.find((l) => l.basic_properties.id === laneId);
  if (!lane) throw new Error(`lane ${laneId} not found`);
  const d = lane.definition;
  const hash = await call("update_lane_definition", {
    ...definitionFields(d),
    origin_id: d.origin_id,
    rave_agreements: { ...d.rave_agreements, proof_of_service: agreementId },
    // The DNA moves the window to start where the current one ends; only its
    // length is taken from here.
    effective_start_date: d.effective_start_date,
    expiration_date: d.effective_start_date + opts.durationMs * 1000,
  });
  return hash instanceof Uint8Array ? encodeHashToBase64(hash) : String(hash);
}
