import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../lib/corpus", () => ({ loadCorpus: vi.fn() }));
vi.mock("../lib/edges", () => ({ allEdges: vi.fn() }));
vi.mock("../lib/pulse", () => ({ noteHeat: vi.fn() }));

import { loadCorpus } from "../lib/corpus";
import { allEdges, type EdgeRow } from "../lib/edges";
import { noteHeat } from "../lib/pulse";
import { buildAtlas, budgetEdges, MAP_EDGES_PER_NOTE, MAP_EDGE_CAP } from "../lib/atlas";

const mLoad = vi.mocked(loadCorpus);
const mEdges = vi.mocked(allEdges);
const mHeat = vi.mocked(noteHeat);

function corpus(files: Array<[string, string]>) {
  return {
    sha: "c".repeat(40),
    bytes: files.reduce((a, [, t]) => a + t.length, 0),
    files: new Map(files),
    sidecar: new Map<string, string>(),
  } as unknown as Awaited<ReturnType<typeof loadCorpus>>;
}

const row = (src: string, dst: string, kind: EdgeRow["kind"], weight = 1, evidence = "ev"): EdgeRow => ({
  src,
  dst,
  kind,
  weight,
  evidence,
});

const NOTES = ["notes/a.md", "notes/b.md", "notes/c.md", "notes/d.md", "notes/e.md"];

beforeEach(() => {
  vi.resetAllMocks();
  mLoad.mockResolvedValue(corpus(NOTES.map((p) => [p, `# ${p}\n\nBody of ${p}.\n`])));
  mEdges.mockResolvedValue(null);
  mHeat.mockResolvedValue(null);
});

/* ── the budget: what "the graph on the board" means ── */

describe("budgetEdges", () => {
  const notes = new Set(NOTES);

  it("keeps only edges whose BOTH endpoints are live notes", () => {
    const kept = budgetEdges(
      [row("notes/a.md", "ghost.md", "link"), row("ghost.md", "notes/b.md", "tag"), row("notes/a.md", "notes/b.md", "link")],
      notes,
    );
    expect(kept).toEqual([row("notes/a.md", "notes/b.md", "link")]);
  });

  it("drops a self-edge rather than drawing a loop", () => {
    expect(budgetEdges([row("notes/a.md", "notes/a.md", "link")], notes)).toEqual([]);
  });

  it("ranks kind-first — an explicit link outranks a fat lexical score", () => {
    // Budget of 1 per note: the link and the tag win their endpoints before coaccess arrives,
    // even though the coaccess weight dwarfs both.
    const rows = [
      row("notes/b.md", "notes/c.md", "coaccess", 40),
      row("notes/a.md", "notes/b.md", "link", 1),
      row("notes/a.md", "notes/c.md", "tag", 1),
    ];
    const kept = budgetEdges(rows, notes, 1);
    expect(kept.map((e) => e.kind)).toEqual(["link", "tag"]);
  });

  it("weight breaks ties within a kind, path breaks ties within a weight", () => {
    // All three survive (each far end has budget to spare); what the test holds still is the
    // ORDER, because strongest-first is what makes the draw-in and the cap mean something.
    const rows = [
      row("notes/a.md", "notes/d.md", "tag", 1),
      row("notes/a.md", "notes/c.md", "tag", 5),
      row("notes/a.md", "notes/b.md", "tag", 1),
    ];
    const kept = budgetEdges(rows, notes, 2);
    expect(kept.map((e) => e.dst)).toEqual(["notes/c.md", "notes/b.md", "notes/d.md"]);
  });

  it("an edge survives while EITHER endpoint still has budget", () => {
    // a is saturated by three links, but b has room — the a↔b tag rides on b's budget.
    const rows = [
      row("notes/a.md", "notes/c.md", "link", 3),
      row("notes/a.md", "notes/d.md", "link", 2),
      row("notes/a.md", "notes/e.md", "link", 1),
      row("notes/a.md", "notes/b.md", "tag", 1),
    ];
    const kept = budgetEdges(rows, notes, 3);
    expect(kept).toHaveLength(4);
    expect(kept.at(-1)?.kind).toBe("tag");
  });

  it("skips an edge when both endpoints are saturated", () => {
    const rows = [
      row("notes/a.md", "notes/c.md", "link", 9),
      row("notes/a.md", "notes/b.md", "link", 8),
      row("notes/b.md", "notes/c.md", "link", 7),
      // Every endpoint of this one has already spent its budget of 1... except none has 2.
      row("notes/b.md", "notes/a.md", "tag", 1),
    ];
    const kept = budgetEdges(rows, notes, 1);
    // link a-c takes a and c; link a-b rides b's budget (a full, b has room); b-c: both full.
    expect(kept.map((e) => e.kind)).toEqual(["link", "link"]);
  });

  it("caps globally, trimming the weakest of what remains", () => {
    const rows = NOTES.flatMap((s) =>
      NOTES.filter((d) => d !== s).map((d) => row(s, d, "lexical", 5)),
    );
    const kept = budgetEdges(rows, notes, 3, 4);
    expect(kept).toHaveLength(4);
  });

  it("is deterministic: same rows in any order, byte-identical budget out", () => {
    const rows = [
      row("notes/a.md", "notes/b.md", "lexical", 12),
      row("notes/b.md", "notes/c.md", "tag", 2),
      row("notes/a.md", "notes/c.md", "link", 1),
      row("notes/c.md", "notes/d.md", "coaccess", 7),
    ];
    const a = budgetEdges([...rows], notes);
    const b = budgetEdges([...rows].reverse(), notes);
    expect(a).toEqual(b);
  });

  it("exports the budget constants the payload is built from", () => {
    expect(MAP_EDGES_PER_NOTE).toBe(3);
    expect(MAP_EDGE_CAP).toBe(240);
  });
});

