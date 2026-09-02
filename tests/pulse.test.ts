import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../lib/github", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/github")>()),
  gh: vi.fn(),
}));

import { gh } from "../lib/github";
import { parseExactCount, mirrorPulse, accessPulse } from "../lib/pulse";
import { __setBubbleStore } from "../lib/bubble";

const mGh = vi.mocked(gh);

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv("SUPABASE_URL", "https://x.supabase.co");
  vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "k");
  vi.stubEnv("BRAIN_REPO", "owner/brain");
  vi.stubEnv("GITHUB_TOKEN", "t");
});

afterEach(() => {
  __setBubbleStore(undefined);
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("parseExactCount — the header the counts hang on", () => {
  it.each([
    ["0-0/123", 123],
    ["*/0", 0],
    ["0-999/1000", 1000],
  ])("parses %s as %d", (h, n) => {
    expect(parseExactCount(h)).toBe(n);
  });

  // "*/*" is PostgREST declining to count; a missing header is a proxy stripping it. Both must
  // be null — a number that looks real but is not would put a lie in the hero.
  it.each([["*/*"], [""], ["garbage"], ["0-0/NaN"]])("refuses %s", (h) => {
    expect(parseExactCount(h || null)).toBeNull();
  });

  it("refuses a missing header outright", () => {
    expect(parseExactCount(null)).toBeNull();
  });
});

function fetchStub(routes: Array<[RegExp, () => Response | Promise<Response>]>) {
  return vi.fn(async (url: RequestInfo | URL) => {
    const u = String(url);
    for (const [re, make] of routes) if (re.test(u)) return make();
    throw new Error(`unexpected fetch: ${u}`);
  });
}

const countRes = (total: string) =>
  ({ ok: true, headers: new Headers({ "content-range": `0-0/${total}` }), json: async () => [] }) as unknown as Response;
const jsonRes = (body: unknown) =>
  ({ ok: true, headers: new Headers(), json: async () => body }) as unknown as Response;

describe("mirrorPulse", () => {
  it("is 'off' with no env — a mode, not an error", async () => {
    vi.stubEnv("SUPABASE_URL", "");
    expect(await mirrorPulse()).toMatchObject({ state: "off" });
  });

  it("derives 'live' only when the mirror head EQUALS the git head", async () => {
    mGh.mockResolvedValue(jsonRes({ sha: "abc" }));
    vi.stubGlobal("fetch", fetchStub([
      [/sync_state/, () => jsonRes([{ head_sha: "abc", synced_at: "2026-08-06T16:00:00Z" }])],
      [/notes\?select=path/, () => countRes("85")],
    ]));
    const p = await mirrorPulse();
    expect(p).toMatchObject({ state: "live", gitHead: "abc", mirrorHead: "abc", notes: 85 });
  });

  it("derives 'healing' when behind, and for a never-synced mirror (null head)", async () => {
    mGh.mockResolvedValue(jsonRes({ sha: "new" }));
    vi.stubGlobal("fetch", fetchStub([
      [/sync_state/, () => jsonRes([])],
      [/notes\?select=path/, () => countRes("0")],
    ]));
    const p = await mirrorPulse();
    expect(p).toMatchObject({ state: "healing", mirrorHead: null });
  });

  it("fails soft to null when GitHub hangs — the page renders without the card", async () => {
    // AbortSignal.timeout fires; the promise rejects like a real abort would.
    mGh.mockRejectedValue(Object.assign(new Error("aborted"), { name: "TimeoutError" }));
    vi.stubGlobal("fetch", fetchStub([
      [/sync_state/, () => jsonRes([])],
      [/notes\?select=path/, () => countRes("0")],
    ]));
    expect(await mirrorPulse()).toBeNull();
  });

  it("passes a timeout signal to the GitHub call — a hung socket must not outlive the budget", async () => {
    mGh.mockResolvedValue(jsonRes({ sha: "abc" }));
    vi.stubGlobal("fetch", fetchStub([
      [/sync_state/, () => jsonRes([{ head_sha: "abc", synced_at: "x" }])],
      [/notes\?select=path/, () => countRes("1")],
    ]));
    await mirrorPulse();
    const init = mGh.mock.calls[0][1] as RequestInit | undefined;
    expect(init?.signal).toBeInstanceOf(AbortSignal);
  });

  it("survives a count the store declines — notes is null, never NaN", async () => {
    mGh.mockResolvedValue(jsonRes({ sha: "abc" }));
    vi.stubGlobal("fetch", fetchStub([
      [/sync_state/, () => jsonRes([{ head_sha: "abc", synced_at: "x" }])],
      [/notes\?select=path/, () => ({ ok: true, headers: new Headers({ "content-range": "*/*" }), json: async () => [] }) as unknown as Response],
    ]));
    const p = await mirrorPulse();
    expect(p?.notes).toBeNull();
    expect(Number.isNaN(p?.notes)).toBe(false);
  });
});

describe("exactCount request shape", () => {
  // Deleting the Prefer header once left all tests green while every count silently became
  // null in production shape — the request contract is part of the contract.
  it("sends Prefer: count=exact on HEAD, and excludes sidecars from the notes count", async () => {
    mGh.mockResolvedValue(jsonRes({ sha: "abc" }));
    const inits: Array<{ url: string; init?: RequestInit }> = [];
    vi.stubGlobal("fetch", vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      inits.push({ url: String(url), init });
      if (String(url).includes("sync_state")) return jsonRes([{ head_sha: "abc", synced_at: "x" }]);
      return countRes("85");
    }));
    await mirrorPulse();
    const countCall = inits.find((c) => c.url.includes("notes?select=path"))!;
    expect(countCall.init?.method).toBe("HEAD");
    expect((countCall.init?.headers as Record<string, string>).Prefer).toContain("count=exact");
    // A mirror row-count that includes the sidecar is not a count of NOTES — it made this card
    // disagree with the hero by exactly one, unexplainably from the screen.
    expect(countCall.url).toContain("not.in.");
    expect(decodeURIComponent(countCall.url)).toContain("atlas-snapshot");
  });
});

