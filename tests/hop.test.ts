import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildAdjacency,
  hopNarrow,
  HOP_SHAPES,
  BEST_MEASURED,
  STRUCTURAL_KINDS,
  ALL_KINDS,
  type HopConfig,
} from "../lib/hop";
import { narrow, rank } from "../lib/narrow";
import type { EdgeRow } from "../lib/edges";

/** A corpus in a line — same shorthand as edges.test.ts. */
const corpus = (entries: Record<string, string>) => new Map(Object.entries(entries));

const edge = (src: string, dst: string, kind: EdgeRow["kind"], weight = 1): EdgeRow => ({
  src,
  dst,
  kind,
  weight,
  evidence: "test",
});

/**
 * A corpus where BM25 has strong opinions: the question "harbor tuning" ranks the harbor notes,
 * and the graph knows things BM25 cannot see (a note that never says "harbor" but is linked).
 */
const FILES = corpus({
  "projects/harbor.md": "harbor tuning results and the harbor pipeline",
  "notes/harbor-tuning.md": "harbor tuning parameters, harbor tuning sweep",
  "notes/harbor-deploy.md": "harbor deploy checklist",
  "notes/soundings.md": "depth measurements, nothing else",
  "notes/kiln.md": "kiln firing schedule",
  "notes/unrelated.md": "completely different topic entirely",
});

const EDGES: EdgeRow[] = [
  edge("projects/harbor.md", "notes/soundings.md", "link", 3),
  edge("projects/harbor.md", "notes/kiln.md", "tag", 1),
  edge("notes/harbor-tuning.md", "notes/unrelated.md", "coaccess", 5),
  edge("projects/harbor.md", "notes/harbor-deploy.md", "lexical", 4.2),
];

const FILL_ONLY = HOP_SHAPES["fill-only"];
const TAIL2: HopConfig = { tailSlots: 2, displaceAboveK: 0, seeds: 3, kinds: ALL_KINDS, minWeight: 0 };

describe("buildAdjacency", () => {
  it("is undirected and deterministic: shuffled rows build the identical adjacency", () => {
    const a = buildAdjacency(EDGES);
    const b = buildAdjacency([...EDGES].reverse());
    expect(a).toEqual(b);
    // Both endpoints see the edge — retrieval asks "what travels with this note", not who said it.
    expect(a.get("projects/harbor.md")!.map((n) => n.other)).toContain("notes/soundings.md");
    expect(a.get("notes/soundings.md")!.map((n) => n.other)).toContain("projects/harbor.md");
  });

  it("sorts each neighbour list by weight desc, then path — same rows, same order, every time", () => {
    const adj = buildAdjacency(EDGES);
    const weights = adj.get("projects/harbor.md")!.map((n) => n.weight);
    expect(weights).toEqual([...weights].sort((x, y) => y - x));
  });
});

describe("hopNarrow — determinism", () => {
  it("returns byte-identical candidates across repeated calls and across adjacency row order", () => {
    for (const config of Object.values(HOP_SHAPES)) {
      const a = hopNarrow(FILES, "harbor tuning", 5, buildAdjacency(EDGES), config);
      const b = hopNarrow(FILES, "harbor tuning", 5, buildAdjacency([...EDGES].reverse()), config);
      const c = hopNarrow(FILES, "harbor tuning", 5, buildAdjacency(EDGES), config);
      expect(b).toEqual(a);
      expect(c).toEqual(a);
    }
  });

  it("never returns duplicates and never exceeds k", () => {
    const adj = buildAdjacency(EDGES);
    for (const config of Object.values(HOP_SHAPES)) {
      for (const k of [1, 3, 5, 10]) {
        const got = hopNarrow(FILES, "harbor tuning", k, adj, config);
        expect(got.length).toBeLessThanOrEqual(k);
        expect(new Set(got).size).toBe(got.length);
      }
    }
  });
});

describe("hopNarrow — budget invariants (the FTS lesson, as executable law)", () => {
  it("BEST_MEASURED (what ships as the recommendation) NEVER displaces BM25's top-k, at any k", () => {
    const adj = buildAdjacency(EDGES);
    const config = HOP_SHAPES[BEST_MEASURED];
    for (const k of [1, 2, 3, 5, 10]) {
      const bm = narrow(FILES, "harbor tuning", k);
      const got = hopNarrow(FILES, "harbor tuning", k, adj, config);
      // The whole of BM25's own answer survives, in BM25's own order, at the front.
      expect(got.slice(0, bm.length)).toEqual(bm);
    }
  });

  it("at k=5 no SHIPPED shape with a k-aware guard displaces BM25's top-5", () => {
    const adj = buildAdjacency(EDGES);
    const bm = narrow(FILES, "harbor tuning", 5);
    for (const [name, config] of Object.entries(HOP_SHAPES)) {
      if (config.tailSlots > 0 && config.displaceAboveK < 5) continue; // displacing shapes, measured and rejected
      const got = hopNarrow(FILES, "harbor tuning", 5, adj, config);
      expect(got.slice(0, bm.length), name).toEqual(bm);
    }
  });

  it("a displacing shape touches ONLY the declared tail slots — the protected prefix is inviolate", () => {
    const adj = buildAdjacency(EDGES);
    const k = 4;
    const bmRanked = rank(FILES, "harbor tuning").map((s) => s.path);
    const got = hopNarrow(FILES, "harbor tuning", k, adj, TAIL2);
    // Top (k - tailSlots) BM25 ranks, exact and in order.
    expect(got.slice(0, k - TAIL2.tailSlots)).toEqual(bmRanked.slice(0, k - TAIL2.tailSlots));
  });

  it("k-aware guard: below the threshold the displacing config behaves exactly like fill-only", () => {
    const adj = buildAdjacency(EDGES);
    const kaware = HOP_SHAPES["k-aware tail-2"];
    expect(hopNarrow(FILES, "harbor tuning", 5, adj, kaware)).toEqual(
      hopNarrow(FILES, "harbor tuning", 5, adj, { ...kaware, tailSlots: 0 })
    );
    // Above the threshold the tail opens up, but the protected prefix still holds.
    const bmRanked = rank(FILES, "harbor tuning").map((s) => s.path);
    const guarded = Math.min(6 - kaware.tailSlots, bmRanked.length);
    const at6 = hopNarrow(FILES, "harbor tuning", 6, adj, kaware);
    expect(at6.slice(0, guarded)).toEqual(bmRanked.slice(0, guarded));
  });
});

