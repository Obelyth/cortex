import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The heat view's two endpoints hold the same line settings/save established: route handlers
 * under the secret path (never server actions), wrong secret answered with the empty 404,
 * cross-origin refused, and — for the pin — a store that is not there named as the reason
 * nothing was written.
 */

vi.mock("../lib/github", () => ({
  getFile: vi.fn(),
  putFile: vi.fn(),
  listTree: vi.fn(),
  gh: vi.fn(async () => ({ ok: true, json: async () => ({ sha: "deadbeefcafe0000" }) })),
  repo: () => "owner/brain",
  branch: () => "main",
}));

import { __setCache } from "../lib/corpus";
import { __setBubbleStore } from "../lib/bubble";
import { __setStore } from "../lib/mirror";
import { __setPinStore, type PinStore } from "../lib/pins";
import { POST as pinPost } from "../app/s/[secret]/console/heat/pin/route";
import { POST as handoffPost } from "../app/s/[secret]/console/heat/handoff/route";
import { STAMP_COOKIE, stampValue } from "../lib/stamp";

const SECRET = "a".repeat(64);

function call(
  handler: typeof pinPost,
  body: unknown,
  { secret = SECRET, origin = "https://cortex.test" }: { secret?: string; origin?: string | null } = {}
) {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (origin) headers.origin = origin;
  headers.cookie = `${STAMP_COOKIE}=${stampValue()}`;
  const req = new Request(`https://cortex.test/s/${secret}/console/heat/x`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
  return handler(req, { params: Promise.resolve({ secret }) });
}

function fakePins(): PinStore & { sets: unknown[][]; clears: string[] } {
  const sets: unknown[][] = [];
  const clears: string[] = [];
  return {
    sets,
    clears,
    all: async () => [],
    set: async (path, temperature, reason) => {
      sets.push([path, temperature, reason]);
    },
    clear: async (path) => {
      clears.push(path);
    },
  };
}

beforeEach(() => {
  vi.stubEnv("CONNECTOR_PATH_SECRET", SECRET);
  vi.stubEnv("CONSOLE_PASSCODE", "heat-suite passcode");
  __setCache(null);
  __setBubbleStore(null);
  __setStore(null);
  __setPinStore(null);
});

afterEach(() => {
  __setCache(null);
  __setBubbleStore(undefined);
  __setStore(undefined);
  __setPinStore(undefined);
  vi.unstubAllEnvs();
});

describe("the pin endpoint", () => {
  it("404s a wrong-secret pin without touching the store — the same empty 404 as every gate", async () => {
    const store = fakePins();
    __setPinStore(store);
    const res = await call(pinPost, { path: "notes/a.md", pin: { temperature: "hot" } }, { secret: "b".repeat(64) });
    expect(res.status).toBe(404);
    expect(await res.text()).toBe("");
    expect(store.sets).toHaveLength(0);
  });

  it("refuses a cross-origin pin", async () => {
    const store = fakePins();
    __setPinStore(store);
    const res = await call(pinPost, { path: "notes/a.md", pin: { temperature: "hot" } }, { origin: "https://evil.test" });
    expect(res.status).toBe(403);
    expect(store.sets).toHaveLength(0);
  });

  it("round-trips a pin and an unpin through the store", async () => {
    const store = fakePins();
    __setPinStore(store);

    const pinRes = await call(pinPost, { path: "notes/a.md", pin: { temperature: "hot", reason: "keep" } });
    expect(pinRes.status).toBe(200);
    expect(await pinRes.json()).toEqual({ ok: true, path: "notes/a.md", pin: { temperature: "hot", reason: "keep" } });
    expect(store.sets).toEqual([["notes/a.md", "hot", "keep"]]);

    const unpinRes = await call(pinPost, { path: "notes/a.md", pin: null });
    expect(unpinRes.status).toBe(200);
    expect(await unpinRes.json()).toEqual({ ok: true, path: "notes/a.md", pin: null });
    expect(store.clears).toEqual(["notes/a.md"]);
  });

  it.each([
    ["archive/old.md", "archive is never mirrored, so a pin there would score nothing"],
    ["../etc/passwd", "traversal shape"],
    ["INDEX.md", "generated, not a note"],
    ["projects/x.txt", "not markdown"],
  ])("refuses %s (%s)", async (path) => {
    const store = fakePins();
    __setPinStore(store);
    const res = await call(pinPost, { path, pin: { temperature: "hot" } });
    expect(res.status).toBe(400);
    expect(store.sets).toHaveLength(0);
  });

  it("refuses a temperature note_pins would not accept", async () => {
    const store = fakePins();
    __setPinStore(store);
    const res = await call(pinPost, { path: "notes/a.md", pin: { temperature: "tepid" } });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toContain("hot, warm, cold");
  });

  it("503s with the named reason when no store exists — nothing pretends to save", async () => {
    __setPinStore(null);
    const res = await call(pinPost, { path: "notes/a.md", pin: { temperature: "hot" } });
    expect(res.status).toBe(503);
    expect(((await res.json()) as { error: string }).error).toContain("SUPABASE_URL");
  });

  it("names the consequence when the store refuses mid-write", async () => {
    const store = fakePins();
    store.set = async () => {
      throw new Error("pins: POST note_pins 500");
    };
    __setPinStore(store);
    const res = await call(pinPost, { path: "notes/a.md", pin: { temperature: "hot" } });
    expect(res.status).toBe(502);
    expect(((await res.json()) as { error: string }).error).toContain("previous state");
  });
});

describe("the handoff staging endpoint", () => {
  function seed() {
    __setCache({
      files: new Map(
        Object.entries({
          "projects/harbor.md": "# Harbor\n\nthe page",
          "log/2026-08-10.md": "# Log\n\n## 09:00 · harbor\n\nmoved the buoys",
        })
      ),
      sidecar: new Map(),
      sha: "deadbeefcafe0000",
      bytes: 0,
      fetchedAt: Date.now(),
    });
  }

  it("404s a wrong secret with the empty body", async () => {
    seed();
    const res = await call(handoffPost, { project: "harbor" }, { secret: "b".repeat(64) });
    expect(res.status).toBe(404);
    expect(await res.text()).toBe("");
  });

  it("stages a real project: coverage verbatim, pieces with fates", async () => {
    seed();
    const res = await call(handoffPost, { project: "harbor" });
    expect(res.status).toBe(200);
    const view = (await res.json()) as {
      coverage: string;
      pieces: Array<{ kind: string; included: boolean }>;
    };
    expect(view.coverage).toMatch(/^handoff · harbor @deadbeefcafe/);
    expect(view.pieces.find((p) => p.kind === "page")!.included).toBe(true);
  });

  it("answers an unknown project with the honest miss, closest names attached", async () => {
    seed();
    const res = await call(handoffPost, { project: "harbour-north" });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toContain("closest: harbor");
  });

  it("demands a project", async () => {
    seed();
    const res = await call(handoffPost, {});
    expect(res.status).toBe(400);
  });
});
