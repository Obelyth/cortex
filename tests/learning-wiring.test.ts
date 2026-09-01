import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { McpServer } from "@modelcontextprotocol/server";
import type { Corpus } from "../lib/corpus";

/**
 * The Learning knobs, wired — every test here proves a REAL code path changed, through the real
 * tool handlers (anscache.test.ts's harness: fake SDK one level down, everything above is what
 * ships). What is defended:
 *
 *   1. Answer cache OFF skips both the lookup and the store, on both doors — a switched-off
 *      cache can neither serve yesterday's answer nor pin today's.
 *   2. The TTL knob rides the SET's expiry, in seconds.
 *   3. brain_handoff's budget resolves call arg → console setting → code default.
 *   4. An OFF watch check contributes zero items (and skips its store read); the co-read floor
 *      moves the coaccess-gap threshold.
 */

const URL_KEY = "KV_REST_API_URL";
const TOK_KEY = "KV_REST_API_TOKEN";
const LEARNING_KEY = "cortex:learning:development";

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

/** anscache.test.ts's stateful fake, extended with scan/del and SET-option capture so the TTL
 *  and the count/clear paths are observable. */
function fakeStore(seed: Record<string, string> = {}) {
  const data = new Map<string, string>(Object.entries(seed));
  const setOpts = new Map<string, unknown>();
  const state = { data, setOpts, sets: 0, incrs: 0 };
  vi.doMock("@upstash/redis", () => ({
    Redis: class {
      get(k: string) {
        return Promise.resolve(data.get(k) ?? null);
      }
      set(k: string, v: string, opts?: unknown) {
        state.sets++;
        data.set(k, v);
        if (opts !== undefined) setOpts.set(k, opts);
        return Promise.resolve("OK");
      }
      incr() {
        state.incrs++;
        return Promise.resolve(1);
      }
      expire() {
        return Promise.resolve(1);
      }
      scan(_cursor: number | string, { match }: { match: string }) {
        // One page is enough for a fake: every key under the prefix, cursor closed.
        const prefix = match.endsWith("*") ? match.slice(0, -1) : match;
        return Promise.resolve(["0", [...data.keys()].filter((k) => k.startsWith(prefix))]);
      }
      del(...keys: string[]) {
        let n = 0;
        for (const k of keys) if (data.delete(k)) n++;
        return Promise.resolve(n);
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

function mockAnthropic(counter: { calls: number }) {
  vi.doMock("@anthropic-ai/sdk", () => ({
    default: class {
      messages = {
        create: async (params: { messages: Array<{ content: Array<{ text: string }> }> }) => {
          counter.calls++;
          const stable = params.messages[0].content[0].text;
          const tag = stable.match(/FILE: projects\/beacon\.md \[tag: ([0-9a-z]+)\]/)?.[1] ?? "";
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

type Handler = (args: Record<string, unknown>) => Promise<{ content: Array<{ text: string }>; isError?: boolean }>;

async function captureTool(name: string, guest = false): Promise<Handler> {
  const { registerTools } = await import("../lib/tools");
  const tools = new Map<string, Handler>();
  const fake = {
    registerTool(n: string, _config: unknown, handler: never) {
      tools.set(n, handler);
    },
  };
  registerTools(fake as unknown as McpServer, { guest });
  return tools.get(name)!;
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

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.doUnmock("@upstash/redis");
  vi.doUnmock("@anthropic-ai/sdk");
  vi.doUnmock("../lib/handoff");
  vi.resetModules();
});

describe("answer cache OFF", () => {
  it("trusted door: identical asks both reach the model, and nothing lands under anscache", async () => {
    const store = fakeStore({ [LEARNING_KEY]: JSON.stringify({ ansCache: false }) });
    const counter = { calls: 0 };
    mockAnthropic(counter);
    await pinCorpus();
    const ask = await captureTool("brain_ask");

    const first = await ask({ question: "is beacon live" });
    expect(first.isError).toBeUndefined();
    expect(first.content[0].text).toContain("MODEL CALL:");
    const second = await ask({ question: "is beacon live" });
    expect(second.content[0].text).toContain("MODEL CALL:");
    expect(second.content[0].text).not.toContain("cached · answered at");
    expect(counter.calls).toBe(2); // no lookup served, no entry pinned
    expect([...store.data.keys()].filter((k) => k.includes("anscache"))).toHaveLength(0);
  });

  it("guest door: off skips the cache there too, so repeats pay the meter again", async () => {
    const policy = JSON.stringify({ scope: ["projects/"], citations: false, dailyAsks: 50, maxK: 8 });
    const store = fakeStore({
      "cortex:guest:development": policy,
      [LEARNING_KEY]: JSON.stringify({ ansCache: false }),
    });
    const counter = { calls: 0 };
    mockAnthropic(counter);
    await pinCorpus();
    const ask = await captureTool("brain_ask", true);

    await ask({ question: "is beacon live" });
    await ask({ question: "is beacon live" });
    expect(counter.calls).toBe(2);
    expect(store.incrs).toBe(2); // metered both times — the pre-cache behaviour, exactly
    expect([...store.data.keys()].filter((k) => k.includes("anscache"))).toHaveLength(0);
  });
});

describe("the TTL knob", () => {
  it("rides the cache SET as seconds", async () => {
    const store = fakeStore({ [LEARNING_KEY]: JSON.stringify({ ansCacheTtlDays: 3 }) });
    const counter = { calls: 0 };
    mockAnthropic(counter);
    await pinCorpus();
    const ask = await captureTool("brain_ask");

    await ask({ question: "is beacon live" });
    const key = [...store.data.keys()].find((k) => k.includes("anscache"))!;
    expect(key).toBeDefined();
    expect(store.setOpts.get(key)).toEqual({ ex: 3 * 86_400 });
  });
});

describe("the handoff budget", () => {
  /** The real constants, a capturing assembler — the resolution happens in tools.ts and that
   *  is the code under test. */
  async function captureHandoff(budgets: Array<number | undefined>) {
    const actual = await vi.importActual<typeof import("../lib/handoff")>("../lib/handoff");
    vi.doMock("../lib/handoff", () => ({
      ...actual,
      assembleHandoff: async (_project: string, budget?: number) => {
        budgets.push(budget);
        return "HANDOFF · fixture";
      },
    }));
    return captureTool("brain_handoff");
  }

  it("resolves call arg → console setting → code default", async () => {
    const { HANDOFF_BUDGET_BYTES } = await vi.importActual<typeof import("../lib/handoff")>("../lib/handoff");

    // No selection, no arg: the code default.
    fakeStore();
    let budgets: Array<number | undefined> = [];
    let handoff = await captureHandoff(budgets);
    await handoff({ project: "cortex" });
    expect(budgets).toEqual([HANDOFF_BUDGET_BYTES]);

    // A console selection decides when the caller does not.
    vi.resetModules();
    vi.doUnmock("@upstash/redis");
    fakeStore({ [LEARNING_KEY]: JSON.stringify({ handoffBudget: 32000 }) });
    budgets = [];
    handoff = await captureHandoff(budgets);
    await handoff({ project: "cortex" });
    expect(budgets).toEqual([32000]);

    // The caller's own budget still wins over the selection.
    await handoff({ project: "cortex", budget: 50000 });
    expect(budgets).toEqual([32000, 50000]);
  });
});

describe("the watch switches and the co-read floor", () => {
  const files = new Map(
    Object.entries({
      "notes/dead.md": `---\ndescription: "SUPERSEDED — retired; kept for the why"\n---\n\n# Old plan\n`,
      "projects/harbor.md": "# Harbor\n\nThe rules live in [[dead]] still.\n",
      "projects/alpha.md": "# Alpha\n\n**CORRECTION 2026-08-01:** the port in notes/beta.md was wrong.\n",
      "notes/beta.md": '# Beta\n\nPort is 8443 (was: "9443 per projects/alpha.md, re-measured").\n',
    })
  );
  const coRow = (weight: number) =>
    JSON.stringify([
      { src: "notes/beta.md", dst: "projects/harbor.md", kind: "coaccess", weight, evidence: `co-read in ${weight} shared one-hour windows` },
    ]);

  /** Postgres answers coaccess; the KV fake answers the learning read; GitHub is never asked
   *  because the corpus rides in as an argument. */
  function stubEdgeFetch(body: string) {
    vi.stubEnv("SUPABASE_URL", "https://x.supabase.co");
    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "k");
    const f = vi.fn(async () => new Response(body, { status: 200, headers: { "Content-Type": "application/json" } }));
    vi.stubGlobal("fetch", f);
    return f;
  }

  it("an OFF check contributes zero items, and the coaccess read is skipped entirely", async () => {
    fakeStore({
      [LEARNING_KEY]: JSON.stringify({ watchSupersededLink: false, watchCoaccessGap: false }),
    });
    const f = stubEdgeFetch(coRow(9));
    const { watchItems } = await import("../lib/inbox");
    const items = await watchItems({ files });
    expect(items.map((i) => i.kind)).toEqual(["correction-chain"]);
    expect(f).not.toHaveBeenCalled(); // no Postgres round-trip for items that would be discarded
  });

  it("all three off: the queue is empty by construction", async () => {
    fakeStore({
      [LEARNING_KEY]: JSON.stringify({
        watchSupersededLink: false,
        watchCoaccessGap: false,
        watchCorrectionChain: false,
      }),
    });
    const { watchItems } = await import("../lib/inbox");
    expect(await watchItems({ files })).toEqual([]);
  });

  it("floor 6 silences a weight-5 pair that the default floor surfaces", async () => {
    fakeStore({ [LEARNING_KEY]: JSON.stringify({ coaccessFloor: 6 }) });
    stubEdgeFetch(coRow(5));
    const { watchItems } = await import("../lib/inbox");
    const items = await watchItems({ files });
    expect(items.filter((i) => i.kind === "coaccess-gap")).toHaveLength(0);

    // Same store state, a heavier pair: the raised floor is a threshold, not an off switch.
    stubEdgeFetch(coRow(6));
    const again = await watchItems({ files });
    const gap = again.filter((i) => i.kind === "coaccess-gap");
    expect(gap).toHaveLength(1);
    expect(gap[0].action).toContain("below 6 shared windows");
  });
});

describe("count and clear", () => {
  it("counts what is stored and clears exactly that, reporting the number", async () => {
    const store = fakeStore();
    const { cacheKey, writeAnswerCache, countAnswerCache, clearAnswerCache } = await import("../lib/anscache");
    const entry = { reply: "VERIFIED — x", stamp: "VERIFIED", model: "m", commit: "eaf0a03e4849", corpusTokens: 1, ts: 1 };
    const policy = { door: "trusted" as const, scope: [], citations: true };
    writeAnswerCache(cacheKey({ question: "a", sha: corpus.sha, model: "m", k: 10 }, policy), entry);
    writeAnswerCache(cacheKey({ question: "b", sha: corpus.sha, model: "m", k: 10 }, policy), entry);
    // A neighbouring key family must be neither counted nor cleared.
    store.data.set("cortex:guest:development", "{}");

    expect(await countAnswerCache()).toBe(2);
    expect(await clearAnswerCache()).toBe(2);
    expect(await countAnswerCache()).toBe(0);
    expect(store.data.has("cortex:guest:development")).toBe(true);
  });

  it("count degrades to null without a store; clear refuses in words", async () => {
    vi.stubEnv(URL_KEY, "");
    vi.stubEnv(TOK_KEY, "");
    const { countAnswerCache, clearAnswerCache } = await import("../lib/anscache");
    expect(await countAnswerCache()).toBeNull();
    await expect(clearAnswerCache()).rejects.toThrow(/no KV store/);
  });
});