describe("hopNarrow — fill and fallback", () => {
  it("fills with hop neighbours when BM25 underfills — the one case fill-only can add anything", () => {
    // Only two notes mention the question terms; the third is reachable only through the graph.
    const files = corpus({
      "a.md": "quartz crystal oscillator",
      "b.md": "quartz mine",
      "c.md": "nothing relevant here",
    });
    const adj = buildAdjacency([edge("a.md", "c.md", "link", 1)]);
    const got = hopNarrow(files, "quartz", 3, adj, FILL_ONLY);
    expect(got.slice(0, 2)).toEqual(narrow(files, "quartz", 3));
    expect(got).toContain("c.md");
  });

  it("degrades to narrow()'s fallback when the question has no lexical signal at all", () => {
    const adj = buildAdjacency(EDGES);
    for (const config of Object.values(HOP_SHAPES)) {
      expect(hopNarrow(FILES, "???", 3, adj, config)).toEqual(narrow(FILES, "???", 3));
    }
  });

  it("an empty adjacency makes every shape collapse to plain BM25", () => {
    const none = buildAdjacency([]);
    for (const config of Object.values(HOP_SHAPES)) {
      expect(hopNarrow(FILES, "harbor tuning", 5, none, config)).toEqual(narrow(FILES, "harbor tuning", 5));
    }
  });
});

describe("hopNarrow — gating", () => {
  it("kind gating: a structural config never follows a lexical edge", () => {
    const files = corpus({
      "a.md": "quartz crystal",
      "b.md": "unrelated one",
      "c.md": "unrelated two",
    });
    const adj = buildAdjacency([edge("a.md", "b.md", "lexical", 9), edge("a.md", "c.md", "link", 1)]);
    const structural: HopConfig = { tailSlots: 0, displaceAboveK: 0, seeds: 3, kinds: STRUCTURAL_KINDS, minWeight: 0 };
    const got = hopNarrow(files, "quartz", 3, adj, structural);
    expect(got).toContain("c.md"); // the link, kept
    expect(got).not.toContain("b.md"); // the lexical edge, gated out despite its higher weight
  });

  it("weight gating: an edge under minWeight contributes nothing", () => {
    const files = corpus({ "a.md": "quartz crystal", "b.md": "unrelated" });
    const adj = buildAdjacency([edge("a.md", "b.md", "link", 1)]);
    const strong: HopConfig = { tailSlots: 0, displaceAboveK: 0, seeds: 3, kinds: ALL_KINDS, minWeight: 2 };
    expect(hopNarrow(files, "quartz", 2, adj, strong)).not.toContain("b.md");
  });

  it("a neighbour the corpus does not hold is never emitted — live coaccess rows can name notes a scoped or older snapshot lacks", () => {
    const files = corpus({ "a.md": "quartz crystal" });
    const adj = buildAdjacency([edge("a.md", "gone/deleted.md", "coaccess", 9)]);
    expect(hopNarrow(files, "quartz", 3, adj, FILL_ONLY)).toEqual(["a.md"]);
  });

  it("hop order is seed-rank first, then weight: the best hit's neighbourhood outranks a stronger edge from a weaker hit", () => {
    const files = corpus({
      "top.md": "quartz crystal quartz quartz",
      "second.md": "quartz",
      "n1.md": "zzz",
      "n2.md": "zzz",
    });
    const adj = buildAdjacency([
      edge("second.md", "n2.md", "link", 9), // heavier, but from the rank-2 seed
      edge("top.md", "n1.md", "link", 1),
    ]);
    const got = hopNarrow(files, "quartz", 3, adj, FILL_ONLY);
    expect(got).toEqual(["top.md", "second.md", "n1.md"]);
  });
});

describe("the frozen shape set", () => {
  it("holds at most SIX shapes — more is overfitting the 170-label set, by decree of the module header", () => {
    expect(Object.keys(HOP_SHAPES).length).toBeLessThanOrEqual(6);
  });

  it("every shape uses the same seed count, so the sweep varied one axis at a time", () => {
    for (const config of Object.values(HOP_SHAPES)) expect(config.seeds).toBe(3);
  });

  it("BEST_MEASURED names a real shape, and that shape never displaces", () => {
    const config = HOP_SHAPES[BEST_MEASURED];
    expect(config).toBeDefined();
    expect(config.tailSlots).toBe(0);
  });

  it("the eval harness runs exactly the frozen shapes — a shape that was never measured cannot exist", () => {
    // Source-level, same spirit as the banner-parity test: the harness must iterate HOP_SHAPES
    // itself rather than keep a private copy that can drift from what this module froze.
    const src = readFileSync(path.join(process.cwd(), "scripts", "eval-retrieval.ts"), "utf8");
    expect(src).toContain("HOP_SHAPES");
    expect(src).toContain("hopNarrow");
    expect(src).toContain("buildAdjacency");
  });
});
