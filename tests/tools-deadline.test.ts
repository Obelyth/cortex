import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import zlib from "node:zlib";
import { createHash } from "node:crypto";
import type { McpServer } from "@modelcontextprotocol/server";
import type { MirrorStore } from "../lib/mirror";
import { tarOf } from "./helpers/tar";

/**
 * Issue #180, end to end through the registered brain_ask handler: a slow mirror AND a slow
 * reader inside one call, driven by fake timers. Before, that call ran GitHub 15 s + mirror 20 s
 * + reader 45 s past the 60 s wall and the platform killed it — the caller got nothing and the
 * call log, written only after the tool resolved, had no row. Now the stages spend from one
 * deadline: the reply lands inside REQUEST_WALL_MS, stamped UNVERIFIED with how far it got, it is
 * never cached, and the log holds a started row from BEFORE the body ran and a final row after.
 *
 * Only setTimeout/clearTimeout/Date are faked, so the real gunzip on the tarball path still runs
 * on the thread pool — `flush()` yields to it through real setImmediate.
 */

const URL_KEY = "KV_REST_API_URL";
const TOK_KEY = "KV_REST_API_TOKEN";
const SHA = "eaf0a03e4849aaaa";
const NOTES = {
  "projects/beacon.md": "**Production is still dark** (re-checked 2026-07-25). Both URLs still return 404.",
  "projects/harbor.md": "The plates backlog went into a deleted database.",
};

type Row = Record<string, unknown>;

/** A stateful fake Upstash client that also records every call-log write, in order. */
function fakeStore(events: string[]) {
  const data = new Map<string, string>();
  const rows: Row[] = [];
  const state = { data, rows, sets: 0 };
  vi.doMock("@upstash/redis", () => ({
    Redis: class {
      get(k: string) {
        return Promise.resolve(data.get(k) ?? null);
      }
      set(k: string, v: string) {
        state.sets++;
        data.set(k, v);
        return Promise.resolve("OK");
      }
      incr() {
        return Promise.resolve(1);
      }
      expire() {
        return Promise.resolve(1);
      }
      lrange() {
        return Promise.resolve(rows.map((r) => JSON.stringify(r)).reverse());
      }
      pipeline() {
        return {
          lpush(_k: string, v: string) {
            const row = JSON.parse(v) as Row;
            rows.push(row);
            events.push(`log:${String(row.stamp)}`);
          },
          ltrim() {},
          setnx() {},
          exec: () => Promise.resolve([]),
        };
      }
    },
  }));
  vi.stubEnv(URL_KEY, "https://example.upstash.io");
  vi.stubEnv(TOK_KEY, "test-token");
  return state;
}

/**
 * The Anthropic SDK, one level down: a reader that answers instantly with a verifiable reply,
 * or — when `stall` is set — only ever ends by the caller's signal aborting it.
 */
function mockAnthropic(events: string[], stall: boolean) {
  const seen: { signal?: AbortSignal; timeout?: number } = {};
  vi.doMock("@anthropic-ai/sdk", () => ({
    default: class {
      constructor(opts: { timeout?: number }) {
        seen.timeout = opts.timeout;
      }
      messages = {
        create: (
          params: { messages: Array<{ content: Array<{ text: string }> }> },
          opts: { signal: AbortSignal }
        ) => {
          events.push("reader:start");
          seen.signal = opts.signal;
          if (stall) {
            return new Promise((_, reject) => {
              opts.signal.addEventListener("abort", () => reject(opts.signal.reason));
            });
          }
          const stable = params.messages[0].content[0].text;
          const tag = stable.match(/FILE: projects\/beacon\.md \[tag: ([0-9a-z]+)\]/)?.[1] ?? "";
          return Promise.resolve({
            stop_reason: "end_turn",
            content: [{ type: "text", text: JSON.stringify({ answer: "No — production is dark.", tag, quote: "Production is still dark" }) }],
          });
        },
      };
    },
  }));
  return seen;
}

