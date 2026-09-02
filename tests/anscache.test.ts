import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { McpServer } from "@modelcontextprotocol/server";
import type { Corpus } from "../lib/corpus";

/**
 * The answer cache. What these tests defend:
 *
 *   1. The KEY is the honesty mechanism — it carries the corpus head, the resolved model, the
 *      pack shape and the FULL answer policy, so a guest-policy answer can never serve a
 *      trusted caller (or vice versa) and a brain write invalidates everything by moving the
 *      head. Get the key wrong and the cache serves answers a caller was never entitled to.
 *   2. A hit calls NO model, says so visibly, and — on the guest door — does not charge the
 *      daily budget.
 *   3. The store is never the authority: unreachable KV and malformed entries are misses, and
 *      a miss's write overwrites whatever was there.
 */

const URL_KEY = "KV_REST_API_URL";
const TOK_KEY = "KV_REST_API_TOKEN";

const corpus: Corpus = {
  sha: "eaf0a03e4849aaaa",
  bytes: 200,
  fetchedAt: Date.now(),
  sidecar: new Map(),
  files: new Map([
    ["projects/beacon.md", "**Production is still dark** (re-checked 2026-07-25). Both URLs still return 404."],
    ["projects/harbor.md", "The plates backlog went into a deleted database."],
  ]),
};

const SHAPE = { question: "is beacon live", sha: corpus.sha, model: "claude-sonnet-5", k: 10 as const };
const TRUSTED = { door: "trusted" as const, scope: [], citations: true };
const GUEST = { door: "guest" as const, scope: ["projects/"], citations: false };

afterEach(() => {
  vi.unstubAllEnvs();
  vi.doUnmock("@upstash/redis");
  vi.doUnmock("@anthropic-ai/sdk");
  vi.resetModules();
});

describe("cache key fingerprinting", () => {
  async function keys() {
    return import("../lib/anscache");
  }

  it("is stable for the same ask, whitespace and case folded on the question", async () => {
    const { cacheKey } = await keys();
    expect(cacheKey(SHAPE, TRUSTED)).toBe(cacheKey(SHAPE, TRUSTED));
    expect(cacheKey({ ...SHAPE, question: "  Is   BEACON live " }, TRUSTED)).toBe(
      cacheKey(SHAPE, TRUSTED)
    );
  });

  it("treats the scope as a set — two orderings of the same entries are one key", async () => {
    const { cacheKey } = await keys();
    const a = cacheKey(SHAPE, { ...GUEST, scope: ["projects/", "notes/"] });
    const b = cacheKey(SHAPE, { ...GUEST, scope: ["notes/", "projects/"] });
    expect(a).toBe(b);
  });

  it("changes on every fingerprint dimension — head, model, k, door, scope, citations", async () => {
    const { cacheKey } = await keys();
    const base = cacheKey(SHAPE, TRUSTED);
    const variants = [
      cacheKey({ ...SHAPE, question: "is harbor live" }, TRUSTED),
      cacheKey({ ...SHAPE, sha: "ffff0000ffff0000" }, TRUSTED), // any write moves the head
      cacheKey({ ...SHAPE, model: "claude-opus-5" }, TRUSTED),
      cacheKey({ ...SHAPE, k: 5 }, TRUSTED),
      cacheKey({ ...SHAPE, k: "full" }, TRUSTED),
      // The policy half. A guest-policy answer must never serve a trusted caller or vice
      // versa — the door, the scope and the citations flag each split the keyspace.
      cacheKey(SHAPE, GUEST),
      cacheKey(SHAPE, { ...TRUSTED, citations: false }),
      cacheKey(SHAPE, { ...GUEST, scope: ["notes/"] }),
      cacheKey(SHAPE, { ...GUEST, citations: true }),
    ];
    expect(new Set([base, ...variants]).size).toBe(variants.length + 1);
  });

  it("normalises the question without deciding paraphrase — different words are different keys", async () => {
    const { normaliseQuestion, cacheKey } = await keys();
    expect(normaliseQuestion("  Is\n\nbeacon\tLIVE?  ")).toBe("is beacon live?");
    expect(cacheKey({ ...SHAPE, question: "is beacon up" }, TRUSTED)).not.toBe(
      cacheKey(SHAPE, TRUSTED)
    );
  });
});

