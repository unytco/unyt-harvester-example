import { LaneLineage, LaneVersion } from "../holochain/lanes.js";

/**
 * Text for `ops lanes`: each lane's newest definition and the one in force,
 * with their windows, marking the version `LANE_DEFINITION_IDS` names and the
 * lane whose proof_of_service is `AGREEMENT_ID`.
 */

export interface LaneReportOptions {
  agreementId: string;
  configuredLaneIds: string[];
  nowMs: number;
}

const iso = (ms: number): string => new Date(ms).toISOString();

const CONFIGURED = "   ← LANE_DEFINITION_IDS";

function windowOf(version: LaneVersion): string {
  return `${iso(version.effectiveStartMs)} to ${iso(version.expirationMs)}`;
}

function versionLine(
  label: string,
  version: LaneVersion,
  configured: string[],
): string {
  const mark = configured.includes(version.hash) ? CONFIGURED : "";
  return `  ${label.padEnd(22)} ${version.hash}  ${windowOf(version)}${mark}`;
}

function nothingInForce(lane: LaneLineage, nowMs: number): string {
  const starts = lane.versions
    .map((v) => v.effectiveStartMs)
    .filter((start) => start > nowMs);
  return starts.length
    ? `none; the next begins at ${iso(Math.min(...starts))}`
    : "none";
}

export function laneReportLines(
  lanes: LaneLineage[],
  opts: LaneReportOptions,
): string[] {
  if (lanes.length === 0) {
    return ["(no lanes)"];
  }
  const lines: string[] = [];
  for (const lane of lanes) {
    const newest = lane.versions[0];
    const inForce = lane.versions.find((v) => v.hash === lane.inForceHash);
    lines.push(
      `${(lane.name ?? "(unnamed)").padEnd(18)} units=[${lane.serviceUnitIndexes.join(",")}]`,
    );
    if (lane.readError) {
      lines.push(`  ${"read error:".padEnd(22)} ${lane.readError}`);
    }
    lines.push(
      newest
        ? versionLine("definition (newest):", newest, opts.configuredLaneIds)
        : `  ${"definition (newest):".padEnd(22)} —`,
    );
    lines.push(
      inForce
        ? versionLine("definition (in force):", inForce, opts.configuredLaneIds)
        : `  ${"definition (in force):".padEnd(22)} ${nothingInForce(lane, opts.nowMs)}`,
    );
    for (const version of lane.versions.slice(1)) {
      if (
        version.hash !== inForce?.hash &&
        opts.configuredLaneIds.includes(version.hash)
      ) {
        lines.push(
          versionLine("definition (older):", version, opts.configuredLaneIds),
        );
      }
    }
    const isAgreement =
      lane.proofOfService !== null && lane.proofOfService === opts.agreementId;
    lines.push(
      `  ${"proof_of_service:".padEnd(22)} ${lane.proofOfService ?? "—"}` +
        (isAgreement ? "   ← AGREEMENT_ID" : ""),
    );
  }
  lines.push(`(${lanes.length} lane${lanes.length === 1 ? "" : "s"})`);
  return lines;
}
