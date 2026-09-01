import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * The Learning knobs. The invariant worth defending above every feature here: a deployment
 * with an EMPTY store and NO env vars must resolve to exactly the constants the code shipped
 * with — the knobs are a resolution order on top of today's behaviour, never a new behaviour.
 */

const URL_KEY = "KV_REST_API_URL";
const TOK_KEY = "KV_REST_API_TOKEN";

/** A store whose GET returns `value` and whose SET records what it was handed —
 *  settings.test.ts's stub, same shape for the same kind of module. */
function stubStore(value: unknown, opts: { failGet?: boolean } = {}) {
  const writes: string[] = [];
  vi.doMock("@upstash/redis", () => ({
    Redis: class {
      get() {
        if (opts.failGet) return Promise.reject(new Error("store down"));
        return Promise.resolve(value);
      }
      set(_k: string, v: string) {
        writes.push(v);
        return Promise.resolve("OK");
      }
    },
  }));
  vi.stubEnv(URL_KEY, "https://example.upstash.io");
  vi.stubEnv(TOK_KEY, "test-token");
  return writes;
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.doUnmock("@upstash/redis");
  vi.resetModules();
});

describe("the empty-store, no-env deployment", () => {
  it("resolves byte-identically to the code constants — today's behaviour", async () => {
    vi.resetModules();
    vi.stubEnv(URL_KEY, "");
    vi.stubEnv(TOK_KEY, "");
    const { readLearning, resolveLearning } = await import("../lib/learning");
    const { ANSCACHE_TTL_DAYS } = await import("../lib/anscache");
    const { HANDOFF_BUDGET_BYTES } = await import("../lib/handoff");
    const state = await readLearning();
    expect(state.source).toBe("unconfigured");
    const eff = resolveLearning(state);
    expect(eff.ansCache).toBe(true);
    expect(eff.ansCacheTtlDays).toBe(ANSCACHE_TTL_DAYS);
    expect(eff.handoffBudget).toBe(HANDOFF_BUDGET_BYTES);
    expect(eff.watchSupersededLink).toBe(true);
    expect(eff.watchCoaccessGap).toBe(true);
    expect(eff.watchCorrectionChain).toBe(true);
    expect(eff.coaccessFloor).toBe(5);
    expect(Object.values(eff.sources).every((s) => s === "built-in")).toBe(true);
    expect(eff.conflicts).toEqual([]);
  });

  it("keeps the floor default the inbox check re-exports — one constant, two doors", async () => {
    vi.resetModules();
    const { COACCESS_FLOOR } = await import("../lib/learning");
    const inbox = await import("../lib/inbox");
    expect(inbox.COACCESS_FLOOR).toBe(COACCESS_FLOOR);
  });
});

describe("resolution order: console beats env beats built-in", () => {
  it("a stored selection wins over a set env var", async () => {
    vi.resetModules();
    stubStore(JSON.stringify({ coaccessFloor: 3, ansCache: false }));
    vi.stubEnv("COACCESS_FLOOR", "8");
    vi.stubEnv("ANSWER_CACHE", "on");
    const { effectiveLearning } = await import("../lib/learning");
    const eff = await effectiveLearning();
    expect(eff.coaccessFloor).toBe(3);
    expect(eff.sources.coaccessFloor).toBe("console");
    expect(eff.ansCache).toBe(false);
    expect(eff.sources.ansCache).toBe("console");
  });

  it("env fills where the store is silent, one knob at a time", async () => {
    vi.resetModules();
    stubStore(JSON.stringify({ ansCacheTtlDays: 3 }));
    vi.stubEnv("HANDOFF_BUDGET", "32000");
    vi.stubEnv("WATCH_COACCESS_GAP", "off");
    const { effectiveLearning } = await import("../lib/learning");
    const eff = await effectiveLearning();
    expect(eff.ansCacheTtlDays).toBe(3);
    expect(eff.sources.ansCacheTtlDays).toBe("console");
    expect(eff.handoffBudget).toBe(32000);
    expect(eff.sources.handoffBudget).toBe("env");
    expect(eff.watchCoaccessGap).toBe(false);
    expect(eff.sources.watchCoaccessGap).toBe("env");
    // Untouched knobs stay on the code default — a partial selection never freezes the rest.
    expect(eff.sources.watchSupersededLink).toBe("built-in");
  });
});