/**
 * A stateful fake Upstash client. One shared map per test, so writes from one code path are
 * visible to reads from another — which is what the hit/miss tests are about.
 */
function fakeStore(seed: Record<string, string> = {}) {
  const data = new Map<string, string>(Object.entries(seed));
  const counters = new Map<string, number>();
  const state = {
    data,
    counters,
    sets: 0,
    incrs: 0,
  };
  vi.doMock("@upstash/redis", () => ({
    Redis: class {
      get(k: string) {
        return Promise.resolve(data.get(k) ?? counters.get(k) ?? null);
      }
      set(k: string, v: string) {
        state.sets++;
        data.set(k, v);
        return Promise.resolve("OK");
      }
      incr(k: string) {
        state.incrs++;
        const n = (counters.get(k) ?? 0) + 1;
        counters.set(k, n);
        return Promise.resolve(n);
      }
      expire() {
        return Promise.resolve(1);
      }
      lrange() {
        return Promise.resolve([]);
      }
      pipeline() {
        return { lpush() {}, ltrim() {}, setnx() {}, exec: () => Promise.resolve([]) };
      }
    },
  }));
  vi.stubEnv(URL_KEY, "https://example.upstash.io");
  vi.stubEnv(TOK_KEY, "test-token");
  return state;
}

const ENTRY = {
  reply: "VERIFIED — proven.\n\nNo, production is dark.",
  stamp: "VERIFIED",
  model: "claude-sonnet-5",
  commit: "eaf0a03e4849",
  corpusTokens: 50,
  ts: Date.now(),
};

describe("read/write against the store", () => {
  it("round-trips an entry, and a missing key is a miss", async () => {
    const store = fakeStore();
    const { cacheKey, readAnswerCache, writeAnswerCache } = await import("../lib/anscache");
    const key = cacheKey(SHAPE, TRUSTED);
    expect(await readAnswerCache(key)).toBeNull();
    writeAnswerCache(key, ENTRY);
    expect(store.sets).toBe(1);
    expect(await readAnswerCache(key)).toEqual(ENTRY);
  });

  it("treats a malformed entry as a miss, and the next write overwrites it", async () => {
    const bads = [
      "not json at all",
      JSON.stringify({ reply: "", stamp: "VERIFIED", model: "m", commit: "eaf0a03e4849" }),
      JSON.stringify({ reply: "x", stamp: "VERIFIED", model: "m", commit: "not-a-sha" }),
      JSON.stringify({ reply: "x", stamp: 7, model: "m", commit: "eaf0a03e4849" }),
      JSON.stringify(["an", "array"]),
    ];
    for (const bad of bads) {
      vi.resetModules();
      vi.doUnmock("@upstash/redis");
      const store = fakeStore();
      const { cacheKey, readAnswerCache, writeAnswerCache } = await import("../lib/anscache");
      const key = cacheKey(SHAPE, TRUSTED);
      store.data.set(key, bad);
      expect(await readAnswerCache(key)).toBeNull();
      // Recovery is the ordinary miss path: the fresh answer's SET replaces the junk.
      writeAnswerCache(key, ENTRY);
      expect(await readAnswerCache(key)).toEqual(ENTRY);
      vi.unstubAllEnvs();
    }
  });

  it("reads through missing optional meta rather than discarding a servable entry", async () => {
    const store = fakeStore();
    const { cacheKey, readAnswerCache } = await import("../lib/anscache");
    const key = cacheKey(SHAPE, TRUSTED);
    const { corpusTokens: _c, ts: _t, ...lean } = ENTRY;
    store.data.set(key, JSON.stringify(lean));
    expect(await readAnswerCache(key)).toEqual({ ...lean, corpusTokens: 0, ts: 0 });
  });

  it("is silently absent when the store is down or unconfigured — never an error", async () => {
    vi.doMock("@upstash/redis", () => ({
      Redis: class {
        get() {
          return Promise.reject(new Error("store down"));
        }
        set() {
          return Promise.reject(new Error("store down"));
        }
      },
    }));
    vi.stubEnv(URL_KEY, "https://example.upstash.io");
    vi.stubEnv(TOK_KEY, "test-token");
    const down = await import("../lib/anscache");
    expect(await down.readAnswerCache(down.cacheKey(SHAPE, TRUSTED))).toBeNull();
    expect(() => down.writeAnswerCache(down.cacheKey(SHAPE, TRUSTED), ENTRY)).not.toThrow();

    vi.resetModules();
    vi.doUnmock("@upstash/redis");
    vi.stubEnv(URL_KEY, "");
    vi.stubEnv(TOK_KEY, "");
    const off = await import("../lib/anscache");
    expect(await off.readAnswerCache(off.cacheKey(SHAPE, TRUSTED))).toBeNull();
    expect(() => off.writeAnswerCache(off.cacheKey(SHAPE, TRUSTED), ENTRY)).not.toThrow();
  });
});

