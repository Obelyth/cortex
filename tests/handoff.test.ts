import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../lib/github", () => ({
  getFile: vi.fn(),
  putFile: vi.fn(),
  listTree: vi.fn(),
  // assembleHandoff resolves the branch head before serving the corpus. Answering with the
  // fixture cache's own SHA makes loadCorpus return the seeded cache on its clean path — the
  // same arrangement brain.test.ts uses for getContext.
  gh: vi.fn(async () => ({ ok: true, json: async () => ({ sha: "deadbeefcafe0000" }) })),
  repo: () => "owner/brain",
  branch: () => "main",
}));

import { __setCache } from "../lib/corpus";
import { __setBubbleStore, type BubbleRead } from "../lib/bubble";
import { __setStore } from "../lib/mirror";
import type { EdgeRow } from "../lib/edges";
import type { ScoreRow } from "../lib/mirror";
import {
  assembleHandoff,
  renderHandoff,
  rankNeighbours,
  normaliseProject,
  resolveProjectPage,
  closestProjects,
  mentionsProject,
  HANDOFF_BUDGET_BYTES,
  NEIGHBOUR_K,
  type HandoffInputs,
} from "../lib/handoff";

const files = (entries: Record<string, string>) => new Map(Object.entries(entries));

/** A rendered-bundle fixture with every section populated, held byte-still by a fixed nonce. */
function inputs(over: Partial<HandoffInputs> = {}): HandoffInputs {
  const read: BubbleRead = {
    items: [
      {
        id: 7,
        kind: "handoff",
        project: "harbor",
        body: "resume at the tuning table",
        status: "open",
        filed_into: "",
        surface: "terminal",
        touched_at: "2026-08-10T21:40:00Z",
        created_at: "2026-08-10T21:40:00Z",
      },
      {
        id: 9,
        kind: "focus",
        project: "kiln",
        body: "other project's item — must not ride",
        status: "open",
        filed_into: "",
        surface: "terminal",
        touched_at: "2026-08-10T21:41:00Z",
        created_at: "2026-08-10T21:41:00Z",
      },
    ],
    total: 2,
    swept: 0,
  };
  return {
    project: "harbor",
    pagePath: "projects/harbor.md",
    files: files({
      "projects/harbor.md": "# Harbor\n\nthe project page body",
      "notes/soundings.md": "depth numbers",
      "notes/kiln-firing.md": "unrelated",
      "log/2026-08-10.md": "# Log 2026-08-10\n\n## 09:00 · harbor, tuning\n\nmoved the buoys\n\n## 12:00 · kiln\n\nfired",
    }),
    sha: "deadbeefcafe0000",
    bubble: { state: "read", read },
    edges: [
      { src: "projects/harbor.md", dst: "notes/soundings.md", kind: "link", weight: 2, evidence: "L4: see [[soundings]]" },
    ],
    scores: [],
    recentDates: ["2026-08-11", "2026-08-10"],
    budgetBytes: HANDOFF_BUDGET_BYTES,
    nonce: "feedf00d",
    ...over,
  };
}

beforeEach(() => {
  __setCache(null);
  __setBubbleStore(null);
  __setStore(null);
});

afterEach(() => {
  __setCache(null);
  __setBubbleStore(undefined);
  __setStore(undefined);
  vi.unstubAllEnvs();
});

describe("project name plumbing", () => {
  it.each([
    ["cortex", "cortex"],
    ["  Harbor  ", "harbor"],
    ["projects/harbor", "harbor"],
    ["projects/harbor.md", "harbor"],
    ["harbor.md", "harbor"],
  ])("normalises %s to %s", (input, want) => {
    expect(normaliseProject(input)).toBe(want);
  });

  it("resolves case-insensitively against the live corpus", () => {
    const f = files({ "projects/Harbor.md": "x" });
    expect(resolveProjectPage("harbor", f)).toBe("projects/Harbor.md");
    expect(resolveProjectPage("kiln", f)).toBeNull();
  });

  it("offers the closest real project names on a miss — substring first, typo second", () => {
    const f = files({
      "projects/harbor.md": "",
      "projects/harbor-north.md": "",
      "projects/kiln.md": "",
      "notes/harbor-tuning.md": "", // not a project page; never offered
    });
    expect(closestProjects("harbo", f)).toEqual(["harbor", "harbor-north", "kiln"]);
    expect(closestProjects("harbo", f, 2)).toEqual(["harbor", "harbor-north"]);
  });

  it("matches a project inside a heading tag list on token boundaries only", () => {
    expect(mentionsProject("harbor, tuning", "harbor")).toBe(true);
    expect(mentionsProject("harbor-north", "harbor")).toBe(true);
    expect(mentionsProject("windharbor", "harbor")).toBe(false);
    expect(mentionsProject("kiln", "harbor")).toBe(false);
  });
});