/** GitHub: the head resolves at once; the tarball is a real gzipped ustar of NOTES. */
function stubGitHub(events: string[]) {
  const tarball = zlib.gzipSync(tarOf(Object.fromEntries(Object.entries(NOTES).map(([p, t]) => [`brain-${SHA}/${p}`, t]))));
  vi.stubGlobal(
    "fetch",
    (async (url: string | URL) => {
      const u = String(url);
      if (u.includes("/commits/")) return new Response(JSON.stringify({ sha: SHA }), { status: 200 });
      if (u.includes("/tarball/")) {
        events.push("tarball");
        return new Response(new Uint8Array(tarball), { status: 200 });
      }
      throw new Error(`unexpected fetch: ${u}`);
    }) as typeof fetch
  );
}

/** A mirror whose snapshot never returns — slow-but-alive, the case the race exists for. The
 *  note-access log and the router's scores ride the same store and must not be what fails. */
function stalledMirror(events: string[]): MirrorStore {
  return {
    snapshot: () => {
      events.push("mirror:snapshot");
      return new Promise(() => {});
    },
    access: async () => {},
    scores: async () => null,
  } as unknown as MirrorStore;
}

async function captureAsk() {
  const { registerTools } = await import("../lib/tools");
  const tools = new Map<string, (args: Record<string, unknown>) => Promise<{ content: Array<{ text: string }>; isError?: boolean }>>();
  registerTools(
    { registerTool: (name: string, _c: unknown, h: never) => { tools.set(name, h); } } as unknown as McpServer,
    { guest: false }
  );
  return tools.get("brain_ask")!;
}

/** Let the thread pool (gunzip) and any real I/O callbacks run under faked timers. */
async function flush(rounds = 30): Promise<void> {
  for (let i = 0; i < rounds; i++) await new Promise((r) => setImmediate(r));
}

/**
 * Yield to real I/O until `done` holds. A counted flush was enough on a developer box and not on
 * the CI runner: a gunzip completion is delivered whenever libuv turns, not after a fixed number
 * of turns, so the only honest wait is for the event itself. Bounded so a genuine hang still
 * fails the test, with the events seen so far in the message.
 */
async function until(done: () => boolean, label: string, events: string[], rounds = 200_000): Promise<void> {
  for (let i = 0; i < rounds; i++) {
    if (done()) return;
    await new Promise((r) => setImmediate(r));
  }
  throw new Error(`gave up waiting for ${label}; events so far: ${events.join(", ")}`);
}

beforeEach(() => {
  vi.stubEnv("BRAIN_REPO", "example-owner/brain");
  vi.stubEnv("GITHUB_TOKEN", "test");
  vi.stubEnv("ANTHROPIC_API_KEY", "test-key");
  // The started row's question digest is keyed with the connector secret; without one the row
  // carries no digest at all.
  vi.stubEnv("CONNECTOR_PATH_SECRET", "test-connector-secret");
  vi.stubEnv("SUPABASE_URL", "");
  vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "");
});

afterEach(async () => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.doUnmock("@upstash/redis");
  vi.doUnmock("@anthropic-ai/sdk");
  vi.resetModules();
});