describe("values that cannot be honoured are reported, never repaired", () => {
  it("env garbage lands as a conflict sentence and the default holds", async () => {
    vi.resetModules();
    vi.stubEnv(URL_KEY, "");
    vi.stubEnv(TOK_KEY, "");
    vi.stubEnv("COACCESS_FLOOR", "eleven");
    vi.stubEnv("ANSWER_CACHE", "maybe");
    vi.stubEnv("HANDOFF_BUDGET", "999999"); // out of bounds — same treatment as garbage
    const { effectiveLearning } = await import("../lib/learning");
    const { HANDOFF_BUDGET_BYTES } = await import("../lib/handoff");
    const eff = await effectiveLearning();
    expect(eff.coaccessFloor).toBe(5);
    expect(eff.ansCache).toBe(true);
    expect(eff.handoffBudget).toBe(HANDOFF_BUDGET_BYTES);
    expect(eff.conflicts.join(" ")).toMatch(/COACCESS_FLOOR/);
    expect(eff.conflicts.join(" ")).toMatch(/ANSWER_CACHE/);
    expect(eff.conflicts.join(" ")).toMatch(/HANDOFF_BUDGET/);
  });

  it("a stored value off its bounds is a conflict and falls through, not a clamp", async () => {
    vi.resetModules();
    stubStore(JSON.stringify({ coaccessFloor: 99, ansCacheTtlDays: "week", ansCache: false }));
    const { effectiveLearning } = await import("../lib/learning");
    const eff = await effectiveLearning();
    // The two bad fields fall through to defaults; the good one still applies.
    expect(eff.coaccessFloor).toBe(5);
    expect(eff.ansCacheTtlDays).toBe(7);
    expect(eff.ansCache).toBe(false);
    expect(eff.conflicts.length).toBe(2);
    expect(eff.conflicts.join(" ")).toMatch(/co-read floor/);
  });

  it("survives a hand-edited key that is not JSON", async () => {
    vi.resetModules();
    stubStore("{{{ not json");
    const { readLearning } = await import("../lib/learning");
    const s = await readLearning();
    expect(s.selection).toEqual({});
    expect(s.conflicts.join(" ")).toMatch(/not valid JSON/);
  });

  it("an unreachable store degrades to defaults and says which fallback it is", async () => {
    vi.resetModules();
    stubStore(null, { failGet: true });
    const { readLearning, resolveLearning } = await import("../lib/learning");
    const s = await readLearning();
    expect(s.source).toBe("unreachable");
    expect(resolveLearning(s).coaccessFloor).toBe(5);
  });
});

describe("writes refuse rather than repair", () => {
  it("round-trips a partial selection", async () => {
    vi.resetModules();
    const writes = stubStore(null);
    const { writeLearning } = await import("../lib/learning");
    await writeLearning({ coaccessFloor: 6, watchCoaccessGap: false });
    expect(JSON.parse(writes[0])).toEqual({ coaccessFloor: 6, watchCoaccessGap: false });
  });

  it("refuses an out-of-bounds number and a mistyped switch", async () => {
    vi.resetModules();
    const writes = stubStore(null);
    const { writeLearning } = await import("../lib/learning");
    await expect(writeLearning({ coaccessFloor: 1 })).rejects.toThrow(/between 2-10/);
    await expect(writeLearning({ ansCacheTtlDays: 2.5 })).rejects.toThrow(/whole number/);
    await expect(
      writeLearning({ ansCache: "yes" as unknown as boolean })
    ).rejects.toThrow(/true or false/);
    expect(writes).toHaveLength(0);
  });

  it("refuses to write when no store exists, in words", async () => {
    vi.resetModules();
    vi.stubEnv(URL_KEY, "");
    vi.stubEnv(TOK_KEY, "");
    const { writeLearning } = await import("../lib/learning");
    await expect(writeLearning({ ansCache: false })).rejects.toThrow(/no KV store/);
  });
});

describe("applyLearningPatch — one click's worth of change", () => {
  it("folds a field into the current selection and leaves the rest alone", async () => {
    const { applyLearningPatch } = await import("../lib/learning");
    const next = applyLearningPatch({ ansCache: false, coaccessFloor: 6 }, { coaccessFloor: 7 });
    expect(next).toEqual({ ansCache: false, coaccessFloor: 7 });
  });

  it("null clears a knob back to env-and-code defaults", async () => {
    const { applyLearningPatch } = await import("../lib/learning");
    expect(applyLearningPatch({ ansCache: false }, { ansCache: null })).toEqual({});
  });

  it("refuses an unknown field — a typo must not become a silent no-op", async () => {
    const { applyLearningPatch } = await import("../lib/learning");
    expect(() => applyLearningPatch({}, { ansCasche: true })).toThrow(/not a learning setting/);
  });

  it("refuses bounds violations with the bounds in the sentence", async () => {
    const { applyLearningPatch } = await import("../lib/learning");
    expect(() => applyLearningPatch({}, { ansCacheTtlDays: 31 })).toThrow(/1-30/);
    expect(() => applyLearningPatch({}, { handoffBudget: 100 })).toThrow(/4000-100000/);
  });
});