/**
 * Tool-level: the real handlers, the real reader path, a fake SDK. The Anthropic client is
 * mocked one level down so everything above it — activeReader, the cache, ask(), render(),
 * the call log — is the code that ships.
 */
function mockAnthropic(counter: { calls: number }) {
  vi.doMock("@anthropic-ai/sdk", () => ({
    default: class {
      messages = {
        create: async (params: { messages: Array<{ content: Array<{ text: string }> }> }) => {
          counter.calls++;
          // Read the target file's tag off the packed prefix, like a real reader would.
          const stable = params.messages[0].content[0].text;
          const tag =
            stable.match(/FILE: projects\/beacon\.md \[tag: ([0-9a-z]+)\]/)?.[1] ?? "";
          return {
            stop_reason: "end_turn",
            content: [
              {
                type: "text",
                text: JSON.stringify({
                  answer: "No — production is dark.",
                  tag,
                  quote: "Production is still dark",
                }),
              },
            ],
          };
        },
      };
    },
  }));
}

async function captureAsk(guest: boolean) {
  const { registerTools } = await import("../lib/tools");
  const tools = new Map<string, (args: Record<string, unknown>) => Promise<{ content: Array<{ text: string }>; isError?: boolean }>>();
  const fake = {
    registerTool(name: string, _config: unknown, handler: never) {
      tools.set(name, handler);
    },
  };
  registerTools(fake as unknown as McpServer, { guest });
  return tools.get("brain_ask")!;
}

async function pinCorpus() {
  const { __setCache } = await import("../lib/corpus");
  __setCache(corpus);
}

beforeEach(() => {
  vi.stubEnv("BRAIN_REPO", "acme/brain");
  vi.stubEnv("GITHUB_TOKEN", "test");
  vi.stubEnv("ANTHROPIC_API_KEY", "test-key");
  const head = (async (url: string | URL) => {
    if (String(url).includes("/commits/")) {
      return new Response(JSON.stringify({ sha: corpus.sha }), { status: 200 });
    }
    throw new Error(`unexpected fetch: ${url}`);
  }) as typeof fetch;
  vi.stubGlobal("fetch", head);
});

