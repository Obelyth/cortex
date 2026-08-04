import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ask, render } from "../lib/ask";
import { __setCache } from "../lib/corpus";
import type { Corpus } from "../lib/corpus";

/**
 * Scope, budget and citation policy. The rule the whole file defends: a guest receives
 * CONCLUSIONS, never material — and every default lands on the locked-down side, because a
 * policy object that fails open turns a store blip into full corpus access.
 */

const URL_KEY = "KV_REST_API_URL";
const TOK_KEY = "KV_REST_API_TOKEN";

const corpus: Corpus = {
  sha: "abc123abc123abcd",
  bytes: 400,
  fetchedAt: Date.now(),
  sidecar: new Map(),
  files: new Map([
    ["projects/grain.md", "Grain production is dark; both URLs return 404 as of 2026-07-25."],
    ["profile.md", "the operator's home address is 12 Made Up Lane and his bank is Fictional Credit Union."],
    ["notes/private.md", "The spare key is under the third plant pot on the left."],
    ["log/2026-08-03.md", "09:20 — argued with the landlord about the lease."],
  ]),
};

function tagOf(prompt: string, path: string): string {
  const esc = path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return prompt.match(new RegExp(`FILE: ${esc} \\[tag: ([0-9a-z]+)\\]`))?.[1] ?? "";
}

// The corpus is served from the cache, with the head lookup mocked — same harness as ask.test.ts,
// so these tests exercise the real ask() pipeline without reaching the network.
let restore: typeof globalThis.fetch;
beforeEach(() => {
  process.env.BRAIN_REPO = "ShootJackal/brain";
  process.env.GITHUB_TOKEN = "test";
  restore = globalThis.fetch;
  globalThis.fetch = (async (url: string) => {
    if (String(url).includes("/commits/")) {
      return new Response(JSON.stringify({ sha: corpus.sha }), { status: 200 });
    }
    throw new Error("tarball must not be refetched when the sha is unchanged");
  }) as typeof fetch;
  __setCache(corpus);
});

afterEach(() => {
  globalThis.fetch = restore;
  vi.unstubAllEnvs();
  vi.doUnmock("@upstash/redis");
  vi.resetModules();
});

describe("scope removes notes before the reader ever sees them", () => {
  it("packs only in-scope files, so a private sentence is never available to quote", async () => {
    let seen = "";
    await ask(
      "what is the operator's address",
      async (prompt) => {
        seen = prompt;
        return JSON.stringify({ answer: "NOT IN BRAIN", tag: "", quote: "" });
      },
      { scope: ["projects/"], k: 40 }
    );
    expect(seen).toContain("FILE: projects/grain.md");
    // The point of filtering BEFORE rather than after: these strings never entered the prompt,
    // so no amount of persuasion in the question can produce them.
    expect(seen).not.toContain("profile.md");
    expect(seen).not.toContain("Made Up Lane");
    expect(seen).not.toContain("spare key");
    expect(seen).not.toContain("the landlord");
  });

  it("cannot verify a citation to an out-of-scope note even if the reader names one", async () => {
    // A reader that somehow knew profile.md exists still has no tag for it, so there is nothing
    // to attribute and the answer degrades to an honest absence rather than a leak.
    const r = await ask(
      "where does the operator live",
      async () => JSON.stringify({ answer: "12 Made Up Lane", tag: "deadbeef", quote: "Made Up Lane" }),
      { scope: ["projects/"] }
    );
    expect(r.citation).toBeNull();
    expect(r.unresolvedTag).toBe(true);
    expect(render(r)).toMatch(/^UNVERIFIED/);
  });

  it("an unscoped ask still sees everything — the trusted doors are unchanged", async () => {
    let seen = "";
    await ask(
      "anything",
      async (p) => {
        seen = p;
        return JSON.stringify({ answer: "x", tag: "", quote: "" });
      },
      { k: 40 }
    );
    expect(seen).toContain("FILE: profile.md");
  });
});

describe("what a guest is told about the answer", () => {
  const cite = (path: string, quote: string) => async (prompt: string) =>
    JSON.stringify({ answer: "Production is dark.", tag: tagOf(prompt, path), quote });

  it("returns the verdict without the path or the verbatim evidence", async () => {
    const r = await ask("is grain live", cite("projects/grain.md", "Grain production is dark"), {
      scope: ["projects/"],
    });
    const bare = render(r, { citations: false });
    expect(bare).toMatch(/^VERIFIED/);
    // It learns the answer was proven — the part that matters to it.
    expect(bare).toContain("verified against the brain at commit");
    // It does not learn the brain's shape, nor get a verbatim excerpt on every answer.
    expect(bare).not.toContain("projects/grain.md");
    expect(bare).not.toContain("source:");
    expect(bare).not.toContain("evidence:");
    expect(bare).not.toContain("Grain production is dark;");
  });

  it("still distinguishes absence, unproven and retracted, because those change the answer's worth", async () => {
    const notFound = await ask("what is the bill", async () =>
      JSON.stringify({ answer: "NOT IN BRAIN", tag: "", quote: "" })
    );
    expect(render(notFound, { citations: false })).toMatch(/^NOT IN BRAIN/);

    const fabricated = await ask(
      "is grain live",
      cite("projects/grain.md", "Grain shipped and is fully live"),
      { scope: ["projects/"] }
    );
    const bare = render(fabricated, { citations: false });
    expect(bare).toMatch(/^UNVERIFIED/);
    expect(bare).toMatch(/unproven/);
  });

  it("full citations still come back on the trusted path", async () => {
    const r = await ask("is grain live", cite("projects/grain.md", "Grain production is dark"));
    expect(render(r)).toContain("projects/grain.md");
    expect(render(r)).toContain("evidence:");
  });
});