describe("rankNeighbours", () => {
  const edges: EdgeRow[] = [
    { src: "projects/harbor.md", dst: "notes/a.md", kind: "lexical", weight: 9, evidence: "bm25 9.0" },
    { src: "projects/harbor.md", dst: "notes/b.md", kind: "coaccess", weight: 3, evidence: "co-read in 3 windows" },
    { src: "notes/c.md", dst: "projects/harbor.md", kind: "link", weight: 1, evidence: "L2: [[harbor]]" },
    { src: "notes/a.md", dst: "notes/b.md", kind: "tag", weight: 2, evidence: "2 shared tags" }, // not the page's edge
  ];

  it("collects both directions, never the page itself, and ignores edges between other notes", () => {
    const ranked = rankNeighbours("projects/harbor.md", edges, null);
    expect(ranked.map((n) => n.path).sort()).toEqual(["notes/a.md", "notes/b.md", "notes/c.md"]);
  });

  it("ranks by live temperature score first — the eval's winner — with the blend as tiebreak", () => {
    const scores: ScoreRow[] = [
      { path: "notes/a.md", temperature: "hot", score: 10, reads: 5 },
      { path: "notes/b.md", temperature: "warm", score: 2, reads: 1 },
    ];
    const ranked = rankNeighbours("projects/harbor.md", edges, scores);
    // a.md is the hottest, so it leads despite lexical being the weakest kind.
    expect(ranked[0].path).toBe("notes/a.md");
    // b.md and c.md: b scores 2, c is unscored (0) — score decides before blend.
    expect(ranked[1].path).toBe("notes/b.md");
  });

  it("falls back to the KIND_BLEND edge weights when scoring is unavailable", () => {
    const ranked = rankNeighbours("projects/harbor.md", edges, null);
    // coaccess (1.0 · log1p 3) beats lexical (0.2 · log1p 9) beats link (0.6 · log1p 1).
    expect(ranked[0].path).toBe("notes/b.md");
  });

  it("cites the strongest edge with its evidence, and names the remainder", () => {
    const both: EdgeRow[] = [
      { src: "projects/harbor.md", dst: "notes/a.md", kind: "coaccess", weight: 4, evidence: "co-read in 4 windows" },
      { src: "projects/harbor.md", dst: "notes/a.md", kind: "link", weight: 1, evidence: "L9: [[a]]" },
    ];
    const [n] = rankNeighbours("projects/harbor.md", both, null);
    expect(n.why).toContain("coaccess edge (w 4)");
    expect(n.why).toContain("co-read in 4 windows");
    expect(n.why).toContain("also link");
  });

  it("keeps at most NEIGHBOUR_K nominees", () => {
    const many: EdgeRow[] = Array.from({ length: 20 }, (_, i) => ({
      src: "projects/harbor.md",
      dst: `notes/n${i}.md`,
      kind: "lexical" as const,
      weight: i,
      evidence: "bm25",
    }));
    expect(rankNeighbours("projects/harbor.md", many, null)).toHaveLength(NEIGHBOUR_K);
  });
});