describe("brain_ask under one request deadline", () => {
  it("slow mirror + slow reader: replies inside the wall, stamped timed out, uncached, both rows logged", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const events: string[] = [];
    const store = fakeStore(events);
    const reader = mockAnthropic(events, true);
    stubGitHub(events);
    const { __setCache } = await import("../lib/corpus");
    const { __setStore } = await import("../lib/mirror");
    const { REQUEST_WALL_MS, MIRROR_MIN_MS } = await import("../lib/deadline");
    const { MIRROR_DEADLINE_MS } = await import("../lib/corpus");
    __setCache(null);
    __setStore(stalledMirror(events));
    const handler = await captureAsk();

    const t0 = Date.now();
    const pending = handler({ question: "is beacon live" });
    await until(() => events.includes("mirror:snapshot"), "mirror:snapshot", events);
    // The started row was dispatched before anything slow began — before the mirror was even
    // asked. This is the row a platform kill would leave behind.
    expect(events.slice(0, 2)).toEqual(["log:STARTED", "mirror:snapshot"]);
    expect(store.rows[0]).toMatchObject({ tool: "brain_ask", stamp: "STARTED", state: "started", ms: 0, surface: "terminal" });
    expect(typeof store.rows[0].id).toBe("string");
    expect(store.rows[0].digest).toMatch(/^[0-9a-f]{8}$/);
    const { questionDigest } = await import("../lib/calls");
    expect(store.rows[0].digest).toBe(questionDigest("is beacon live", "test-connector-secret"));
    expect(store.rows[0].digest).not.toBe(createHash("sha256").update("is beacon live").digest("hex").slice(0, 8));
    expect(JSON.stringify(store.rows[0])).not.toContain("beacon");

    // The mirror gets its full 20 s (the request has 55 s, less the tarball's reserve), loses,
    // and the tarball serves.
    await vi.advanceTimersByTimeAsync(MIRROR_DEADLINE_MS - 1);
    expect(events).not.toContain("tarball");
    await vi.advanceTimersByTimeAsync(1);
    await until(() => events.includes("tarball"), "tarball", events);
    await until(() => events.includes("reader:start"), "reader:start", events);
    expect(MIRROR_MIN_MS).toBeLessThan(MIRROR_DEADLINE_MS);

    // The reader is handed what is left less the 3 s margin: 55 − 20 − 3 = 32 s, not its 45 s
    // cap. The SDK's own timeout sits one second behind as a backstop, never first.
    expect(reader.timeout).toBe(33_000);
    await vi.advanceTimersByTimeAsync(31_999);
    expect(reader.signal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(reader.signal?.aborted).toBe(true);
    const res = await pending;

    // Inside the wall, with the margin to spare, and the reply is an answer — not an error and
    // not a kill — that says exactly what happened.
    expect(Date.now() - t0).toBeLessThanOrEqual(REQUEST_WALL_MS);
    expect(Date.now() - t0).toBe(52_000);
    const text = res.content[0].text;
    expect(res.isError, text).not.toBe(true);
    expect(text).toMatch(/^UNVERIFIED — timed out: searched 1 notes; the reader was cut off after 32\.0 s, 52\.0 s into the request\./);
    expect(text).toContain("Treat this as unsearched, not as absence.");
    expect(text).toMatch(/MODEL CALL: claude-sonnet-5 was sent 1 notes .* and cut off after 32\.0 s — no answer returned/);
    expect(text).not.toMatch(/read 1 notes/);

    // Never cached: a timed-out verdict is a fact about this call's clock, not the corpus.
    expect(store.sets).toBe(0);
    expect([...store.data.keys()].some((k) => k.includes("anscache"))).toBe(false);

    // The final row carries the started row's id and the reply's stamp; the reader shows the
    // whole order — started, reader, finished.
    expect(events.filter((e) => e.startsWith("log:") || e === "reader:start")).toEqual(["log:STARTED", "reader:start", "log:UNVERIFIED"]);
    expect(store.rows).toHaveLength(2);
    expect(store.rows[1]).toMatchObject({ tool: "brain_ask", stamp: "UNVERIFIED", ms: 52_000, id: store.rows[0].id, model: "claude-sonnet-5" });
    expect(store.rows[1].state).toBeUndefined();
    expect(store.rows[1].cached).toBeUndefined();

    // And the log reader collapses the pair to the one finished call.
    const { readCalls } = await import("../lib/calls");
    const w = await readCalls(86_400_000, Date.now());
    expect(w.source).toBe("store");
    expect(w.rows.map((r) => [r.stamp, r.ms])).toEqual([["UNVERIFIED", 52_000]]);
  });

  it("fast path unchanged: same stamps, same cache behaviour, one collapsed row", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const events: string[] = [];
    const store = fakeStore(events);
    const reader = mockAnthropic(events, false);
    stubGitHub(events);
    const { __setCache } = await import("../lib/corpus");
    const { __setStore } = await import("../lib/mirror");
    __setCache(null);
    __setStore(null);
    const handler = await captureAsk();

    const pending = handler({ question: "is beacon live" });
    await until(() => events.includes("reader:start"), "reader:start", events);
    const fresh = await pending;
    expect(fresh.isError).not.toBe(true);
    expect(fresh.content[0].text).toMatch(/^VERIFIED — this quote is verbatim in projects\/beacon\.md/);
    expect(fresh.content[0].text).toMatch(/MODEL CALL: claude-sonnet-5 read 1 notes/);
    // A fresh request hands the reader its full cap — the deadline only ever cuts it down.
    expect(reader.timeout).toBe(46_000);
    expect(store.sets).toBe(1);
    expect(events.filter((e) => e.startsWith("log:") || e === "reader:start")).toEqual(["log:STARTED", "reader:start", "log:VERIFIED"]);
    expect(store.rows[1]).toMatchObject({ stamp: "VERIFIED", id: store.rows[0].id, model: "claude-sonnet-5" });

    // The hit path: no model call, the cached marker, and again one finished row per call.
    vi.advanceTimersByTime(1_000); // a later call gets a later ts, so the log's order is defined
    const hit = await handler({ question: "is beacon live" });
    expect(hit.content[0].text).toContain("no model call");
    expect(events.filter((e) => e === "reader:start")).toHaveLength(1);
    expect(store.rows).toHaveLength(4);
    expect(store.rows[3]).toMatchObject({ stamp: "VERIFIED", cached: true, id: store.rows[2].id });

    const { readCalls } = await import("../lib/calls");
    const w = await readCalls(86_400_000, Date.now());
    expect(w.rows.map((r) => [r.stamp, r.cached === true])).toEqual([["VERIFIED", false], ["VERIFIED", true]]);
  });
});

