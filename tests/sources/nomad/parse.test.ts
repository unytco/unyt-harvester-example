import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseAllocation,
  parseAllocationEvent,
  parseNodeStatusEvent,
  nodeStatusSnapshot,
  allocNodeIdFromEvent,
  unytAgentIdFromNode,
  unytAgentIdFromNodeEvent,
} from "../../../src/sources/nomad/parse.js";
import {
  NomadAllocStub,
  NomadEvent,
  NomadNodeStub,
} from "../../../src/sources/nomad/types.js";

function nodeEvent(over: Record<string, unknown> = {}): NomadEvent {
  return {
    Topic: "Node",
    Type: "NodeRegistration",
    Key: "node-1",
    Index: 500,
    Payload: {
      Node: {
        ID: "node-1",
        Name: "nomad-client-zippy-hp-1",
        Status: "ready",
        SchedulingEligibility: "eligible",
        ModifyIndex: 480,
        ...over,
      },
    },
  };
}

function allocEvent(nodeId: unknown): NomadEvent {
  return {
    Topic: "Allocation",
    Type: "AllocationUpdated",
    Key: "alloc-1",
    Index: 600,
    Payload: { Allocation: { ID: "alloc-1", NodeID: nodeId } },
  };
}

const RAW: NomadAllocStub = {
  ID: "alloc-1",
  NodeID: "node-1",
  NodeName: "nomad-client-zippy-hp-1",
  JobID: "mixed_arc_get_agent_activity_demo",
  TaskGroup: "run_scenario",
  ClientStatus: "running",
  DesiredStatus: "run",
  CreateTime: 1781706244869747700,
  ModifyTime: 1781706245000000000,
  CreateIndex: 333000,
  ModifyIndex: 333916,
};

test("parseAllocation maps the fields we store", () => {
  const a = parseAllocation(RAW, 1_700_000_000_000);
  assert.equal(a.allocId, "alloc-1");
  assert.equal(a.nodeId, "node-1");
  assert.equal(a.nodeName, "nomad-client-zippy-hp-1");
  assert.equal(a.jobId, "mixed_arc_get_agent_activity_demo");
  assert.equal(a.clientStatus, "running");
  assert.equal(a.desiredStatus, "run");
  assert.equal(a.modifyIndex, 333916);
  assert.equal(a.observedAt, 1_700_000_000_000);
});

test("parseAllocation converts Nomad ns timestamps to safe-integer ms", () => {
  // Regression: live Nomad reports nanosecond epochs (~1.78e18) that overflow
  // JS safe-integer range and crash SQLite read-back. They must become ms.
  const a = parseAllocation(RAW, 0);
  assert.equal(a.createTime, 1781706244870); // 1781706244869747700 ns -> ms (rounded)
  assert.equal(a.modifyTime, 1781706245000);
  assert.ok(Number.isSafeInteger(a.createTime));
  assert.ok(Number.isSafeInteger(a.modifyTime));
});

test("parseAllocation keeps the full raw payload for recompute", () => {
  const a = parseAllocation(RAW, 0);
  assert.deepEqual(JSON.parse(a.raw), RAW);
});

test("parseAllocation is total: missing fields become safe defaults", () => {
  const a = parseAllocation({ ID: "x" } as unknown as NomadAllocStub, 5);
  assert.equal(a.allocId, "x");
  assert.equal(a.nodeId, "");
  assert.equal(a.nodeName, null);
  assert.equal(a.modifyIndex, 0);
  assert.equal(a.observedAt, 5);
});

test("parseNodeStatusEvent maps a Node event into a status transition", () => {
  const s = parseNodeStatusEvent(nodeEvent(), 1234);
  assert.equal(s?.nodeId, "node-1");
  assert.equal(s?.nodeName, "nomad-client-zippy-hp-1");
  assert.equal(s?.status, "ready");
  assert.equal(s?.eligibility, "eligible");
  assert.equal(s?.eventType, "NodeRegistration");
  assert.equal(s?.modifyIndex, 480);
  assert.equal(s?.observedAt, 1234);
});

test("parseNodeStatusEvent captures a down transition", () => {
  const s = parseNodeStatusEvent(
    nodeEvent({ Status: "down", ModifyIndex: 999 }),
    0,
  );
  assert.equal(s?.status, "down");
  assert.equal(s?.modifyIndex, 999);
});