describe("accessPulse", () => {
  const NOW = Date.parse("2026-08-06T17:00:00Z");

  it("splits the rolling windows at exactly now-24h, exact counts from headers", async () => {
    const urls: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: RequestInfo | URL) => {
      const u = String(url);
      urls.push(u);
      if (u.includes("select=id") && !u.includes("lt.")) return countRes("1200");
      if (u.includes("select=id") && u.includes("lt.")) return countRes("800");
      if (u.includes("order=at.asc")) return jsonRes([{ at: "2026-08-05T20:00:00Z" }]);
      return jsonRes([{ path: "notes/a.md", tool: "brain_ask" }, { path: "notes/a.md", tool: "brain_read" }]);
    }));
    const p = await accessPulse(NOW);
    // The counts come from headers, so 1200 is 1200 even though the row page is capped — the
    // bug this suite pins: a capped SELECT once rendered 1200+800 as "1000 today, +1000".
    expect(p).toMatchObject({ last24h: 1200, prior24h: 800, firstAt: "2026-08-05T20:00:00Z" });
    const dayAgo = encodeURIComponent(new Date(NOW - 86_400_000).toISOString());
    const twoDaysAgo = encodeURIComponent(new Date(NOW - 172_800_000).toISOString());
    expect(urls.some((u) => u.includes(`gte.${dayAgo}`) && !u.includes("lt."))).toBe(true);
    expect(urls.some((u) => u.includes(`gte.${twoDaysAgo}`) && u.includes(`lt.${dayAgo}`))).toBe(true);
  });

  it("reports the basis its breakdowns are computed from, so a sample can say it is one", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: RequestInfo | URL) => {
      const u = String(url);
      if (u.includes("select=id") && !u.includes("lt.")) return countRes("1500");
      if (u.includes("select=id") && u.includes("lt.")) return countRes("0");
      if (u.includes("order=at.asc")) return jsonRes([]);
      return jsonRes(Array.from({ length: 1000 }, () => ({ path: "notes/a.md", tool: "brain_ask" })));
    }));
    const p = await accessPulse(NOW);
    expect(p?.basis).toBe(1000);
    expect(p?.last24h).toBe(1500); // exact despite the capped page
  });

  it("aggregates byTool and topNotes from the page", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: RequestInfo | URL) => {
      const u = String(url);
      if (u.includes("select=id")) return countRes(u.includes("lt.") ? "1" : "3");
      if (u.includes("order=at.asc")) return jsonRes([{ at: "2026-08-05T20:00:00Z" }]);
      return jsonRes([
        { path: "notes/a.md", tool: "brain_ask" },
        { path: "notes/a.md", tool: "brain_ask" },
        { path: "notes/b.md", tool: "brain_read" },
      ]);
    }));
    const p = await accessPulse(NOW);
    expect(p?.byTool[0]).toEqual({ tool: "brain_ask", n: 2 });
    expect(p?.topNotes[0]).toEqual({ path: "notes/a.md", n: 2 });
  });

  it("fails soft to null when any count is refused — a partial pulse would lie", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: RequestInfo | URL) => {
      const u = String(url);
      if (u.includes("select=id") && !u.includes("lt.")) return countRes("5");
      if (u.includes("select=id") && u.includes("lt.")) return ({ ok: false, status: 500, headers: new Headers() }) as unknown as Response;
      if (u.includes("order=at.asc")) return jsonRes([]);
      return jsonRes([]);
    }));
    expect(await accessPulse(NOW)).toBeNull();
  });
});