describe("the policy fails closed", () => {
  async function policy() {
    return (await import("../lib/guest")).readGuestPolicy();
  }

  it("locks down when there is no store", async () => {
    vi.resetModules();
    vi.stubEnv(URL_KEY, "");
    vi.stubEnv(TOK_KEY, "");
    const p = await policy();
    expect(p.source).toBe("unconfigured");
    expect(p.scope).toEqual(["projects/"]);
    expect(p.citations).toBe(false);
  });

  it("locks down when the store is unreachable, rather than dropping the restriction", async () => {
    vi.resetModules();
    vi.doMock("@upstash/redis", () => ({
      Redis: class {
        get() {
          return Promise.reject(new Error("down"));
        }
      },
    }));
    vi.stubEnv(URL_KEY, "https://example.upstash.io");
    vi.stubEnv(TOK_KEY, "t");
    const p = await policy();
    expect(p.source).toBe("unreachable");
    // The failure that must never happen: a blip reading as "no restrictions".
    expect(p.scope).toEqual(["projects/"]);
    expect(p.citations).toBe(false);
  });

  it("ignores a stored scope that parses to nothing instead of treating it as everything", async () => {
    vi.resetModules();
    vi.doMock("@upstash/redis", () => ({
      Redis: class {
        get(k: string) {
          return Promise.resolve(
            k.includes("asks")
              ? 0
              : JSON.stringify({ scope: ["../../etc", "", 42, "nope/"], citations: true })
          );
        }
      },
    }));
    vi.stubEnv(URL_KEY, "https://example.upstash.io");
    vi.stubEnv(TOK_KEY, "t");
    const p = await policy();
    expect(p.scope).toEqual(["projects/"]);
  });

  it("refuses to store an empty scope", async () => {
    vi.resetModules();
    vi.doMock("@upstash/redis", () => ({ Redis: class { set() { return Promise.resolve("OK"); } } }));
    vi.stubEnv(URL_KEY, "https://example.upstash.io");
    vi.stubEnv(TOK_KEY, "t");
    const { writeGuestPolicy } = await import("../lib/guest");
    // Empty reads as "no restriction" everywhere it is used, so it must not be expressible.
    await expect(
      writeGuestPolicy({ scope: [], citations: false, dailyAsks: 10, maxK: 5 })
    ).rejects.toThrow(/cannot be empty/);
    await expect(
      writeGuestPolicy({ scope: ["../secrets"], citations: false, dailyAsks: 10, maxK: 5 })
    ).rejects.toThrow(/not a valid scope path/);
  });
});

describe("the daily budget", () => {
  function counter(start: number) {
    let n = start;
    vi.doMock("@upstash/redis", () => ({
      Redis: class {
        incr() {
          return Promise.resolve(++n);
        }
        expire() {
          return Promise.resolve(1);
        }
      },
    }));
    vi.stubEnv(URL_KEY, "https://example.upstash.io");
    vi.stubEnv(TOK_KEY, "t");
  }

  const pol = { scope: ["projects/"], citations: false, dailyAsks: 3, maxK: 8 };

  it("allows up to the ceiling and refuses past it", async () => {
    vi.resetModules();
    counter(0);
    const { spendGuestAsk } = await import("../lib/guest");
    await expect(spendGuestAsk(pol)).resolves.toBeUndefined();
    await expect(spendGuestAsk(pol)).resolves.toBeUndefined();
    await expect(spendGuestAsk(pol)).resolves.toBeUndefined();
    await expect(spendGuestAsk(pol)).rejects.toThrow(/daily limit of 3 asks is spent/);
  });

  it("increments before comparing, so two concurrent guests cannot both pass the last slot", async () => {
    vi.resetModules();
    counter(2);
    const { spendGuestAsk } = await import("../lib/guest");
    const [a, b] = await Promise.allSettled([spendGuestAsk(pol), spendGuestAsk(pol)]);
    // One takes the third slot, the other is refused. Read-then-compare would have let both through.
    expect([a.status, b.status].sort()).toEqual(["fulfilled", "rejected"]);
  });

  it("refuses to run unmetered when there is no store", async () => {
    vi.resetModules();
    vi.stubEnv(URL_KEY, "");
    vi.stubEnv(TOK_KEY, "");
    const { spendGuestAsk } = await import("../lib/guest");
    await expect(spendGuestAsk(pol)).rejects.toThrow(/needs a KV store to meter/);
  });
});

describe("Claude holds the gate whatever the operator's own default is", () => {
  it("answers a guest with a Claude reader even when the console default is not one", async () => {
    const { guestReaderModel } = await import("../lib/guest");
    const state = { disabledProviders: [], source: "store" as const, conflicts: [] };
    expect(guestReaderModel({ ...state, defaultReader: "gpt-5.6-terra" })).toBe("claude-sonnet-5");
    expect(guestReaderModel({ ...state, defaultReader: "gemini-3.6-flash" })).toBe("claude-sonnet-5");
    expect(guestReaderModel({ ...state, defaultReader: null })).toBe("claude-sonnet-5");
    // A Claude default IS honoured — the rule is "always Claude", not "always sonnet".
    expect(guestReaderModel({ ...state, defaultReader: "claude-opus-5" })).toBe("claude-opus-5");
  });
});