describe("the started row, on the memory ring", () => {
  it("is in the ring before the body runs and is replaced in place by the final row", async () => {
    vi.stubEnv(URL_KEY, "");
    vi.stubEnv(TOK_KEY, "");
    const ring = (globalThis as { __cortexCalls?: { log: Row[] } }).__cortexCalls!.log;
    // The ring lives on globalThis and outlives resetModules; an earlier test that failed with a
    // call still in flight would leave its rows here and make this test fail for its reason.
    ring.length = 0;
    const before = ring.length;
    let seenDuringBody: Row | null = null;
    vi.doMock("../lib/proposals", async (orig) => ({
      ...(await orig<object>()),
      acceptProposal: async () => {
        seenDuringBody = { ...ring[ring.length - 1] };
        return { outcome: "committed", path: "notes/a.md", commitSha: "accept123" };
      },
    }));
    const { registerTools } = await import("../lib/tools");
    const { resetStoreForTests } = await import("../lib/calls");
    resetStoreForTests();
    let accept!: (args: { id: string }) => Promise<{ content: Array<{ text: string }> }>;
    registerTools(
      { registerTool: (name: string, _c: unknown, h: never) => { if (name === "brain_accept") accept = h; } } as unknown as McpServer,
      { guest: false }
    );
    await accept({ id: "p1" });
    vi.doUnmock("../lib/proposals");

    expect(seenDuringBody).toMatchObject({ tool: "brain_accept", stamp: "STARTED", state: "started", ms: 0 });
    expect(ring.length).toBe(before + 1);
    const final = ring[ring.length - 1];
    expect(final).toMatchObject({ tool: "brain_accept", stamp: "COMMITTED", id: seenDuringBody!.id });
    expect(final.state).toBeUndefined();
    expect(final.digest).toBeUndefined();
    expect(ring.filter((r) => r.state === "started")).toHaveLength(0);
  });
});