/* ── the payload seam: edges → map shape ── */

describe("buildAtlas with a built graph", () => {
  it("ships note ties as edges with kind, weight and evidence-as-why", async () => {
    mEdges.mockResolvedValue([row("notes/a.md", "notes/b.md", "link", 2, "L3: see [[b]]")]);
    const { json, meta } = await buildAtlas();
    const d = JSON.parse(json);
    expect(d.edges).toContainEqual({
      source: "notes/a.md",
      target: "notes/b.md",
      kind: "link",
      why: "L3: see [[b]]",
      w: 2,
    });
    expect(meta.graphEdges).toBe(1);
  });

  it("never ships an edge to a note the corpus no longer holds", async () => {
    mEdges.mockResolvedValue([
      row("notes/a.md", "notes/b.md", "tag", 1),
      row("notes/a.md", "archive/dead.md", "link", 5),
    ]);
    const d = JSON.parse((await buildAtlas()).json);
    const ids = new Set(d.nodes.map((n: { id: string }) => n.id));
    for (const e of d.edges) {
      expect(ids.has(e.source)).toBe(true);
      expect(ids.has(e.target)).toBe(true);
    }
    expect(d.edges).toHaveLength(1);
  });

  it("applies the per-note budget before shipping", async () => {
    // The complete lexical graph over five notes: ten edges, every note degree four. The
    // budget (3 per note, either-endpoint survival) must trim the tie both of whose ends
    // are already covered — d↔e, the last pair in the deterministic order.
    const pairs: EdgeRow[] = [];
    for (let i = 0; i < NOTES.length; i++)
      for (let j = i + 1; j < NOTES.length; j++) pairs.push(row(NOTES[i], NOTES[j], "lexical", 5));
    mEdges.mockResolvedValue(pairs);
    const { json, meta } = await buildAtlas();
    const d = JSON.parse(json);
    expect(d.edges).toHaveLength(9);
    expect(meta.graphEdges).toBe(9);
    expect(
      d.edges.some((e: { source: string; target: string }) => e.source === "notes/d.md" && e.target === "notes/e.md"),
    ).toBe(false);
  });

  it("reports zero ties as 0, never as absent", async () => {
    mEdges.mockResolvedValue([]);
    const { meta } = await buildAtlas();
    expect(meta.graphEdges).toBe(0);
  });
});

describe("buildAtlas without the store", () => {
  it("renders exactly the old map: no note edges, graph reported absent", async () => {
    mEdges.mockResolvedValue(null);
    mHeat.mockResolvedValue(null);
    const { json, meta } = await buildAtlas();
    const d = JSON.parse(json);
    expect(d.edges).toEqual([]);
    expect(meta.graphEdges).toBeNull();
    for (const n of d.nodes) expect(n.temp).toBeUndefined();
  });
});

/* ── heat: temperature riding the nodes ── */

describe("buildAtlas heat", () => {
  it("attaches temperature and reads to the note that earned them", async () => {
    mHeat.mockResolvedValue([
      { path: "notes/a.md", temperature: "hot", score: 0.92, reads: 34 },
      { path: "notes/b.md", temperature: "cold", score: 0.05, reads: 0 },
    ]);
    const d = JSON.parse((await buildAtlas()).json);
    const byId = new Map(d.nodes.map((n: { id: string }) => [n.id, n]));
    expect(byId.get("notes/a.md")).toMatchObject({ temp: "hot", reads: 34 });
    expect(byId.get("notes/b.md")).toMatchObject({ temp: "cold", reads: 0 });
    // A note the scorer has not seen makes no temperature claim at all.
    expect((byId.get("notes/c.md") as { temp?: string }).temp).toBeUndefined();
  });

  it("ignores a score row for a path the corpus does not hold", async () => {
    mHeat.mockResolvedValue([{ path: "archive/gone.md", temperature: "hot", score: 1, reads: 9 }]);
    const d = JSON.parse((await buildAtlas()).json);
    expect(d.nodes.some((n: { temp?: string }) => n.temp)).toBe(false);
  });
});
