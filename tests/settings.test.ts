import { describe, expect, it, vi, afterEach } from "vitest";

/**
 * Console settings — the first mutable state in the system, so the tests here are mostly about
 * what it must REFUSE to do. The invariant worth defending above all others: no combination of
 * settings, and no state of the store, may leave brain_ask without a reader to call.
 */

const URL_KEY = "KV_REST_API_URL";
const TOK_KEY = "KV_REST_API_TOKEN";

/** A store whose GET returns `value` and whose SET records what it was handed. */
function stubStore(value: unknown, opts: { failSet?: boolean } = {}) {
  const writes: string[] = [];
  vi.doMock("@upstash/redis", () => ({
    Redis: class {
      get() {
        return Promise.resolve(value);
      }
      set(_k: string, v: string) {
        if (opts.failSet) return Promise.reject(new Error("store down"));
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

describe("settings storage", () => {
  it("reports an unconfigured store rather than inventing defaults", async () => {
    vi.resetModules();
    vi.stubEnv(URL_KEY, "");
    vi.stubEnv(TOK_KEY, "");
    const { readSettings } = await import("../lib/settings");
    const s = await readSettings();
    expect(s.source).toBe("unconfigured");
    expect(s.defaultReader).toBeNull();
    expect(s.disabledProviders).toEqual([]);
  });

  it("round-trips a stored setting", async () => {
    vi.resetModules();
    stubStore(JSON.stringify({ defaultReader: "gpt-5.6-terra", disabledProviders: ["google"] }));
    const { readSettings } = await import("../lib/settings");
    const s = await readSettings();
    expect(s.source).toBe("store");
    expect(s.defaultReader).toBe("gpt-5.6-terra");
    expect(s.disabledProviders).toEqual(["google"]);
    expect(s.conflicts).toEqual([]);
  });

  it("reports a stored model that is no longer on the allowlist instead of using it", async () => {
    // The shape this actually takes in life: a model is retired from READER_MODEL_IDS and a
    // stale default is left behind in the store. Silently reading with something else while
    // the screen still shows the old name is the one outcome that must not happen.
    vi.resetModules();
    stubStore(JSON.stringify({ defaultReader: "claude-retired-9", disabledProviders: [] }));
    const { readSettings, activeReader } = await import("../lib/settings");
    const s = await readSettings();
    expect(s.defaultReader).toBeNull();
    expect(s.conflicts.join(" ")).toMatch(/not on the allowlist/);
    // And the read path really does fall through to the built-in rather than throwing.
    expect((await activeReader(undefined, s)).source).toBe("built-in");
  });

  it("survives a hand-edited key that is not JSON", async () => {
    vi.resetModules();
    stubStore("{{{ not json");
    const { readSettings } = await import("../lib/settings");
    const s = await readSettings();
    expect(s.defaultReader).toBeNull();
    expect(s.conflicts.join(" ")).toMatch(/not valid JSON/);
  });

  it("degrades to unreachable without throwing when the store is down", async () => {
    vi.resetModules();
    vi.doMock("@upstash/redis", () => ({
      Redis: class {
        get() {
          return Promise.reject(new Error("store down"));
        }
      },
    }));
    vi.stubEnv(URL_KEY, "https://example.upstash.io");
    vi.stubEnv(TOK_KEY, "test-token");
    const { readSettings, activeReader } = await import("../lib/settings");
    const s = await readSettings();
    expect(s.source).toBe("unreachable");
    // Fail OPEN: a store blip must not silently change which model reads the brain, and must
    // not disable every provider on the way past.
    expect(s.disabledProviders).toEqual([]);
    await expect(activeReader(undefined, s)).resolves.toMatchObject({ source: "built-in" });
  });
});

describe("writeSettings refuses rather than repairs", () => {
  it("rejects a model off the allowlist", async () => {
    vi.resetModules();
    stubStore(null);
    const { writeSettings } = await import("../lib/settings");
    await expect(
      writeSettings({ defaultReader: "gpt-6" as never, disabledProviders: [] })
    ).rejects.toThrow(/not an allowed reader model/);
  });

  it("rejects a default whose provider the same write turns off", async () => {
    vi.resetModules();
    stubStore(null);
    const { writeSettings } = await import("../lib/settings");
    await expect(
      writeSettings({ defaultReader: "gemini-3.6-flash", disabledProviders: ["google"] })
    ).rejects.toThrow(/change the default first/);
  });

  it("says where to set the reader when there is no store to write to", async () => {
    vi.resetModules();
    vi.stubEnv(URL_KEY, "");
    vi.stubEnv(TOK_KEY, "");
    const { writeSettings } = await import("../lib/settings");
    await expect(
      writeSettings({ defaultReader: "claude-opus-5", disabledProviders: [] })
    ).rejects.toThrow(/READER_MODEL/);
  });

  it("persists exactly what it was handed", async () => {
    vi.resetModules();
    const writes = stubStore(null);
    const { writeSettings } = await import("../lib/settings");
    await writeSettings({ defaultReader: "claude-opus-5", disabledProviders: ["openai"] });
    expect(JSON.parse(writes[0])).toEqual({
      defaultReader: "claude-opus-5",
      disabledProviders: ["openai"],
    });
  });
});

describe("which reader actually reads", () => {
  it("prefers the call, then the console, then READER_MODEL, then the built-in", async () => {
    vi.resetModules();
    stubStore(JSON.stringify({ defaultReader: "claude-opus-5", disabledProviders: [] }));
    vi.stubEnv("READER_MODEL", "gemini-3.6-flash");
    const { activeReader, readSettings } = await import("../lib/settings");
    const s = await readSettings();

    expect(await activeReader("gpt-5.6-sol", s)).toEqual({ model: "gpt-5.6-sol", source: "call" });
    expect(await activeReader(undefined, s)).toEqual({
      model: "claude-opus-5",
      source: "console",
    });
    // With no console default, the env wins.
    expect(await activeReader(undefined, { ...s, defaultReader: null })).toEqual({
      model: "gemini-3.6-flash",
      source: "env",
    });
  });

  it("blocks a caller from selecting a switched-off provider", async () => {
    vi.resetModules();
    stubStore(JSON.stringify({ defaultReader: null, disabledProviders: ["openai"] }));
    const { activeReader, readSettings } = await import("../lib/settings");
    const s = await readSettings();
    await expect(activeReader("gpt-5.6-terra", s)).rejects.toThrow(/openai is switched off/);
  });

  it("NEVER leaves brain_ask without a reader, whatever is switched off", async () => {
    // The load-bearing one. Every provider off, including the one serving the built-in default:
    // a console toggle reached from a phone must not be able to take the brain offline. The
    // last resort of the chain ignores the switches by design.
    vi.resetModules();
    stubStore(
      JSON.stringify({ defaultReader: null, disabledProviders: ["anthropic", "openai", "google"] })
    );
    const { activeReader, readSettings } = await import("../lib/settings");
    const s = await readSettings();
    const active = await activeReader(undefined, s);
    expect(active.model).toBe("claude-sonnet-5");
    expect(active.source).toBe("built-in");
  });

  it("steps over a console default whose provider was later switched off", async () => {
    // Not an error: the alternative is that flipping one switch makes every ask throw until
    // someone opens the console again.
    vi.resetModules();
    stubStore(JSON.stringify({ defaultReader: "gpt-5.6-sol", disabledProviders: ["openai"] }));
    const { activeReader, readSettings } = await import("../lib/settings");
    const s = await readSettings();
    expect(await activeReader(undefined, s)).toEqual({
      model: "claude-sonnet-5",
      source: "built-in",
    });
  });

  it("still fails loudly on a typo'd READER_MODEL", async () => {
    // Pre-existing behaviour, deliberately unchanged: a bad env var is a deployment error, and
    // a console toggle is not the place to paper over one.
    vi.resetModules();
    stubStore(JSON.stringify({ defaultReader: null, disabledProviders: [] }));
    vi.stubEnv("READER_MODEL", "claude-sonnet-5.5");
    const { activeReader, readSettings } = await import("../lib/settings");
    await expect(activeReader(undefined, await readSettings())).rejects.toThrow(/READER_MODEL/);
  });
});

describe("the console survives a reader it cannot resolve", () => {
  it("turns a typo'd READER_MODEL into a sentence instead of a thrown render", async () => {
    // The console is where you go to find out WHICH reader is broken. A screen that 500s
    // because the reader is misconfigured fails exactly when it is needed.
    vi.resetModules();
    stubStore(JSON.stringify({ defaultReader: null, disabledProviders: [] }));
    vi.stubEnv("READER_MODEL", "claude-sonnet-5.5");
    const { readSettings, safeActiveReader, readerCards } = await import("../lib/settings");
    const s = await readSettings();
    const { active, error } = await safeActiveReader(s);
    expect(active).toBeNull();
    expect(error).toMatch(/READER_MODEL/);
    // Every row still draws, and none of them claims to be the one reading.
    const cards = readerCards(s, active);
    expect(cards).toHaveLength(7);
    expect(cards.filter((c) => c.isDefault)).toHaveLength(0);
  });
});

describe("reader cards", () => {
  it("marks the live default and reports key presence without reading the key", async () => {
    vi.resetModules();
    stubStore(JSON.stringify({ defaultReader: "claude-opus-5", disabledProviders: ["google"] }));
    vi.stubEnv("ANTHROPIC_API_KEY", "sk-ant-secret-value");
    vi.stubEnv("OPENAI_API_KEY", "");
    const { readSettings, activeReader, readerCards } = await import("../lib/settings");
    const s = await readSettings();
    const cards = readerCards(s, await activeReader(undefined, s));

    const opus = cards.find((c) => c.model === "claude-opus-5")!;
    expect(opus).toMatchObject({ isDefault: true, configured: true, defaultSource: "console" });
    expect(cards.find((c) => c.model === "gpt-5.6-sol")!.configured).toBe(false);
    expect(cards.find((c) => c.model === "gemini-3.6-flash")!.disabled).toBe(true);
    // Exactly one default, and no card carries the credential itself anywhere.
    expect(cards.filter((c) => c.isDefault)).toHaveLength(1);
    expect(JSON.stringify(cards)).not.toContain("secret-value");
  });

  it("never calls an unmeasured reader measured", async () => {
    vi.resetModules();
    stubStore(null);
    const { readSettings, activeReader, readerCards } = await import("../lib/settings");
    const s = await readSettings();
    const cards = readerCards(s, await activeReader(undefined, s));
    for (const c of cards) {
      const claude = c.provider === "anthropic";
      // The honest-data rule, as an assertion: only the models actually run on the 185-label
      // eval may carry a measured state, and Haiku's variance is its own state, not a footnote.
      if (!claude) expect(c.eval.state).toBe("unmeasured");
      if (c.model === "claude-haiku-4-5") expect(c.eval.state).toBe("unstable");
      if (c.model === "claude-sonnet-5") expect(c.eval.state).toBe("measured");
    }
  });
});