test("parseNodeStatusEvent returns null without a usable Node payload", () => {
  assert.equal(
    parseNodeStatusEvent(
      { Topic: "Node", Type: "X", Key: "", Index: 1, Payload: {} },
      0,
    ),
    null,
  );
  // Node present but no ID -> not usable.
  const noId = nodeEvent();
  delete (noId.Payload.Node as Record<string, unknown>).ID;
  assert.equal(parseNodeStatusEvent(noId, 0), null);
});

test("allocNodeIdFromEvent extracts NodeID, undefined when absent", () => {
  assert.equal(allocNodeIdFromEvent(allocEvent("node-7")), "node-7");
  assert.equal(allocNodeIdFromEvent(allocEvent(undefined)), undefined);
  assert.equal(
    allocNodeIdFromEvent({
      Topic: "Allocation",
      Type: "X",
      Key: "",
      Index: 1,
      Payload: {},
    }),
    undefined,
  );
});

test("parseAllocationEvent normalizes the allocation in an event payload", () => {
  const ev: NomadEvent = {
    Topic: "Allocation",
    Type: "AllocationUpdated",
    Key: "alloc-1",
    Index: 600,
    Payload: { Allocation: RAW as unknown as Record<string, unknown> },
  };
  const a = parseAllocationEvent(ev, 1234);
  assert.equal(a?.allocId, "alloc-1");
  assert.equal(a?.nodeId, "node-1");
  assert.equal(a?.clientStatus, "running");
  assert.equal(a?.modifyTime, 1781706245000); // ns -> ms
  assert.equal(a?.observedAt, 1234);
});

test("parseAllocationEvent returns null without a usable allocation", () => {
  // No Allocation payload.
  assert.equal(
    parseAllocationEvent(
      { Topic: "Allocation", Type: "X", Key: "", Index: 1, Payload: {} },
      0,
    ),
    null,
  );
  // Allocation present but missing the keys we store on (ID / NodeID).
  assert.equal(parseAllocationEvent(allocEvent(undefined), 0), null);
});

test("nodeStatusSnapshot builds a Reconcile snapshot from a node stub", () => {
  const stub: NomadNodeStub = {
    ID: "node-9",
    Name: "nomad-client-zippy-hp-9",
    Status: "ready",
    SchedulingEligibility: "eligible",
    ModifyIndex: 4321,
  };
  const s = nodeStatusSnapshot(stub, 777);
  assert.equal(s?.nodeId, "node-9");
  assert.equal(s?.status, "ready");
  assert.equal(s?.eligibility, "eligible");
  assert.equal(s?.eventType, "Reconcile");
  assert.equal(s?.modifyIndex, 4321);
  assert.equal(s?.observedAt, 777);
});

test("nodeStatusSnapshot returns null for a stub without an ID", () => {
  assert.equal(
    nodeStatusSnapshot({ ID: "" } as unknown as NomadNodeStub, 0),
    null,
  );
});

test("unytAgentIdFromNode reads and trims Meta.unyt_agent_id, else null", () => {
  assert.equal(
    unytAgentIdFromNode({ Meta: { unyt_agent_id: "  uhCAk-x  " } }),
    "uhCAk-x",
  );
  assert.equal(unytAgentIdFromNode({ Meta: { other: "y" } }), null);
  assert.equal(unytAgentIdFromNode({ Meta: { unyt_agent_id: "  " } }), null);
  assert.equal(unytAgentIdFromNode({}), null);
  assert.equal(unytAgentIdFromNode(undefined), null);
});

test("unytAgentIdFromNodeEvent reads the agent id from a Node event payload", () => {
  const ev: NomadEvent = {
    Topic: "Node",
    Type: "NodeStreamEvent",
    Key: "n1",
    Index: 1,
    Payload: { Node: { ID: "n1", Meta: { unyt_agent_id: "uhCAk-z" } } },
  };
  assert.equal(unytAgentIdFromNodeEvent(ev), "uhCAk-z");
  assert.equal(
    unytAgentIdFromNodeEvent({ ...ev, Payload: {} } as NomadEvent),
    null,
  );
});
