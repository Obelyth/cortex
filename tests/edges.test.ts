import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  resolveRef,
  linkEdges,
  tagEdges,
  lexicalEdges,
  correctionEdges,
  deriveEdges,
  groupEdges,
  rebuildEdges,
  scheduleEdgeRebuild,
  edgesPulse,
  MAX_EVIDENCE,
  LEXICAL_K,
  PANEL_TOP_K,
  type EdgeRow,
} from "../lib/edges";

/** A corpus in a line. Keys are live paths — the builder trusts corpus.ts's isLive filter. */
const corpus = (entries: Record<string, string>) => new Map(Object.entries(entries));

beforeEach(() => {
  vi.stubEnv("SUPABASE_URL", "https://x.supabase.co");
  vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "k");
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("resolveRef — [[slug]] resolution", () => {
  const files = corpus({
    "notes/harbor-tuning-results.md": "",
    "notes/kiln-firing.md": "",
    "projects/harbor.md": "",
    "log/2026-08-01.md": "",
  });

  it.each([
    ["notes/kiln-firing.md", "notes/kiln-firing.md"], // exact path
    ["notes/kiln-firing", "notes/kiln-firing.md"], // path minus .md — live in the corpus today
    ["harbor-tuning-results", "notes/harbor-tuning-results.md"], // bare basename — the house norm
    ["harbor", "projects/harbor.md"],
    ["Harbor", "projects/harbor.md"], // hand-written refs vary in case; the note does not
  ])("resolves [[%s]] to %s", (ref, path) => {
    expect(resolveRef(ref, files)).toBe(path);
  });

  it("resolves an AMBIGUOUS basename to nothing — a guessed edge is a lie with evidence attached", () => {
    const two = corpus({ "notes/setup.md": "", "projects/setup.md": "" });
    expect(resolveRef("setup", two)).toBeNull();
  });

  it("resolves an unknown ref and an empty ref to nothing", () => {
    expect(resolveRef("never-written-down", files)).toBeNull();
    expect(resolveRef("  ", files)).toBeNull();
  });
});

describe("linkEdges", () => {
  it("derives one directed edge per (src, dst) with weight = reference count and line-ref evidence", () => {
    const files = corpus({
      "projects/harbor.md": "line one\nSee [[soundings]] for numbers.\nAnd [[soundings]] again, plus [[nothing-real]].",
      "notes/soundings.md": "the numbers",
    });
    const edges = linkEdges(files);
    expect(edges).toHaveLength(1);
    expect(edges[0]).toMatchObject({ src: "projects/harbor.md", dst: "notes/soundings.md", kind: "link", weight: 2 });
    // Evidence names the first referencing line and counts the rest — a weight of 2 must never
    // render as a single quote pretending to be the whole story.
    expect(edges[0].evidence).toContain("L2:");
    expect(edges[0].evidence).toContain("+1 more");
    expect(edges[0].evidence).toContain("L3");
  });

  it("never links a note to itself, and an unresolved [[ref]] produces no edge at all", () => {
    const files = corpus({ "notes/a.md": "[[a]] refers to me; [[ghost]] to nobody." });
    expect(linkEdges(files)).toHaveLength(0);
  });
});

describe("tagEdges", () => {
  const fm = (tags: string) => `---\ntags: [${tags}]\n---\n\nbody`;

  it("weights by overlap count, stores once with src < dst, and names the shared tags", () => {
    const files = corpus({
      "notes/b.md": fm("swift, ble, gopro"),
      "notes/a.md": fm("swift, ble, python"),
      "notes/c.md": fm("sql"),
    });
    const edges = tagEdges(files);
    expect(edges).toHaveLength(1);
    expect(edges[0]).toMatchObject({ src: "notes/a.md", dst: "notes/b.md", kind: "tag", weight: 2 });
    expect(edges[0].evidence).toBe("2 shared frontmatter tags: ble, swift");
  });

  it("produces nothing for untagged notes — most of the corpus, and that is a fact not a failure", () => {
    expect(tagEdges(corpus({ "notes/a.md": "no frontmatter", "notes/b.md": "none here either" }))).toHaveLength(0);
  });
});

describe("correctionEdges", () => {
  it("derives an edge from a SUPERSEDED banner naming another live note", () => {
    const files = corpus({
      "notes/orchard-history.md": "intro\n\n> **SUPERSEDED 2026-07-25 — production is dark. See projects/orchard.md.**\n\nrest",
      "projects/orchard.md": "the current story",
    });
    const edges = correctionEdges(files);
    expect(edges).toHaveLength(1);
    expect(edges[0]).toMatchObject({ src: "notes/orchard-history.md", dst: "projects/orchard.md", kind: "correction", weight: 1 });
    expect(edges[0].evidence).toMatch(/^L3: /);
    expect(edges[0].evidence).toContain("SUPERSEDED");
  });

  it("derives an edge from a (was:) correction naming another note", () => {
    const files = corpus({
      "projects/harbor.md": 'The relay lives in notes/relay.md now (was: "it lived in the beacon project").',
      "notes/relay.md": "relay details",
    });
    expect(correctionEdges(files)).toHaveLength(1);
  });

  it("refuses a target outside the live corpus, and prose without a marker", () => {
    const files = corpus({
      "notes/a.md": "> **SUPERSEDED — see archive/old/dead.md**\n\nAlso projects/gone.md is mentioned plainly here.",
    });
    expect(correctionEdges(files)).toHaveLength(0);
  });
});

describe("lexicalEdges", () => {
  const files = corpus({
    "notes/a.md": "zebra quantum flotilla shares rare words with b",
    "notes/b.md": "zebra quantum flotilla appears here too, rare words",
    "notes/c.md": "entirely disjoint vocabulary about sourdough baking",
    "notes/d.md": "sourdough baking notes, entirely about starters",
  });

  it("is deterministic — two runs on one corpus produce byte-identical edges", () => {
    expect(lexicalEdges(files)).toEqual(lexicalEdges(files));
  });

  it("keeps at most k neighbours per note, never itself, and states score scope in the evidence", () => {
    const edges = lexicalEdges(files, 2);
    for (const e of edges) expect(e.src).not.toBe(e.dst);
    const bySrc = new Map<string, number>();
    for (const e of edges) bySrc.set(e.src, (bySrc.get(e.src) ?? 0) + 1);
    for (const n of bySrc.values()) expect(n).toBeLessThanOrEqual(2);
    // The evidence names the unit (bm25), the scope (the corpus size) and the matched terms —
    // a bare similarity number would be the first unprovable claim in the system.
    const ab = edges.find((e) => e.src === "notes/a.md" && e.dst === "notes/b.md")!;
    expect(ab.evidence).toContain("bm25");
    expect(ab.evidence).toContain("4-note corpus");
    expect(ab.evidence).toMatch(/flotilla|quantum|zebra/);
  });

  it("defaults to the spec's top-5", () => {
    expect(LEXICAL_K).toBe(5);
  });
});

describe("deriveEdges — the builder's idempotence, at the derivation layer", () => {
  const files = corpus({
    "projects/p.md": '---\ntags: [swift]\n---\n\nSee [[q]].\nFixed now (was: "see notes/q.md for the broken version").',
    "notes/q.md": "---\ntags: [swift, ble]\n---\n\nshared vocabulary with p about swift",
  });

  it("derives twice into byte-identical lists, in one defined order", () => {
    const a = deriveEdges(files);
    const b = deriveEdges(files);
    expect(a).toEqual(b);
    const order = a.map((e) => e.kind);
    expect(order).toEqual([...order].sort());
  });

  it("bounds and populates EVERY evidence string — the schema refuses an edge without one", () => {
    const big = corpus({
      "notes/long.md": `See [[q]] here: ${"x".repeat(500)}`,
      "notes/q.md": "target",
    });
    for (const e of [...deriveEdges(files), ...deriveEdges(big)]) {
      expect(e.evidence.length).toBeGreaterThan(0);
      expect(e.evidence.length).toBeLessThanOrEqual(MAX_EVIDENCE);
    }
  });

  it("redacts credential-shaped text out of evidence — the graph must not copy a secret into a second store", () => {
    const files = corpus({
      "notes/leaky.md": `token ghp_${"a".repeat(24)} sits beside [[target]] on this line`,
      "notes/target.md": "clean",
    });
    const [e] = linkEdges(files);
    expect(e.evidence).toContain("<redacted-token>");
    expect(e.evidence).not.toContain("ghp_");
  });
});

/* ── store plumbing ── */

const jsonRes = (body: unknown, status = 200) =>
  ({ ok: status < 400, status, headers: new Headers(), json: async () => body }) as unknown as Response;

describe("rebuildEdges", () => {
  const files = corpus({ "notes/a.md": "See [[b]].", "notes/b.md": "target" });

  it("is 'off' with no env — a mode, not an error", async () => {
    vi.stubEnv("SUPABASE_URL", "");
    expect(await rebuildEdges(files, "head1")).toEqual({ state: "off" });
  });

  it("degrades to 'missing' when the table is not migrated yet — 404 is the EXPECTED pre-migration state", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonRes({ code: "PGRST205" }, 404)));
    expect(await rebuildEdges(files, "head1")).toEqual({ state: "missing" });
  });

  it("skips without deriving when built_head already equals the head", async () => {
    const fetchMock = vi.fn(async (url: RequestInfo | URL) => {
      if (String(url).includes("edges_state")) return jsonRes([{ built_head: "head1" }]);
      throw new Error(`unexpected fetch: ${String(url)}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    expect(await rebuildEdges(files, "head1")).toEqual({ state: "current", head: "head1" });
    // The skip is the common case after most reconciles; it must cost one read, zero writes.
    expect(fetchMock.mock.calls.every(([u]) => !String(u).includes("rpc/"))).toBe(true);
  });

  it("posts the derived edges to the RPC in one call, and two rebuilds post identical bodies", async () => {
    const bodies: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      if (String(url).includes("edges_state")) return jsonRes([{ built_head: "old" }]);
      bodies.push(String(init?.body));
      return jsonRes(true);
    }));
    const r1 = await rebuildEdges(files, "head2");
    const r2 = await rebuildEdges(files, "head2");
    expect(r1).toEqual({ state: "rebuilt", head: "head2", derived: 1 });
    expect(r2).toEqual(r1);
    // Idempotence on the wire: same corpus, same head, byte-identical replace payload.
    expect(bodies[0]).toBe(bodies[1]);
    expect(JSON.parse(bodies[0])).toMatchObject({ new_head: "head2" });
  });

  it("reports 'stale-head' when the RPC refuses — the mirror moved on and the graph must not regress", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: RequestInfo | URL) => {
      if (String(url).includes("edges_state")) return jsonRes([{ built_head: "old" }]);
      return jsonRes(false);
    }));
    expect(await rebuildEdges(files, "head3")).toEqual({ state: "stale-head", head: "head3" });
  });

  it("--force skips the currency check and rebuilds anyway", async () => {
    const urls: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: RequestInfo | URL) => {
      urls.push(String(url));
      return jsonRes(true);
    }));
    const r = await rebuildEdges(files, "head1", { force: true });
    expect(r.state).toBe("rebuilt");
    expect(urls.some((u) => u.includes("edges_state"))).toBe(false);
  });
});

describe("groupEdges — the panel's data, held still", () => {
  const rows: EdgeRow[] = [
    { src: "notes/a.md", dst: "notes/b.md", kind: "link", weight: 2, evidence: "L1: see b" },
    { src: "notes/a.md", dst: "notes/b.md", kind: "tag", weight: 1, evidence: "1 shared frontmatter tag: x" },
    { src: "notes/c.md", dst: "notes/a.md", kind: "correction", weight: 1, evidence: "L9: SUPERSEDED — see notes/a.md" },
  ];

  it("gives each note both ends of its edges, with direction, and symmetric kinds read both ways", () => {
    const g = groupEdges(rows);
    expect(g["notes/a.md"]).toContainEqual({ other: "notes/b.md", dir: "out", kind: "link", weight: 2, evidence: "L1: see b" });
    expect(g["notes/b.md"]).toContainEqual({ other: "notes/a.md", dir: "in", kind: "link", weight: 2, evidence: "L1: see b" });
    expect(g["notes/a.md"]).toContainEqual(expect.objectContaining({ kind: "tag", dir: "both" }));
    expect(g["notes/b.md"]).toContainEqual(expect.objectContaining({ kind: "tag", dir: "both" }));
    expect(g["notes/a.md"]).toContainEqual(expect.objectContaining({ kind: "correction", dir: "in", other: "notes/c.md" }));
  });

  it("caps each kind at the panel's top-K by weight — and the cap is the one the copy states", () => {
    expect(PANEL_TOP_K).toBe(5);
    const many: EdgeRow[] = Array.from({ length: 9 }, (_, i) => ({
      src: "notes/hub.md",
      dst: `notes/n${i}.md`,
      kind: "lexical" as const,
      weight: i,
      evidence: "e",
    }));
    const g = groupEdges(many, 3);
    expect(g["notes/hub.md"]).toHaveLength(3);
    expect(g["notes/hub.md"].map((e) => e.weight)).toEqual([8, 7, 6]);
  });
});

describe("edgesPulse — the console's read, every degraded state named", () => {
  it("is 'off' with no env — the opt-in law: the panel must not render at all", async () => {
    vi.stubEnv("SUPABASE_URL", "");
    expect(await edgesPulse()).toEqual({ state: "off" });
  });

  it("is 'missing' before the migration — the honest pre-apply state, not an error", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonRes({ code: "PGRST205" }, 404)));
    expect(await edgesPulse()).toEqual({ state: "missing" });
  });

  it("is 'empty' when migrated but never built — including the RPC's bootstrap row", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonRes([])));
    expect(await edgesPulse()).toEqual({ state: "empty" });
    vi.stubGlobal("fetch", vi.fn(async () => jsonRes([{ built_head: "", built_at: "x" }])));
    expect(await edgesPulse()).toEqual({ state: "empty" });
  });

  it("fails soft to 'unavailable' when the store errors — the page renders, the panel says so", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonRes(null, 500)));
    expect(await edgesPulse()).toEqual({ state: "unavailable" });
  });

  it("returns the build stamp and grouped edges when built", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: RequestInfo | URL) => {
      if (String(url).includes("edges_state")) {
        return jsonRes([{ built_head: "abcdef1234567890", built_at: "2026-08-11T20:00:00Z" }]);
      }
      return jsonRes([
        { src: "notes/a.md", dst: "notes/b.md", kind: "link", weight: 1, evidence: "L1: see [[b]]" },
      ]);
    }));
    const p = await edgesPulse();
    expect(p).toMatchObject({ state: "built", head: "abcdef1234567890", builtAt: "2026-08-11T20:00:00Z" });
    if (p.state !== "built") throw new Error("unreachable");
    expect(p.byNote["notes/a.md"][0]).toMatchObject({ other: "notes/b.md", dir: "out" });
    expect(p.byNote["notes/b.md"][0]).toMatchObject({ other: "notes/a.md", dir: "in" });
  });

  it("re-scrubs evidence on the way out — the console is an egress, whatever an older builder stored", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: RequestInfo | URL) => {
      if (String(url).includes("edges_state")) return jsonRes([{ built_head: "h", built_at: "x" }]);
      return jsonRes([
        { src: "notes/a.md", dst: "notes/b.md", kind: "link", weight: 1, evidence: `raw ghp_${"a".repeat(24)} token` },
      ]);
    }));
    const p = await edgesPulse();
    if (p.state !== "built") throw new Error("expected built");
    expect(p.byNote["notes/a.md"][0].evidence).toContain("<redacted-token>");
  });
});

/**
 * Regression: 2026-08-12. For three hours "the RPC refused every rebuild", "the scheduler never
 * ran" and "after() swallowed the work" were indistinguishable in production, because stale-head
 * logged nothing and the no-request-scope catch logged nothing. A scheduler that can go dark has
 * to say WHICH dark it went. These tests pin the two formerly-silent paths to a line each.
 */
describe("scheduleEdgeRebuild — the formerly silent outcomes say their names", () => {
  it("logs when the RPC refuses the rebuild (stale-head) instead of nothing", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: RequestInfo | URL) => {
      if (String(url).includes("edges_state")) return jsonRes([{ built_head: "old" }]);
      return jsonRes(false);
    }));
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      scheduleEdgeRebuild(corpus({ "notes/a.md": "See [[b]].", "notes/b.md": "target" }), "head9999");
      await vi.waitFor(() =>
        expect(log).toHaveBeenCalledWith(expect.stringContaining("refused — the mirror had already moved past it"))
      );
    } finally {
      log.mockRestore();
      err.mockRestore();
    }
  });

  it("logs when after() is unavailable instead of swallowing the scheduler whole", async () => {
    // In vitest there is no Next.js request scope, so after() throws — exactly the environment
    // the old empty catch was written for, and exactly the path that must now leave a line.
    vi.stubGlobal("fetch", vi.fn(async (url: RequestInfo | URL) => {
      if (String(url).includes("edges_state")) return jsonRes([{ built_head: "head1" }]);
      return jsonRes(true);
    }));
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      scheduleEdgeRebuild(corpus({ "notes/a.md": "x" }), "head1");
      await vi.waitFor(() =>
        expect(err).toHaveBeenCalledWith(expect.stringContaining("after() unavailable"))
      );
    } finally {
      err.mockRestore();
    }
  });
});
