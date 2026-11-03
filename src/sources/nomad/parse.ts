import { NomadAllocStub, NomadEvent, NomadNodeStub } from "./types.js";
import { NodeStatus, NodeStatusEvent, StoredAllocation } from "./store.js";

/**
 * Normalize a raw Nomad allocation (`GET /v1/node/:id/allocations`) into the
 * `StoredAllocation` shape we persist.
 *
 * Pure and total: it never throws on a missing field — Nomad payloads vary by
 * version, and a partially-shaped allocation should still be stored (with the
 * full `raw` kept for later recompute) rather than aborting an entire pull.
 *
 * @param raw         one allocation object from the Nomad API.
 * @param observedAt  ms epoch when this pull happened (caller-supplied so the
 *                    function stays pure/testable).
 */
export function parseAllocation(
  raw: NomadAllocStub,
  observedAt: number,
): StoredAllocation {
  return {
    allocId: str(raw.ID),
    nodeId: str(raw.NodeID),
    nodeName: raw.NodeName != null ? str(raw.NodeName) : null,
    jobId: str(raw.JobID),
    taskGroup: str(raw.TaskGroup),
    clientStatus: str(raw.ClientStatus),
    desiredStatus: str(raw.DesiredStatus),
    createTime: nsToMs(raw.CreateTime),
    modifyTime: nsToMs(raw.ModifyTime),
    modifyIndex: num(raw.ModifyIndex),
    observedAt,
    raw: JSON.stringify(raw),
  };
}

/**
 * Extract a node status transition from a Nomad `Node`-topic stream event.
 * Returns `null` for events without a usable `Payload.Node` (so the caller can
 * filter), never throws. `observedAt` is caller-supplied to stay pure.
 */
export function parseNodeStatusEvent(
  ev: NomadEvent,
  observedAt: number,
): NodeStatusEvent | null {
  const node = ev.Payload?.Node as Record<string, unknown> | undefined;
  if (!node || typeof node !== "object") {
    return null;
  }
  return nodeStatusFrom(node, str(ev.Type), observedAt, JSON.stringify(ev));
}

/**
 * A node status *snapshot* built from a `GET /v1/nodes` stub, used by the
 * watcher's reconcile pass after a reconnect (when stream events may have been
 * missed). Marked with the synthetic event type "Reconcile" so the aggregation
 * layer can tell a polled snapshot from an observed transition. Keyed by the
 * node's current ModifyIndex, so it dedupes against a stream event for the same
 * change.
 */
export function nodeStatusSnapshot(
  stub: NomadNodeStub,
  observedAt: number,
): NodeStatusEvent | null {
  return nodeStatusFrom(
    stub as unknown as Record<string, unknown>,
    "Reconcile",
    observedAt,
    JSON.stringify(stub),
  );
}

/** Shared core: a Nomad node object -> NodeStatusEvent (null if no ID). */
function nodeStatusFrom(
  node: Record<string, unknown>,
  eventType: string,
  observedAt: number,
  raw: string,
): NodeStatusEvent | null {
  const nodeId = str(node.ID);
  if (!nodeId) {
    return null;
  }
  return {
    nodeId,
    nodeName: node.Name != null ? str(node.Name) : null,
    // Cast at the wire boundary: Nomad sends an untyped string, but the
    // values we act on are the documented NodeStatus set.
    status: str(node.Status) as NodeStatus,
    eligibility:
      node.SchedulingEligibility != null
        ? str(node.SchedulingEligibility)
        : null,
    eventType,
    modifyIndex: num(node.ModifyIndex),
    observedAt,
    raw,
  };
}

/**
 * The Unyt Agent ID a node advertises via `Meta.unyt_agent_id`, trimmed, or
 * `null` if absent/blank. The value is returned verbatim (not validated) — the
 * attribution choke point (`resolveUnytPubKey`) decides whether it's usable.
 * Full node detail (`GET /v1/node/:id`) and stream Node events both carry
 * `Meta`; the `GET /v1/nodes` list stub does not.
 */
export function unytAgentIdFromNode(
  node: Record<string, unknown> | null | undefined,
): string | null {
  const meta = node?.Meta as Record<string, unknown> | undefined;
  const v = meta?.unyt_agent_id;
  return typeof v === "string" && v.trim() ? v.trim() : null;
}

/**
 * The Unyt Agent ID carried by a Nomad `Node`-topic stream event's payload, or
 * `null` if the event has no node object or no `Meta.unyt_agent_id`.
 */
export function unytAgentIdFromNodeEvent(ev: NomadEvent): string | null {
  const node = ev.Payload?.Node as Record<string, unknown> | undefined;
  return unytAgentIdFromNode(node);
}

/**
 * The node id referenced by an `Allocation`-topic stream event, or `undefined`
 * if absent. Used to mark a node for an allocation re-pull.
 */
export function allocNodeIdFromEvent(ev: NomadEvent): string | undefined {
  const alloc = ev.Payload?.Allocation as Record<string, unknown> | undefined;
  const id =
    alloc && typeof alloc === "object" ? (alloc.NodeID as unknown) : undefined;
  return typeof id === "string" && id ? id : undefined;
}

/**
 * Normalize the allocation carried by an `Allocation`-topic stream event into a
 * `StoredAllocation`, or `null` if the payload lacks a usable allocation
 * (no `ID`/`NodeID`). The event payload carries the allocation's current
 * `ModifyTime`/`ClientStatus`, so persisting it captures terminal state (e.g. a
 * completed alloc) before Nomad GCs it from the point-in-time pull.
 */
export function parseAllocationEvent(
  ev: NomadEvent,
  observedAt: number,
): StoredAllocation | null {
  const alloc = ev.Payload?.Allocation as NomadAllocStub | undefined;
  if (
    !alloc ||
    typeof alloc !== "object" ||
    !str(alloc.ID) ||
    !str(alloc.NodeID)
  ) {
    return null;
  }
  return parseAllocation(alloc, observedAt);
}

function str(v: unknown): string {
  return typeof v === "string" ? v : v == null ? "" : String(v);
}

function num(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

/**
 * Nomad reports timestamps as nanosecond epochs (Go's UnixNano, ~1.78e18),
 * which exceed JS's safe-integer range (9.0e15) — storing then reading them back
 * via SQLite throws `ERR_OUT_OF_RANGE`. Convert to a millisecond epoch, which is
 * comfortably safe-integer-sized and the unit the rest of the pipeline (and the
 * day windows) already use. Sub-millisecond precision isn't needed
 * for availability/usage aggregation.
 */
function nsToMs(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? Math.round(v / 1e6) : 0;
}
