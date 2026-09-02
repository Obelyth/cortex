import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../lib/github", () => ({
  // assembleHeat and getContext both resolve the branch head before serving the corpus.
  // Answering with the fixture cache's own SHA makes loadCorpus return the seeded cache on its
  // clean path — the same arrangement brain.test.ts and handoff.test.ts use.
  gh: vi.fn(async () => ({ ok: true, json: async () => ({ sha: "deadbeefcafe0000" }) })),
  getFile: vi.fn(),
  putFile: vi.fn(),
  listTree: vi.fn(),
  repo: () => "owner/brain",
  branch: () => "main",
}));

import { __setCache } from "../lib/corpus";
import { __setBubbleStore } from "../lib/bubble";
import { __setStore, type ScoreRow } from "../lib/mirror";
import { __setHeatScores, assembleHeat, type HeatScoreRow } from "../lib/heat";
import { __setPinStore, type PinRow } from "../lib/pins";
import { routerCut, buildRouter, routerLine, type Temperature } from "../lib/frontmatter";
import { cutRecentDays, getContext } from "../lib/brain";

function seed(files: Record<string, string>) {
  __setCache({
    files: new Map(Object.entries(files)),
    sidecar: new Map(),
    sha: "deadbeefcafe0000",
    bytes: 0,
    fetchedAt: Date.now(),
  });
}

function scoreRow(path: string, over: Partial<HeatScoreRow> = {}): HeatScoreRow {
  return {
    path,
    reads: 0,
    last_read: null,
    access_score: 0,
    write_score: 0.5,
    dir_prior: 0.5,
    pinned: null,
    score: 0.3,
    temperature: "warm",
    ...over,
  };
}

beforeEach(() => {
  __setCache(null);
  __setBubbleStore(null);
  __setStore(null);
  __setHeatScores(null);
  __setPinStore(null);
});

