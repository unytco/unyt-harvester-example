import { test } from "node:test";
import assert from "node:assert/strict";
import {
  resolveUnytPubKey,
  attributeOrSkip,
  isValidAgentKey,
} from "../../src/pipeline/null-guard.js";

// A real Holochain AgentPubKey (multibase-base64url, `uhCAk…`, 53 chars).
const AGENT = "uhCAkEgwsRQmYpVUGWSdNyziQgQZu1sfXVlVIR0sbEZJBd5N6wYr_";

test("isValidAgentKey accepts a well-formed agent key and rejects the rest", () => {
  assert.equal(isValidAgentKey(AGENT), true);
  assert.equal(isValidAgentKey("test-value"), false); // placeholder
  assert.equal(isValidAgentKey(""), false);
  assert.equal(isValidAgentKey(AGENT.slice(0, -1)), false); // truncated
  assert.equal(isValidAgentKey("uhCAk" + "!".repeat(48)), false); // bad charset
  assert.equal(isValidAgentKey("uhCEk" + AGENT.slice(5)), false); // wrong prefix
});

test("resolveUnytPubKey uses a valid agent key", () => {
  assert.deepEqual(resolveUnytPubKey({ sourceId: "n1", unytAgentId: AGENT }), {
    key: AGENT,
  });
});

test("resolveUnytPubKey reports missing vs malformed, never falls back to sourceId", () => {
  assert.deepEqual(resolveUnytPubKey({ sourceId: "n1" }), {
    key: null,
    reason: "missing",
  });
  assert.deepEqual(resolveUnytPubKey({ sourceId: "n1", unytAgentId: "  " }), {
    key: null,
    reason: "missing",
  });
  assert.deepEqual(
    resolveUnytPubKey({ sourceId: "n1", unytAgentId: "test-value" }),
    { key: null, reason: "malformed" },
  );
});

test("attributeOrSkip keeps valid-key nodes and skips/logs the rest", () => {
  const logs: string[] = [];
  const { kept, skipped } = attributeOrSkip(
    [
      { sourceId: "n1", unytAgentId: AGENT }, // valid -> kept
      { sourceId: "n2" }, // missing -> skipped
      { sourceId: "n3", unytAgentId: "test-value" }, // malformed -> skipped
    ],
    (m) => logs.push(m),
  );
  assert.deepEqual(
    kept.map((k) => [k.sourceId, k.unytPubKey]),
    [["n1", AGENT]],
  );
  assert.deepEqual(
    skipped.map((s) => s.sourceId),
    ["n2", "n3"],
  );
  assert.equal(logs.length, 2); // both skips logged, no throw
  assert.match(logs[1], /malformed/); // the bad key's reason is called out
});

test("resolveUnytPubKey skips a valid key that is not on this network", () => {
  assert.deepEqual(
    resolveUnytPubKey({ sourceId: "n1", unytAgentId: AGENT, onNetwork: false }),
    { key: null, reason: "foreign" },
  );
  // Confirmed on the network, or never checked: attributed as before.
  assert.deepEqual(
    resolveUnytPubKey({ sourceId: "n1", unytAgentId: AGENT, onNetwork: true }),
    { key: AGENT },
  );
  assert.deepEqual(resolveUnytPubKey({ sourceId: "n1", unytAgentId: AGENT }), {
    key: AGENT,
  });
  // A malformed key is malformed first, whatever the network said.
  assert.deepEqual(
    resolveUnytPubKey({
      sourceId: "n1",
      unytAgentId: "test-value",
      onNetwork: false,
    }),
    { key: null, reason: "malformed" },
  );
});

test("attributeOrSkip logs a foreign key as not on this network", () => {
  const logs: string[] = [];
  const { kept, skipped } = attributeOrSkip(
    [{ sourceId: "n1", unytAgentId: AGENT, onNetwork: false }],
    (m) => logs.push(m),
  );
  assert.equal(kept.length, 0);
  assert.equal(skipped.length, 1);
  assert.match(logs[0], /not on this network/);
});
