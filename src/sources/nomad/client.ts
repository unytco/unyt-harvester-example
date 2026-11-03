import { Agent, fetch, type Dispatcher } from "undici";
import { Config } from "../../config.js";
import {
  NomadAllocStub,
  NomadEventFrame,
  NomadNode,
  NomadNodeStub,
} from "./types.js";

/**
 * Minimal read-only Nomad HTTP client.
 *
 * Just enough for the spike: list the clients registered to the server and
 * fetch each one's full detail. The event stream is in watch-stream.ts.
 */
export class NomadClient {
  #addr: string;
  #token?: string;
  #region?: string;
  /** Set only when skipping TLS verification (the `curl -k` equivalent). */
  #dispatcher?: Dispatcher;

  constructor(
    config: Pick<
      Config,
      "nomadAddr" | "nomadToken" | "nomadRegion" | "nomadSkipTlsVerify"
    >,
  ) {
    this.#addr = config.nomadAddr;
    this.#token = config.nomadToken;
    this.#region = config.nomadRegion;
    if (config.nomadSkipTlsVerify) {
      this.#dispatcher = new Agent({ connect: { rejectUnauthorized: false } });
    }
  }

  /** Build an absolute URL for a Nomad API path, applying the region. */
  #url(path: string): URL {
    const url = new URL(this.#addr);
    url.pathname = path;
    if (this.#region) {
      url.searchParams.set("region", this.#region);
    }
    return url;
  }

  /** Request headers, including the ACL token when configured. */
  #headers(): Record<string, string> {
    const headers: Record<string, string> = {};
    if (this.#token) {
      headers["X-Nomad-Token"] = this.#token;
    }
    return headers;
  }

  async #get<T>(path: string): Promise<T> {
    const res = await fetch(this.#url(path), {
      headers: this.#headers(),
      dispatcher: this.#dispatcher,
    });
    if (!res.ok) {
      const body = await res.text();
      throw new Error(
        `Nomad ${path} -> ${res.status} ${res.statusText}: ${body}`,
      );
    }
    return (await res.json()) as T;
  }

  /** `GET /v1/nodes` — summary stubs for every client registered to the server. */
  listNodes(): Promise<NomadNodeStub[]> {
    return this.#get<NomadNodeStub[]>("/v1/nodes");
  }

  /** `GET /v1/node/:id` — full detail for one client (Meta, Attributes, ...). */
  getNode(id: string): Promise<NomadNode> {
    return this.#get<NomadNode>(`/v1/node/${id}`);
  }

  /** `GET /v1/node/:id/allocations` — allocations assigned to one client. */
  listNodeAllocations(id: string): Promise<NomadAllocStub[]> {
    return this.#get<NomadAllocStub[]>(`/v1/node/${id}/allocations`);
  }

  /**
   * `GET /v1/event/stream` — long-lived NDJSON stream of cluster events.
   *
   * Yields one frame per non-empty line; keep-alive heartbeats (empty `{}`)
   * are skipped. Frames carry an `Index` for resume-after-disconnect.
   *
   * @param topics       e.g. `["Node", "Allocation"]`. Use `"Topic:key"` to
   *                     filter. Empty/omitted means all topics.
   * @param index        resume from this index (0 = from now).
   * @param signal       abort to close the stream.
   * @param onHeartbeat  called for each keep-alive frame (no events) with its
   *                     index when present — useful for liveness and for
   *                     advancing the resume point while idle.
   */
  async *streamEvents(opts: {
    topics?: string[];
    index?: number;
    signal?: AbortSignal;
    onHeartbeat?: (index: number | undefined) => void;
    onError?: (line: string, err: unknown) => void;
  }): AsyncGenerator<NomadEventFrame> {
    const url = this.#url("/v1/event/stream");
    for (const topic of opts.topics ?? []) {
      url.searchParams.append("topic", topic);
    }
    if (opts.index != null) {
      url.searchParams.set("index", String(opts.index));
    }

    const res = await fetch(url, {
      headers: this.#headers(),
      dispatcher: this.#dispatcher,
      signal: opts.signal,
    });
    if (!res.ok) {
      const body = await res.text();
      throw new Error(
        `Nomad /v1/event/stream -> ${res.status} ${res.statusText}: ${body}`,
      );
    }
    if (!res.body) {
      throw new Error("Nomad /v1/event/stream returned no body");
    }

    yield* parseEventStream(res.body as AsyncIterable<Uint8Array>, {
      onHeartbeat: opts.onHeartbeat,
      onError: opts.onError,
    });
  }
}

/**
 * Parse an NDJSON byte stream into Nomad event frames. Split out from
 * `streamEvents` so the buffering + per-line resilience is unit-testable.
 *
 * Resilience: a **malformed line is skipped** (reported via `onError`) rather
 * than thrown — a single bad frame must not tear down a long-lived stream.
 * Connection-level errors from the underlying chunk iterator are NOT swallowed;
 * they propagate to the caller so the watcher can reconnect (see StreamWatcher).
 */
export async function* parseEventStream(
  chunks: AsyncIterable<Uint8Array>,
  opts: {
    onHeartbeat?: (index: number | undefined) => void;
    onError?: (line: string, err: unknown) => void;
  } = {},
): AsyncGenerator<NomadEventFrame> {
  const decoder = new TextDecoder();
  let buf = "";
  for await (const chunk of chunks) {
    buf += decoder.decode(chunk, { stream: true });
    let nl: number;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) {
        continue; // keep-alive newline
      }
      let frame: NomadEventFrame;
      try {
        frame = JSON.parse(line) as NomadEventFrame;
      } catch (err) {
        opts.onError?.(line, err);
        continue; // skip the malformed frame; keep the stream alive
      }
      if (Array.isArray(frame.Events) && frame.Events.length > 0) {
        yield frame;
      } else {
        // keep-alive frame (e.g. `{}`): surface it for liveness/resume
        opts.onHeartbeat?.(
          typeof frame.Index === "number" ? frame.Index : undefined,
        );
      }
    }
  }
}