afterEach(() => {
  __setCache(null);
  __setBubbleStore(undefined);
  __setStore(undefined);
  __setHeatScores(undefined);
  __setPinStore(undefined);
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

/* ── routerCut: the one definition of the seat ──────────────────────────────────────────── */

describe("routerCut", () => {
  const files = new Map(
    Object.entries({
      "profile.md": "the operator",
      "projects/harbor.md": "---\ndescription: \"the harbor\"\n---\n\nbody",
      "notes/soundings.md": "---\ndescription: \"depths\"\n---\n\nbody",
      "notes/frozen.md": "---\ndescription: \"old\"\n---\n\nbody",
    })
  );
  const temps = (m: Record<string, Temperature>) =>
    new Map(Object.entries(m).map(([k, v]) => [k, { temperature: v }]));

  it("keeps hot and warm, banishes cold to its own list — never silently", () => {
    const cut = routerCut(
      files,
      temps({ "profile.md": "hot", "projects/harbor.md": "hot", "notes/soundings.md": "warm", "notes/frozen.md": "cold" })
    );
    expect(cut.rendered.map((e) => e.path)).toEqual([
      "profile.md",
      "projects/harbor.md",
      "notes/soundings.md",
    ]);
    expect(cut.cold.map((e) => e.path)).toEqual(["notes/frozen.md"]);
    expect(cut.dropped).toEqual([]);
  });

  it("drops rows until the DOCUMENT fits the budget — wrapper bytes count too", () => {
    // The budget the boot call spends is buildRouter's whole output, not the row bytes alone —
    // the header, coverage line and `## <dir>` headings ride every render. Rows here are sized
    // like real ones (~190 bytes, longer than the "did not fit" line a drop adds), because on a
    // toy corpus of 50-byte rows a near-full budget is unsatisfiable — announcing the drop costs
    // more than the drop saves — and the cut correctly floors at one row instead of spinning.
    const long = new Map(
      Array.from({ length: 6 }, (_, i) => [
        `notes/row-${i}.md`,
        `---\ndescription: "${"A realistically sized description of note number " + i + ", the kind the live corpus actually carries, with enough words that one row outweighs the dropped-note line."}"\n---\n\nbody`,
      ])
    );
    const fullDoc = buildRouter(long, new Map());
    const budget = fullDoc.length - 1;
    const wrapped = buildRouter(long, new Map(), budget);
    expect(wrapped.length).toBeLessThanOrEqual(budget);
    const cut = routerCut(long, new Map(), budget);
    expect(cut.dropped.length).toBeGreaterThan(0);
    expect(cut.rendered.length).toBeGreaterThan(0); // never empty — the first row always renders
    expect(cut.rendered.length + cut.dropped.length).toBe(6); // nothing lost, only refused
  });

  it("a generous budget renders everything, and capped equals uncapped byte-for-byte", () => {
    const meta = temps({ "profile.md": "hot" });
    expect(buildRouter(files, meta, 10_000)).toBe(buildRouter(files, meta));
  });

  it("agrees with buildRouter on every count — the render is the cut, grouped", () => {
    const meta = temps({ "profile.md": "hot", "notes/frozen.md": "cold" });
    const cut = routerCut(files, meta, 10_000);
    const router = buildRouter(files, meta, 10_000);
    for (const e of cut.rendered) expect(router).toContain(routerLine(e));
    expect(router).toContain("_1 colder note not listed here");
  });
});

/* ── The seat figure: parity with the boot call itself ──────────────────────────────────── */

describe("assembleHeat seat parity", () => {
  it("reports the exact ~token figure getContext's own footer states", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-11T20:00:00Z"));
    seed({
      "profile.md": "# Profile\n\nthe operator, at length ".repeat(20),
      "projects/harbor.md": "---\ndescription: \"the harbor project\"\n---\n\nbody text",
      "notes/soundings.md": "---\ndescription: \"depth notes\"\n---\n\nmore body",
      "log/2026-08-10.md": "# Log 2026-08-10\n\n## 09:00 · harbor\n\nmoved the buoys",
    });
    const rows: ScoreRow[] = [
      { path: "profile.md", temperature: "hot", score: 0.9, reads: 4 },
      { path: "projects/harbor.md", temperature: "hot", score: 0.8, reads: 3 },
      { path: "notes/soundings.md", temperature: "warm", score: 0.3, reads: 1 },
      { path: "log/2026-08-10.md", temperature: "warm", score: 0.3, reads: 0 },
    ];
    // getContext reads temperatures through mirrorStore().scores(); the heat view reads the
    // same view with more columns. Both fakes answer from the same rows.
    __setStore({
      head: async () => null,
      all: async () => [],
      paths: async () => [],
      apply: async () => true,
      access: async () => {},
      scores: async () => rows,
    });
    __setHeatScores(async () =>
      rows.map((r) => scoreRow(r.path, { temperature: r.temperature, score: r.score, reads: r.reads }))
    );

    const ctx = await getContext();
    const stated = /~(\d+) tokens\./.exec(ctx);
    expect(stated).not.toBeNull();

    const heat = await assembleHeat();
    // The heat view recomputes the boot body from the same walks; the header number must be
    // the boot reply's own figure, not an estimate of it.
    expect(heat.seat.tokens).toBe(Number(stated![1]));
    expect(heat.seat.routerRows).toBe(4);
    expect(heat.seat.expandedDays).toEqual(["2026-08-10"]);
  });
});

/* ── Seat membership and pins on the tiles ──────────────────────────────────────────────── */

describe("assembleHeat tiles", () => {
  const files = {
    "profile.md": "the operator",
    "projects/harbor.md": "---\ndescription: \"the harbor\"\n---\n\nbody",
    "notes/soundings.md": "---\ndescription: \"depths\"\n---\n\nbody",
    "notes/frozen.md": "---\ndescription: \"old\"\n---\n\nbody",
  };

  it("marks profile, router rows and cold exclusion from the real cut", async () => {
    seed(files);
    __setHeatScores(async () => [
      scoreRow("profile.md", { temperature: "hot", reads: 5, access_score: 1 }),
      scoreRow("projects/harbor.md", { temperature: "hot", reads: 2 }),
      scoreRow("notes/soundings.md", { temperature: "warm", reads: 1 }),
      scoreRow("notes/frozen.md", { temperature: "cold" }),
    ]);
    const heat = await assembleHeat();
    const by = new Map(heat.tiles.map((t) => [t.path, t]));
    expect(by.get("profile.md")!.seat).toBe("profile");
    expect(by.get("projects/harbor.md")!.seat).toBe("router");
    expect(by.get("notes/soundings.md")!.seat).toBe("router");
    // Cold is OUT of the seat — that is the whole meaning of cold.
    expect(by.get("notes/frozen.md")!.seat).toBeNull();
    expect(heat.scoring).toBe("scored");
    expect(heat.coldStart).toBe(false);
    expect(heat.seat.coldRows).toBe(1);
  });

  it("carries pins with their reasons, scrubbed at egress", async () => {
    seed(files);
    __setHeatScores(async () => [scoreRow("notes/frozen.md", { temperature: "hot", pinned: "hot" })]);
    const pin: PinRow = {
      path: "notes/frozen.md",
      temperature: "hot",
      reason: "keep\u0000this · visible",
      pinned_at: "2026-08-11T00:00:00Z",
    };
    __setPinStore({ all: async () => [pin], set: async () => {}, clear: async () => {} });
    const heat = await assembleHeat();
    const t = heat.tiles.find((x) => x.path === "notes/frozen.md")!;
    expect(t.pinned).toBe("hot");
    // safeText: control characters stripped, the field separator neutralised.
    expect(t.pinReason).toBe("keep this - visible");
    expect(heat.pinsAvailable).toBe(true);
  });

  it("declares the cold start when scores exist but nothing was ever read", async () => {
    seed(files);
    __setHeatScores(async () => [scoreRow("profile.md"), scoreRow("projects/harbor.md")]);
    const heat = await assembleHeat();
    expect(heat.coldStart).toBe(true);
  });
});

/* ── Fallbacks: absent halves say so, nothing renders fake-cool ─────────────────────────── */

describe("assembleHeat fallbacks", () => {
  const files = { "profile.md": "the operator", "notes/a.md": "body" };

  it("with no SUPABASE_URL: scoring off, pins off, temperatures null — but the seat is real", async () => {
    vi.stubEnv("SUPABASE_URL", "");
    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "");
    seed(files);
    const heat = await assembleHeat();
    expect(heat.scoring).toBe("off");
    expect(heat.pinsAvailable).toBe(false);
    for (const t of heat.tiles) expect(t.temperature).toBeNull();
    // The seat still exists: with no scoring the router renders every row (unranked), which is
    // exactly what boot serves on a zero-env deploy.
    expect(heat.seat.routerRows).toBe(2);
    expect(heat.seat.ranked).toBe(false);
    expect(heat.seat.tokens).toBeGreaterThan(0);
  });

  it("when the store is configured but does not answer: 'unavailable', never invented", async () => {
    vi.stubEnv("SUPABASE_URL", "https://x.supabase.co");
    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "k");
    seed(files);
    __setHeatScores(async () => null);
    const heat = await assembleHeat();
    expect(heat.scoring).toBe("unavailable");
    expect(heat.coldStart).toBe(false);
  });

  it("when the mirror holds no scored rows yet: 'empty', not a fake-cool gradient", async () => {
    vi.stubEnv("SUPABASE_URL", "https://x.supabase.co");
    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "k");
    seed(files);
    __setHeatScores(async () => []);
    const heat = await assembleHeat();
    expect(heat.scoring).toBe("empty");
    for (const t of heat.tiles) expect(t.temperature).toBeNull();
  });
});

/* ── cutRecentDays stays the boot call's own walk ───────────────────────────────────────── */

describe("cutRecentDays", () => {
  it("expands under the budget and digests the rest, continuing past an oversized day", () => {
    const files = new Map([
      ["log/2026-08-11.md", "x".repeat(3000)],
      ["log/2026-08-10.md", "y".repeat(9000)],
      ["log/2026-08-09.md", "z".repeat(3000)],
    ]);
    const { expand, elide } = cutRecentDays(["2026-08-11", "2026-08-10", "2026-08-09"], files, 8000);
    expect(expand).toEqual(["2026-08-11", "2026-08-09"]);
    expect(elide).toEqual(["2026-08-10"]);
  });
});