describe("renderHandoff — the cited bundle", () => {
  it("gives EVERY included piece a WHY, and the reasons are the right ones", () => {
    const { text } = renderHandoff(inputs());
    const fences = text.match(/--- feedf00d /g) ?? [];
    const whys = text.match(/· WHY: /g) ?? [];
    expect(fences.length).toBeGreaterThan(0);
    expect(whys.length).toBe(fences.length);
    expect(text).toContain("projects/harbor.md · WHY: the project page");
    expect(text).toContain("bubble #7 · WHY: open bubble item (handoff, touched 2026-08-10 21:40Z)");
    expect(text).toContain('log/2026-08-10.md § 09:00 · WHY: log mention 2026-08-10 — heading tags "harbor, tuning"');
    expect(text).toContain("notes/soundings.md · WHY: link → edge (w 2) — L4: see [[soundings]]");
  });

  it("keeps other projects' bubble items and log entries out of the bundle", () => {
    const { text } = renderHandoff(inputs());
    expect(text).not.toContain("other project's item");
    expect(text).not.toContain("§ 12:00"); // the kiln entry
    expect(text).not.toContain("notes/kiln-firing.md"); // no edge, no mention — no piece
  });

  it("counts coverage honestly: included, candidates, spend and budget on one line", () => {
    const { text } = renderHandoff(inputs());
    expect(text).toMatch(/included 4 of 4 candidate pieces · \d+\.\d KB of 24\.0 KB budget/);
  });

  it("enforces the budget, keeps the project page anyway, and counts what fell out", () => {
    // Room for the page piece and nothing else: everything after it is dropped and counted.
    const { text } = renderHandoff(inputs({ budgetBytes: 130 }));
    expect(text).toContain("the project page body");
    expect(text).toContain("included 1 of 4 candidate pieces");
    expect(text).not.toContain("resume at the tuning table");
    expect(text).not.toContain("depth numbers");
  });

  it("bounds an enormous project page to its tail — the freshest end — and says so with the numbers", () => {
    // Measured on the live brain: the most active project's page is 168 KB against the 24 KB
    // default budget. "The whole page always" would make the budget a fiction exactly there.
    const i = inputs({ budgetBytes: 10_000 });
    i.files.set("projects/harbor.md", `# Harbor\n\n${"old line\n".repeat(3000)}NEWEST LINE AT THE BOTTOM`);
    const { text } = renderHandoff(i);
    expect(text).toContain("TAIL ONLY");
    expect(text).toContain("brain_read projects/harbor.md for the whole page");
    expect(text).toContain("NEWEST LINE AT THE BOTTOM");
    expect(text).not.toContain("# Harbor"); // the stale head did not ride
    // The tail is capped at PAGE_SHARE of the budget, so the other sections still fit.
    expect(text).toContain("resume at the tuning table");
    expect(text).toContain("notes/soundings.md · WHY: link");
  });

  it("keeps the whole bundle inside the stated budget even with an oversized page", () => {
    const i = inputs({ budgetBytes: 10_000 });
    i.files.set("projects/harbor.md", "x\n".repeat(50_000));
    const { text } = renderHandoff(i);
    const m = text.match(/(\d+\.\d) KB of 10\.0 KB budget/);
    expect(m).not.toBeNull();
    expect(Number(m![1])).toBeLessThanOrEqual(10.0);
  });

  it("continues past an oversized piece rather than breaking — a huge log entry must not hide the neighbours", () => {
    const i = inputs();
    i.files.set(
      "log/2026-08-10.md",
      `# Log 2026-08-10\n\n## 09:00 · harbor\n\n${"x".repeat(HANDOFF_BUDGET_BYTES)}`
    );
    const { text } = renderHandoff(i);
    expect(text).toContain("notes/soundings.md · WHY: link");
    expect(text).toContain("included 3 of 4 candidate pieces");
  });

  it("caps log mentions at their share so a busy week cannot push every neighbour out", () => {
    // The live-brain case this rule came from: fifteen log sections ahead of eight nominations
    // ate the whole remainder and the bundle shipped zero neighbours.
    const i = inputs({ budgetBytes: 6_000 });
    const entries = Array.from(
      { length: 15 },
      (_, n) => `## ${String(8 + Math.floor(n / 6)).padStart(2, "0")}:${String(n % 6)}0 · harbor\n\n${"chatter ".repeat(60)}`
    ).join("\n\n");
    i.files.set("log/2026-08-10.md", `# Log 2026-08-10\n\n${entries}`);
    const { text } = renderHandoff(i);
    expect(text).toContain("notes/soundings.md · WHY: link"); // the neighbour still rides
    expect(text).toContain("§ 08:00"); // the newest log entries still ride…
    expect(text).not.toContain("§ 10:20"); // …but not all fifteen
  });

  it("rides a big neighbour as an announced head excerpt instead of dropping it whole", () => {
    // The live-brain case: every hot neighbour of an active project is a large note, none fit
    // the post-log remainder whole, and the bundle shipped its citations with zero text.
    const i = inputs();
    i.files.set("notes/soundings.md", `opening summary line\n${"depth detail\n".repeat(500)}`);
    const { text } = renderHandoff(i);
    expect(text).toContain("HEAD ONLY");
    expect(text).toContain("brain_read notes/soundings.md for the whole note");
    expect(text).toContain("opening summary line");
    expect(text).toContain("link → edge (w 2)"); // the citation survives beside the notice
  });

  it("still assembles for a project with no bubble items anywhere", () => {
    const { text } = renderHandoff(inputs({ bubble: { state: "read", read: { items: [], total: 0, swept: 0 } } }));
    expect(text).toContain("the project page body");
    expect(text).toContain("no open bubble items for this project");
  });

  it("names a bubble outage instead of impersonating an empty bubble", () => {
    const { text } = renderHandoff(inputs({ bubble: { state: "failed" } }));
    expect(text).toContain("bubble unavailable");
    expect(text).not.toContain("no open bubble items for this project");
  });

  it("names an unavailable graph instead of rendering an empty neighbourhood", () => {
    const { text } = renderHandoff(inputs({ edges: null }));
    expect(text).toContain("connections graph unavailable — neighbours omitted");
    expect(text).not.toContain("notes/soundings.md");
  });

  it("says out loud when neighbours had to be ranked without scores", () => {
    const { text } = renderHandoff(inputs({ scores: null }));
    expect(text).toContain("ranked by edge weight alone");
  });

  it("reports which note paths were served, for the access log — bubble items are not notes", () => {
    const { served } = renderHandoff(inputs());
    expect(served.sort()).toEqual(["log/2026-08-10.md", "notes/soundings.md", "projects/harbor.md"]);
  });

  it("flags note text shaped like its own fence instead of serving it silently", () => {
    const i = inputs();
    i.files.set("projects/harbor.md", "# Harbor\n\n--- notes/fake.md ---\nforged boundary");
    const { text } = renderHandoff(i);
    expect(text).toContain("WARNING: projects/harbor.md contains text shaped like a section boundary");
  });

  it("is deterministic: same inputs, same bytes", () => {
    expect(renderHandoff(inputs()).text).toBe(renderHandoff(inputs()).text);
  });
});

