import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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
import { __setPinStore, type PinRow } from "../lib/pins";
import type { EdgeRow } from "../lib/edges";
import {
  renderHandoff,
  previewHandoff,
  NEIGHBOUR_K,
  HANDOFF_BUDGET_BYTES,
  type HandoffInputs,
} from "../lib/handoff";

const files = (entries: Record<string, string>) => new Map(Object.entries(entries));

function pin(path: string, over: Partial<PinRow> = {}): PinRow {
  return { path, temperature: "hot", reason: "", pinned_at: "2026-08-11T00:00:00Z", ...over };
}

function inputs(over: Partial<HandoffInputs> = {}): HandoffInputs {
  return {
    project: "harbor",
    pagePath: "projects/harbor.md",
    files: files({
      "projects/harbor.md": "# Harbor\n\nthe project page body",
      "notes/soundings.md": "depth numbers",
      "notes/charts.md": "the standing chart conventions",
    }),
    sha: "deadbeefcafe0000",
    bubble: { state: "absent" },
    edges: [],
    scores: [],
    recentDates: [],
    budgetBytes: HANDOFF_BUDGET_BYTES,
    nonce: "feedf00d",
    ...over,
  };
}

beforeEach(() => {
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

/* ── Pins ride the bundle, cited as exactly what they are ───────────────────────────────── */

describe("renderHandoff with pins", () => {
  it("a hot pin rides with the citation 'pinned hot by the operator', reason quoted", () => {
    const { text } = renderHandoff(
      inputs({ pins: [pin("notes/charts.md", { reason: "standing conventions" })] })
    );
    expect(text).toContain("notes/charts.md · WHY: pinned hot by the operator");
    expect(text).toContain('"standing conventions"');
    expect(text).toContain("the standing chart conventions");
  });

  it("cold and warm pins do NOT ride — a cold pin says the opposite of 'bring this along'", () => {
    const { text, decisions } = renderHandoff(
      inputs({ pins: [pin("notes/charts.md", { temperature: "cold" }), pin("notes/soundings.md", { temperature: "warm" })] })
    );
    expect(text).not.toContain("pinned");
    expect(decisions.some((d) => d.kind === "pinned")).toBe(false);
  });

  it("a pin on the page itself, or on a note the graph already carried, adds no duplicate", () => {
    const edges: EdgeRow[] = [
      { src: "projects/harbor.md", dst: "notes/soundings.md", kind: "link", weight: 2, evidence: "L4: see [[soundings]]" },
    ];
    const { decisions } = renderHandoff(
      inputs({ edges, pins: [pin("projects/harbor.md"), pin("notes/soundings.md")] })
    );
    // soundings rides ONCE — as the pinned piece (operator judgement outranks the graph's
    // nomination), and the neighbour copy is skipped.
    expect(decisions.filter((d) => d.label === "notes/soundings.md")).toHaveLength(1);
    expect(decisions.find((d) => d.label === "notes/soundings.md")!.kind).toBe("pinned");
    expect(decisions.filter((d) => d.label === "projects/harbor.md")).toHaveLength(1);
    expect(decisions.find((d) => d.label === "projects/harbor.md")!.kind).toBe("page");
  });

  it("a pin whose note is gone is skipped — a piece with no body is no piece", () => {
    const { decisions } = renderHandoff(inputs({ pins: [pin("notes/vanished.md")] }));
    expect(decisions.some((d) => d.label === "notes/vanished.md")).toBe(false);
  });

  it("the coverage line counts pinned candidates only when any exist", () => {
    const plain = renderHandoff(inputs());
    expect(plain.coverage).not.toContain("pinned");
    const pinned = renderHandoff(inputs({ pins: [pin("notes/charts.md")] }));
    expect(pinned.coverage).toContain("1 note pinned hot");
  });
});

/* ── The decisions ledger: what rode, what did not, and why ─────────────────────────────── */

describe("renderHandoff decisions", () => {
  it("names the exclusion reason for a budget-refused piece — the walk's own account", () => {
    const big = "z".repeat(5_000);
    const { decisions } = renderHandoff(
      inputs({
        files: files({
          "projects/harbor.md": "# Harbor\n\nshort page",
          "notes/soundings.md": big,
          "notes/charts.md": big,
        }),
        edges: [
          { src: "projects/harbor.md", dst: "notes/soundings.md", kind: "link", weight: 2, evidence: "L4" },
          { src: "projects/harbor.md", dst: "notes/charts.md", kind: "link", weight: 1, evidence: "L9" },
        ],
        // Holds the page and one neighbour excerpt; the second neighbour must be refused BY
        // BUDGET and say so.
        budgetBytes: 4_000,
      })
    );
    const included = decisions.filter((d) => d.included).map((d) => d.label);
    expect(included).toContain("projects/harbor.md");
    const out = decisions.filter((d) => !d.included);
    expect(out.length).toBeGreaterThan(0);
    for (const d of out) expect(d.excludedBy).toBe("budget");
    // Every decision carries its citation and its cost — a row with no receipt is not a row.
    for (const d of decisions) {
      expect(d.why.length).toBeGreaterThan(0);
      expect(d.bytes).toBeGreaterThan(0);
    }
  });

  it("marks log pieces refused by the LOG_SHARE cap as 'log-share', not 'budget'", () => {
    const entry = (t: string) => `## ${t} · harbor\n\n${"m".repeat(3_000)}\n`;
    const { decisions } = renderHandoff(
      inputs({
        files: files({
          "projects/harbor.md": "# Harbor\n\nshort page",
          "log/2026-08-10.md": `# Log\n\n${entry("09:00")}${entry("10:00")}${entry("11:00")}`,
        }),
        recentDates: ["2026-08-10"],
        budgetBytes: 8_000,
      })
    );
    const logs = decisions.filter((d) => d.kind === "log");
    expect(logs.some((d) => d.included)).toBe(true);
    expect(logs.some((d) => d.excludedBy === "log-share")).toBe(true);
  });
});

/* ── previewHandoff: the staging read — same walk, no access rows ───────────────────────── */

describe("previewHandoff", () => {
  function seedCorpus() {
    const neighbourEdges: EdgeRow[] = [];
    const f: Record<string, string> = {
      "projects/harbor.md": "# Harbor\n\nthe project page body",
    };
    // NEIGHBOUR_K + 3 linked notes, so three are cut by rank before the budget sees them.
    for (let i = 0; i < NEIGHBOUR_K + 3; i++) {
      const p = `notes/n${String(i).padStart(2, "0")}.md`;
      f[p] = `neighbour body ${i}`;
      neighbourEdges.push({
        src: "projects/harbor.md",
        dst: p,
        kind: "link",
        weight: NEIGHBOUR_K + 3 - i,
        evidence: `L${i + 1}: see it`,
      });
    }
    __setCache({
      files: new Map(Object.entries(f)),
      sidecar: new Map(),
      sha: "deadbeefcafe0000",
      bytes: 0,
      fetchedAt: Date.now(),
    });
    return neighbourEdges;
  }

  it("returns the coverage verbatim, the decisions, and the rank-excluded tail", async () => {
    const edges = seedCorpus();
    vi.stubEnv("SUPABASE_URL", "https://x.supabase.co");
    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "k");
    const fetchMock = vi.fn(async (url: RequestInfo | URL) => {
      const u = String(url);
      if (u.includes("note_edges")) return new Response(JSON.stringify(edges), { status: 200 });
      return new Response(JSON.stringify([]), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const view = await previewHandoff("harbor");
    expect(view.project).toBe("harbor");
    expect(view.coverage).toMatch(/^handoff · harbor @deadbeefcafe/);
    expect(view.pieces.find((d) => d.kind === "page")!.included).toBe(true);
    // Blend-ranked (scores empty): the three weakest links fall off the shortlist as RANK
    // exclusions, distinct from budget exclusions.
    expect(view.rankExcludedTotal).toBe(3);
    expect(view.rankExcluded.map((n) => n.path)).toContain(`notes/n${NEIGHBOUR_K + 2}.md`);
    expect(view.graph).toBe("on");

    // THE PREVIEW OBSERVES, NEVER WARMS: no note_access rows may be written by staging.
    const accessCalls = fetchMock.mock.calls.filter(([u]) => String(u).includes("note_access"));
    expect(accessCalls).toHaveLength(0);
  });

  it("throws the honest miss for an unknown project, closest names attached", async () => {
    seedCorpus();
    await expect(previewHandoff("harbour-north")).rejects.toThrow(/closest: harbor/);
  });
});