describe("trusted door: hit, miss, marker", () => {
  it("answers fresh once, then serves the cache with a visible marker and no model call", async () => {
    const store = fakeStore();
    const counter = { calls: 0 };
    mockAnthropic(counter);
    await pinCorpus();
    const ask = await captureAsk(false);

    const fresh = await ask({ question: "is beacon live" });
    expect(fresh.isError).toBeUndefined();
    const freshText = fresh.content[0].text;
    expect(freshText).toMatch(/^VERIFIED/);
    expect(freshText).toContain("MODEL CALL:");
    expect(counter.calls).toBe(1);

    const hit = await ask({ question: "  IS beacon   live " }); // normalised to the same key
    const hitText = hit.content[0].text;
    expect(counter.calls).toBe(1); // ZERO model calls on the hit
    expect(hitText).toMatch(/^VERIFIED/);
    expect(hitText).toMatch(/cached · answered at [0-9a-f]{8}/);
    // The egress disclosure must not imply a fresh model call was made.
    expect(hitText).toContain("no model call");
    expect(hitText).not.toContain("MODEL CALL:");

    // A different question is a different key — fresh again, and cached under its own entry.
    await ask({ question: "is beacon production still dark" });
    expect(counter.calls).toBe(2);
    expect([...store.data.keys()].filter((k) => k.includes("anscache"))).toHaveLength(2);
  });

  it("does not cache an UNVERIFIED reply — a bad roll is not a fact about the corpus", async () => {
    fakeStore();
    let calls = 0;
    vi.doMock("@anthropic-ai/sdk", () => ({
      default: class {
        messages = {
          create: async () => {
            calls++;
            return {
              stop_reason: "end_turn",
              content: [
                {
                  type: "text",
                  // A fabricated quote: verifies false, renders UNVERIFIED.
                  text: JSON.stringify({ answer: "It shipped.", tag: "deadbeef0", quote: "Beacon is fully live in production" }),
                },
              ],
            };
          },
        };
      },
    }));
    await pinCorpus();
    const ask = await captureAsk(false);

    const first = await ask({ question: "is beacon live" });
    expect(first.content[0].text).toMatch(/^UNVERIFIED/);
    const second = await ask({ question: "is beacon live" });
    expect(second.content[0].text).toMatch(/^UNVERIFIED/);
    expect(calls).toBe(2); // both went to the model — nothing was pinned
  });
});

describe("guest door: a hit does not charge the budget", () => {
  const policyKey = "cortex:guest:development";
  const policy = JSON.stringify({ scope: ["projects/"], citations: false, dailyAsks: 1, maxK: 8 });

  it("meters the miss, serves repeats free, and keeps serving them once the budget is spent", async () => {
    const store = fakeStore({ [policyKey]: policy });
    const counter = { calls: 0 };
    mockAnthropic(counter);
    await pinCorpus();
    const ask = await captureAsk(true);

    // Miss: metered (INCR once) and answered by the model.
    const fresh = await ask({ question: "is beacon live" });
    expect(fresh.isError).toBeUndefined();
    expect(counter.calls).toBe(1);
    expect(store.incrs).toBe(1);

    // Hit: no model call AND no INCR — checked before the meter.
    const hit = await ask({ question: "is beacon live" });
    expect(hit.isError).toBeUndefined();
    expect(hit.content[0].text).toMatch(/cached · answered at [0-9a-f]{8}/);
    expect(counter.calls).toBe(1);
    expect(store.incrs).toBe(1);

    // The budget (dailyAsks: 1) is now spent. A NEW question is refused by the meter…
    const refused = await ask({ question: "what happened to the plates backlog" });
    expect(refused.isError).toBe(true);
    expect(refused.content[0].text).toMatch(/daily limit/);
    // …while the cached answer keeps serving, because it costs the operator nothing.
    const stillServed = await ask({ question: "is beacon live" });
    expect(stillServed.isError).toBeUndefined();
    expect(stillServed.content[0].text).toMatch(/cached · answered at/);
    expect(counter.calls).toBe(1);
  });

  it("keeps guest and trusted answers apart — same question, different doors, different entries", async () => {
    const store = fakeStore({ [policyKey]: policy });
    const counter = { calls: 0 };
    mockAnthropic(counter);
    await pinCorpus();

    const guestAsk = await captureAsk(true);
    const g = await guestAsk({ question: "is beacon live" });
    expect(counter.calls).toBe(1);
    // The guest reply carries no source path — the shape the guest policy demands.
    expect(g.content[0].text).not.toContain("projects/beacon.md");

    const trustedAsk = await captureAsk(false);
    const t = await trustedAsk({ question: "is beacon live" });
    // The trusted ask must NOT be served the guest's citation-stripped entry.
    expect(counter.calls).toBe(2);
    expect(t.content[0].text).toContain("projects/beacon.md");

    // And the two entries coexist under different keys.
    const cacheKeys = [...store.data.keys()].filter((k) => k.includes("anscache"));
    expect(cacheKeys).toHaveLength(2);
  });
});
