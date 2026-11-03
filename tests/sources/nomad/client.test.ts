import { test } from "node:test";
import assert from "node:assert/strict";
import { parseEventStream } from "../../../src/sources/nomad/client.js";
import { NomadEventFrame } from "../../../src/sources/nomad/types.js";

/** An async iterable of UTF-8 chunks, to drive parseEventStream. */
async function* bytes(...parts: string[]): AsyncIterable<Uint8Array> {
  const enc = new TextEncoder();
  for (const p of parts) {
    yield enc.encode(p);
  }
}

async function collect(
  gen: AsyncGenerator<NomadEventFrame>,
): Promise<NomadEventFrame[]> {
  const out: NomadEventFrame[] = [];
  for await (const f of gen) {
    out.push(f);
  }
  return out;
}

test("yields event frames and surfaces heartbeats", async () => {
  const heartbeats: (number | undefined)[] = [];
  const frames = await collect(
    parseEventStream(
      bytes(
        '{"Index":1,"Events":[{"Topic":"Node"}]}\n',
        '{"Index":2}\n', // no Events -> heartbeat
      ),
      { onHeartbeat: (i) => heartbeats.push(i) },
    ),
  );
  assert.equal(frames.length, 1);
  assert.equal(frames[0].Index, 1);
  assert.deepEqual(heartbeats, [2]);
});

test("skips a malformed line and keeps the stream alive (onError)", async () => {
  const errs: string[] = [];
  const frames = await collect(
    parseEventStream(
      bytes("not json at all\n", '{"Index":5,"Events":[{"Topic":"Node"}]}\n'),
      { onError: (line) => errs.push(line) },
    ),
  );
  assert.equal(frames.length, 1); // valid frame after the bad one still arrives
  assert.equal(frames[0].Index, 5);
  assert.deepEqual(errs, ["not json at all"]);
});

test("reassembles a frame split across chunks", async () => {
  const frames = await collect(
    parseEventStream(bytes('{"Index":7,"Eve', 'nts":[{"Topic":"Node"}]}\n')),
  );
  assert.equal(frames.length, 1);
  assert.equal(frames[0].Index, 7);
});

test("ignores blank keep-alive newlines without an onHeartbeat", async () => {
  const frames = await collect(parseEventStream(bytes("\n\n")));
  assert.equal(frames.length, 0);
});