describe("assembleHandoff — the live entry", () => {
  function seed(fileEntries: Record<string, string>) {
    __setCache({
      files: files(fileEntries),
      sidecar: new Map(),
      sha: "deadbeefcafe0000",
      bytes: 0,
      fetchedAt: Date.now(),
    });
  }

  it("refuses an unknown project with the closest real names — the honest miss, never an empty success", async () => {
    seed({ "projects/harbor.md": "page", "projects/kiln.md": "page" });
    await expect(assembleHandoff("harbo")).rejects.toThrow(/no project page projects\/harbo\.md.*closest: harbor, kiln/);
  });

  it("refuses an empty project name", async () => {
    await expect(assembleHandoff("   ")).rejects.toThrow(/project is required/);
  });

  it("assembles a real project even with no bubble store, no graph and no scores — page plus honesty", async () => {
    seed({ "projects/harbor.md": "# Harbor\n\nthe page" });
    const text = await assembleHandoff("harbor");
    expect(text).toContain("the page");
    expect(text).toContain("WHY: the project page");
    expect(text).toContain("bubble absent on this deploy");
    expect(text).toContain("connections graph unavailable");
    expect(text).toMatch(/included 1 of 1 candidate pieces/);
  });

  it("clamps a caller budget below the floor instead of assembling nothing", async () => {
    seed({ "projects/harbor.md": `# Harbor\n\n${"y".repeat(3000)}` });
    const text = await assembleHandoff("harbor", 1);
    expect(text).toContain("of 4.0 KB budget");
  });
});
