/**
 * Loose Nomad shapes for the spike. The index signatures keep the raw fields
 * available so the dump shows everything — we tighten these once we've seen
 * real responses (notably: where the Unyt Agent ID actually lives).
 */

/** An entry from `GET /v1/nodes` (a summary stub, not full detail). The list
 * endpoint includes enough for a status snapshot (Status, eligibility, index). */
export interface NomadNodeStub {
  ID: string;
  Name: string;
  Status: string;
  SchedulingEligibility?: string;
  ModifyIndex?: number;
  [field: string]: unknown;
}

/** Full node from `GET /v1/node/:id`. Meta/Attributes are the likely homes
 * for a Unyt Agent ID. */
export interface NomadNode extends NomadNodeStub {
  Meta?: Record<string, string> | null;
  Attributes?: Record<string, string> | null;
}

/** An allocation stub from `GET /v1/node/:id/allocations`. These tie a job/task
 * run to a node and carry the status transitions we need for active usage. */
export interface NomadAllocStub {
  ID: string;
  JobID: string;
  TaskGroup: string;
  ClientStatus: string;
  DesiredStatus: string;
  /** The node this allocation is assigned to (the carrier we key storage on). */
  NodeID: string;
  NodeName?: string;
  /** Nanosecond epoch timestamps from Nomad. */
  CreateTime: number;
  ModifyTime: number;
  /** Raft indexes; ModifyIndex is the monotonic cursor for change detection. */
  CreateIndex: number;
  ModifyIndex: number;
  [field: string]: unknown;
}

/** A single event from the `GET /v1/event/stream` NDJSON stream. */
export interface NomadEvent {
  Topic: string;
  Type: string;
  Key: string;
  Namespace?: string;
  Index: number;
  /** Topic-specific body, e.g. `{ Node: {...} }` or `{ Allocation: {...} }`. */
  Payload: Record<string, unknown>;
  [field: string]: unknown;
}

/** One newline-delimited frame from the event stream (a batch at an index). */
export interface NomadEventFrame {
  Index: number;
  Events: NomadEvent[];
}
