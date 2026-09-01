import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The Learning section's action endpoint — clear the answer cache, rebuild the graph. Same
 * gate as every console write; what these tests hold beyond the gate is the HONESTY of the
 * outcomes: a clear reports the real count, and a rebuild's refusal states arrive as sentences
 * rather than as success with nothing behind it.
 */

const anscache = vi.hoisted(() => ({ clearAnswerCache: vi.fn() }));
vi.mock("../lib/anscache", () => anscache);

const corpus = vi.hoisted(() => ({ loadCorpus: vi.fn() }));
vi.mock("../lib/corpus", () => corpus);

const edges = vi.hoisted(() => ({ rebuildEdges: vi.fn() }));
vi.mock("../lib/edges", () => edges);

import { POST } from "../app/s/[secret]/console/settings/actions/route";
import { STAMP_COOKIE, stampValue } from "../lib/stamp";

const SECRET = "a".repeat(64);

function call(
  body: unknown,
  { secret = SECRET, origin = "https://cortex.test" }: { secret?: string; origin?: string | null } = {}
) {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (origin) headers.origin = origin;
  headers.cookie = `${STAMP_COOKIE}=${stampValue()}`;
  const req = new Request(`https://cortex.test/s/${secret}/console/settings/actions`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
  return POST(req, { params: Promise.resolve({ secret }) });
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv("CONNECTOR_PATH_SECRET", SECRET);
  vi.stubEnv("CONSOLE_PASSCODE", "actions-suite passcode");
  corpus.loadCorpus.mockResolvedValue({ sha: "eaf0a03e4849aaaa", files: new Map() });
});

describe("the actions endpoint", () => {
  it("is gated like the save endpoint — wrong secret 404s, cross-origin refuses", async () => {
    expect((await call({ action: "clear-answer-cache" }, { secret: "b".repeat(64) })).status).toBe(404);
    expect((await call({ action: "clear-answer-cache" }, { origin: "https://evil.test" })).status).toBe(403);
    expect(anscache.clearAnswerCache).not.toHaveBeenCalled();
  });

  it("refuses an unknown action by name", async () => {
    const res = await call({ action: "drop-tables" });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/drop-tables/);
  });

  it("clear reports the count actually deleted", async () => {
    anscache.clearAnswerCache.mockResolvedValue(4);
    const res = await call({ action: "clear-answer-cache" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, cleared: 4 });
  });

  it("a clear that could not run is a failure, not 'cleared 0'", async () => {
    anscache.clearAnswerCache.mockRejectedValue(new Error("no KV store is configured — there is no answer cache to clear"));
    const res = await call({ action: "clear-answer-cache" });
    expect(res.status).toBe(503);
    expect((await res.json()).error).toMatch(/no KV store/);
  });

  it("rebuild forces a full replace at the mirror head and returns the refreshed stamp", async () => {
    edges.rebuildEdges.mockResolvedValue({ state: "rebuilt", head: "eaf0a03e4849aaaa", derived: 321 });
    const res = await call({ action: "rebuild-graph" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, state: "rebuilt", head: "eaf0a03e4849aaaa", derived: 321 });
    // force, because the button's promise is a rebuild — not the scheduler's skip-when-current.
    expect(edges.rebuildEdges).toHaveBeenCalledWith(expect.any(Map), "eaf0a03e4849aaaa", { force: true });
  });

  it("surfaces the RPC's stale-head refusal honestly", async () => {
    edges.rebuildEdges.mockResolvedValue({ state: "stale-head", head: "eaf0a03e4849aaaa" });
    const res = await call({ action: "rebuild-graph" });
    expect(res.status).toBe(409);
    expect((await res.json()).error).toMatch(/refused whole/);
  });

  it("names the unmigrated and unconfigured states instead of pretending", async () => {
    edges.rebuildEdges.mockResolvedValue({ state: "missing" });
    expect((await (await call({ action: "rebuild-graph" })).json()).error).toMatch(/migrate/);
    edges.rebuildEdges.mockResolvedValue({ state: "off" });
    expect((await (await call({ action: "rebuild-graph" })).json()).error).toMatch(/SUPABASE_URL/);
  });

  it("a store that throws mid-rebuild reads as a failure sentence, not a 500 page", async () => {
    edges.rebuildEdges.mockRejectedValue(new Error("edges: POST edges_rebuild 500"));
    const res = await call({ action: "rebuild-graph" });
    expect(res.status).toBe(502);
    expect((await res.json()).error).toMatch(/edges_rebuild/);
  });
});
