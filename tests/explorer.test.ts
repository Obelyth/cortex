import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { DATED_ENTRY } from "../lib/health";
import { monthKey } from "../lib/digest";
import {
  ALSO_CAP,
  DATED_RECORD,
  FIND_MIN,
  buildExplorer,
  findAlso,
  flattenRows,
  isFinding,
  stampOf,
  type ExplorerHeat,
  type ExplorerNote,
  type SkippedFile,
} from "../lib/explorer";

/**
 * The explorer's tree, held still with invented notes. Every rule the Ask screen leans on —
 * role order, the router's month collapse, history by source page, the four sorts, the find,
 * the stamp cell, the marks from the last answer, archive/ outside the searchable set — is a
 * pure function of these fixtures, so a regression here fails before the screen is opened.
 *
 * Invented paths only: the export gate (tests/no-brain-leakage.test.ts) forbids a real note
 * name anywhere in shipped source.
 */
const NOW = new Date("2026-09-05T12:00:00Z");

const note = (path: string, over: Partial<ExplorerNote> = {}): ExplorerNote => ({
  path,
  title: `Title of ${path}`,
  tokens: 1000,
  retracted: 0,
  age: 3,
  decays: true,
  ...over,
});

const notes: ExplorerNote[] = [
  note("profile.md", { tokens: 1100 }),
  note("projects/example-fixture.md", { tokens: 18_900, retracted: 2, age: 1 }),
  note("projects/example-two.md", { tokens: 2000, age: 30 }),
  note("notes/example-1.md", { title: "Harbor soundings", tokens: 700, age: 3 }),
  note("notes/example-2.md", { tokens: 900, age: 20 }),
  note("notes/example-3.md", { tokens: 400, age: 30, decays: false }),
  note("notes/example-4.md", { tokens: 300, age: null }),
  note("log/2026-09-01.md", { tokens: 250, age: 4 }),
  note("log/2026-09-03.md", { tokens: 320, age: 2 }),
  note("log/2026-08-12.md", { tokens: 260, age: 24 }),
  note("log/2026-08-30.md", { tokens: 280, age: 6 }),
  note("history/example-fixture-2026-08-1.md", { tokens: 5000, age: 20 }),
  note("history/example-fixture-2026-08-2.md", { tokens: 4000, age: 20 }),
  note("history/example-two-2026-07.md", { tokens: 6000, age: null }),
  note("people/example.md", { tokens: 150 }),
];

const tile = (path: string, over: Partial<ExplorerHeat> = {}): ExplorerHeat => ({
  path,
  temperature: "cold",
  score: 0.1,
  reads: 0,
  seat: null,
  pinned: null,
  pinReason: "",
  ...over,
});

const heat: ExplorerHeat[] = [
  tile("profile.md", { temperature: "hot", score: 0.95, reads: 40, seat: "profile" }),
  tile("projects/example-fixture.md", { temperature: "hot", score: 0.92, reads: 64, seat: "router", pinned: "hot", pinReason: "the product page" }),
  tile("projects/example-two.md", { temperature: "warm", score: 0.5, reads: 6, seat: "router" }),
  tile("notes/example-1.md", { temperature: "warm", score: 0.45, reads: 5, seat: "router" }),
  tile("notes/example-2.md", { temperature: "cold", score: 0.2 }),
  tile("notes/example-3.md", { temperature: "cold", score: 0.05, pinned: "cold", pinReason: "settled" }),
  // notes/example-4.md has no tile at all: unscored.
  tile("log/2026-09-03.md", { seat: "recent" }),
];

const skipped: SkippedFile[] = [
  { path: "archive/example-old-2.md", bytes: 8000 },
  { path: "archive/example-old-1.md", bytes: 4000 },
];

const build = (opts: Parameters<typeof buildExplorer>[3] = {}) => buildExplorer(notes, heat, skipped, { now: NOW, ...opts });

describe("buildExplorer — role order, not the alphabet", () => {
  const x = build();

  it("files the directories in the seat's order, unknown ones after history/, archive/ last", () => {
    expect(x.groups.map((g) => g.key)).toEqual(["root", "projects", "notes", "log", "history", "people", "archive"]);
    expect(x.groups.map((g) => g.label)).toEqual(["root", "projects/", "notes/", "log/", "history/", "people/", "archive/"]);
  });

  it("opens projects/, notes/, log/ and history/; keeps archive/ closed and off", () => {
    const open = Object.fromEntries(x.groups.map((g) => [g.key, g.open]));
    expect(open).toMatchObject({ root: true, projects: true, notes: true, log: true, history: true, archive: false });
    expect(x.groups.find((g) => g.key === "archive")).toMatchObject({ off: true, kind: "archive", unit: "files", count: 2 });
  });

  it("counts the whole corpus once — live notes only, archive/ never in the total", () => {
    expect(x.total).toBe(notes.length);
    expect(x.shown).toBe(notes.length);
    expect(x.finding).toBe(false);
    expect(x.skipped).toBe(2);
    expect(x).toMatchObject({ hot: 2, warm: 2, cold: 3, seat: 5, retracted: 2, retractedNotes: 1 });
  });

  it("lists every live row once in tree order", () => {
    const paths = flattenRows(x.groups).map((r) => r.path);
    expect(paths).toHaveLength(notes.length + skipped.length);
    expect(new Set(paths).size).toBe(paths.length);
    expect(paths.slice(0, 3)).toEqual(["profile.md", "projects/example-fixture.md", "projects/example-two.md"]);
  });
});

describe("log/ collapses by month exactly as the router does", () => {
  const log = build().groups.find((g) => g.key === "log")!;

  it("one month row per monthKey(), newest month first, the days newest first inside", () => {
    expect(log.groups.map((m) => m.key)).toEqual(["log/2026-09", "log/2026-08"]);
    expect(log.groups.map((m) => m.key)).toEqual([...new Set(notes.filter((n) => n.path.startsWith("log/")).map((n) => monthKey(n.path)))].sort().reverse());
    expect(log.groups[0].rows.map((r) => r.path)).toEqual(["log/2026-09-03.md", "log/2026-09-01.md"]);
    expect(log.groups[1].rows.map((r) => r.path)).toEqual(["log/2026-08-30.md", "log/2026-08-12.md"]);
  });

  it("opens only the current month; the month row says it is one router row; the log row counts months", () => {
    expect(log.groups.map((m) => [m.label, m.open, m.extra])).toEqual([["2026-09", true, "one router row"], ["2026-08", false, "one router row"]]);
    expect(log.extra).toBe("2 months");
    expect(log.count).toBe(4);
    expect(log.unit).toBe("days");
    expect(log.rows).toEqual([]);
  });

  it("a day sits at depth 2 under its month at depth 1", () => {
    expect(log.groups[0].depth).toBe(1);
    expect(log.groups[0].rows[0].depth).toBe(2);
  });
});

describe("history/ collapses by source page", () => {
  const hist = build().groups.find((g) => g.key === "history")!;

  it("one page row per historyPageName(), parts in order, closed, labelled with the page it split from", () => {
    expect(hist.groups.map((p) => [p.label, p.open, p.extra, p.rows.map((r) => r.path)])).toEqual([
      ["example-fixture", false, "split from projects/example-fixture.md", ["history/example-fixture-2026-08-1.md", "history/example-fixture-2026-08-2.md"]],
      ["example-two", false, "split from projects/example-two.md", ["history/example-two-2026-07.md"]],
    ]);
    expect(hist.extra).toBe("2 pages");
    expect(hist.count).toBe(3);
    expect(hist.tokens).toBe(15_000);
  });
});

describe("the group's ledger line", () => {
  it("counts notes, tokens, stale, retracted and the three temperatures", () => {
    const pj = build().groups.find((g) => g.key === "projects")!;
    expect(pj).toMatchObject({ count: 2, tokens: 20_900, stale: 1, retracted: 2, hot: 1, warm: 1, cold: 0, read: 0 });
  });

  it("counts read and cited rows as read, never a cut one", () => {
    const x = build({ marks: { "projects/example-fixture.md": { kind: "cited", rank: 1 }, "projects/example-two.md": { kind: "read", rank: 2 }, "notes/example-1.md": { kind: "cut", by: "log-cap" } } });
    expect(x.groups.find((g) => g.key === "projects")!.read).toBe(2);
    expect(x.groups.find((g) => g.key === "notes")!.read).toBe(0);
    expect(x.read).toBe(2);
    const row = flattenRows(x.groups).find((r) => r.path === "notes/example-1.md")!;
    expect(row.mark).toEqual({ kind: "cut", by: "log-cap" });
  });
});

describe("the row's facts", () => {
  const rows = new Map(flattenRows(build().groups).map((r) => [r.path, r]));

  it("takes temperature, score, seat, reads and the pin from the heat tile; unscored when there is none", () => {
    expect(rows.get("projects/example-fixture.md")).toMatchObject({ temp: "hot", score: 0.92, seat: "router", reads: 64, pin: { temperature: "hot", reason: "the product page" } });
    expect(rows.get("notes/example-4.md")).toMatchObject({ temp: null, score: null, seat: null, reads: 0, pin: null });
    expect(rows.get("log/2026-09-03.md")).toMatchObject({ seat: "recent" });
  });

  it("names the leaf, the directory and the title", () => {
    expect(rows.get("notes/example-1.md")).toMatchObject({ leaf: "example-1.md", dir: "notes", title: "Harbor soundings", depth: 1, off: false });
    expect(rows.get("profile.md")).toMatchObject({ leaf: "profile.md", dir: "root" });
  });
});

describe("the stamp cell", () => {
  it("fresh within 14 days, stale past them, dim when the note says decays: false", () => {
    expect(stampOf(note("notes/a.md", { age: 14 }), 14)).toEqual({ kind: "fresh", days: 14 });
    expect(stampOf(note("notes/a.md", { age: 15 }), 14)).toEqual({ kind: "stale", days: 15 });
    expect(stampOf(note("notes/a.md", { age: 40, decays: false }), 14)).toEqual({ kind: "settled", days: 40 });
  });

  it("a dated record's stamp cannot go stale; a note with no stamp makes no claim", () => {
    expect(stampOf(note("log/2026-08-12.md", { age: 24 }), 14)).toEqual({ kind: "rec", days: 24 });
    expect(stampOf(note("notes/a.md", { age: null }), 14)).toEqual({ kind: "none", days: null });
  });

  it("mirrors lib/health.ts DATED_ENTRY exactly — the two sources cannot drift", () => {
    expect(DATED_RECORD.source).toBe(DATED_ENTRY.source);
    expect(DATED_RECORD.flags).toBe(DATED_ENTRY.flags);
  });

  it("lands on the rows: stale is amber, settled is dim, the log is a record", () => {
    const rows = new Map(flattenRows(build().groups).map((r) => [r.path, r.stamp]));
    expect(rows.get("notes/example-2.md")).toEqual({ kind: "stale", days: 20 });
    expect(rows.get("notes/example-3.md")).toEqual({ kind: "settled", days: 30 });
    expect(rows.get("notes/example-4.md")).toEqual({ kind: "none", days: null });
    expect(rows.get("log/2026-08-12.md")).toEqual({ kind: "rec", days: 24 });
    expect(build().stale).toBe(4); // example-two, example-2, the two history parts
  });
});

describe("sort within a directory", () => {
  const notesOf = (sort: "name" | "heat" | "size" | "stamp") =>
    build({ sort }).groups.find((g) => g.key === "notes")!.rows.map((r) => r.path);

  it("name is the default and is stable", () => {
    expect(notesOf("name")).toEqual(["notes/example-1.md", "notes/example-2.md", "notes/example-3.md", "notes/example-4.md"]);
    expect(build().groups.find((g) => g.key === "notes")!.rows.map((r) => r.path)).toEqual(notesOf("name"));
  });

  it("heat: score descending, unscored last", () => {
    expect(notesOf("heat")).toEqual(["notes/example-1.md", "notes/example-2.md", "notes/example-3.md", "notes/example-4.md"]);
    const pj = build({ sort: "heat" }).groups.find((g) => g.key === "projects")!.rows.map((r) => r.path);
    expect(pj).toEqual(["projects/example-fixture.md", "projects/example-two.md"]);
  });

  it("size: tokens descending", () => {
    expect(notesOf("size")).toEqual(["notes/example-2.md", "notes/example-1.md", "notes/example-3.md", "notes/example-4.md"]);
  });

  it("stamp: oldest stamp first, a note with no stamp last", () => {
    expect(notesOf("stamp")).toEqual(["notes/example-3.md", "notes/example-2.md", "notes/example-1.md", "notes/example-4.md"]);
  });

  it("a month's days stay newest first under every sort that ties", () => {
    const sept = build({ sort: "name" }).groups.find((g) => g.key === "log")!.groups[0].rows.map((r) => r.path);
    expect(sept).toEqual(["log/2026-09-03.md", "log/2026-09-01.md"]);
  });
});

describe("find — local, over paths and titles", () => {
  it("bites from the second character", () => {
    expect(FIND_MIN).toBe(2);
    expect(isFinding("e")).toBe(false);
    expect(isFinding(" ex ")).toBe(true);
    expect(build({ find: "e" }).finding).toBe(false);
    expect(build({ find: "e" }).shown).toBe(notes.length);
  });

  it("keeps matching rows with their ancestors and drops directories with nothing", () => {
    const x = build({ find: "example-2" });
    expect(x.finding).toBe(true);
    expect(x.shown).toBe(1);
    expect(x.total).toBe(notes.length);
    expect(x.groups.map((g) => g.key)).toEqual(["notes"]);
    expect(x.groups[0].rows.map((r) => r.path)).toEqual(["notes/example-2.md"]);
  });

  it("matches a title, case-insensitively", () => {
    const x = build({ find: "HARBOR" });
    expect(flattenRows(x.groups).map((r) => r.path)).toEqual(["notes/example-1.md"]);
  });

  it("opens a month or a page that holds a match", () => {
    const x = build({ find: "2026-08-12" });
    const log = x.groups.find((g) => g.key === "log")!;
    expect(log.groups.map((m) => [m.key, m.open])).toEqual([["log/2026-08", true]]);
    const y = build({ find: "2026-08-2" });
    expect(y.groups.find((g) => g.key === "history")!.groups[0].open).toBe(true);
  });

  it("never searches archive/ — a find shows the reader's view only", () => {
    const x = build({ find: "example-old" });
    expect(x.groups).toEqual([]);
    expect(x.shown).toBe(0);
    expect(build({ find: "ex" }).groups.some((g) => g.key === "archive")).toBe(false);
  });
});

describe("?note= reveals a row", () => {
  it("opens the month a revealed day-log sits in, and the page a revealed part belongs to", () => {
    const x = build({ reveal: "log/2026-08-12.md" });
    expect(x.groups.find((g) => g.key === "log")!.groups.map((m) => [m.key, m.open])).toEqual([["log/2026-09", true], ["log/2026-08", true]]);
    const y = build({ reveal: "history/example-two-2026-07.md" });
    expect(y.groups.find((g) => g.key === "history")!.groups.map((p) => [p.label, p.open])).toEqual([["example-fixture", false], ["example-two", true]]);
  });
});

describe("archive/ — outside the reader tier", () => {
  it("lists the files dim, name-sorted, with no temperature, seat, stamp or pin, sized from bytes", () => {
    const a = build().groups.find((g) => g.key === "archive")!;
    expect(a.extra).toBe("outside the reader tier — never narrowed, never read, never cited");
    expect(a.rows.map((r) => r.path)).toEqual(["archive/example-old-1.md", "archive/example-old-2.md"]);
    expect(a.rows[0]).toMatchObject({ off: true, temp: null, seat: null, stamp: { kind: "none", days: null }, pin: null, tokens: 1000, title: "example-old-1" });
    expect(a.hot + a.warm + a.cold).toBe(0);
  });

  it("says so when the listing could not be made, rather than showing an empty archive/", () => {
    const x = buildExplorer(notes, heat, null, { now: NOW });
    const a = x.groups.find((g) => g.key === "archive")!;
    expect(x.skipped).toBeNull();
    expect(a.count).toBe(0);
    expect(a.extra).toMatch(/not listed this render/);
  });
});

describe("findAlso — units and tools under the input", () => {
  const units = [
    { id: "groundskeeper", name: "Brain groundskeeper", state: "Succeeded" },
    { id: "canary", name: "Site canary", state: "Running" },
    { id: "workstation-test", name: "Test workstation", state: "Seen" },
  ];
  const tools = [
    { name: "brain_ask", doors: "trusted · guest" },
    { name: "brain_write", doors: "trusted" },
    { name: "brain_capture", doors: "trusted" },
  ];

  it("matches a unit by name or id and a tool by name, units first, each in name order", () => {
    expect(findAlso("brain", units, tools)).toEqual({
      rows: [
        { kind: "unit", id: "groundskeeper", title: "Brain groundskeeper", meta: "Succeeded" },
        { kind: "tool", id: "brain_ask", title: "brain_ask", meta: "trusted · guest" },
        { kind: "tool", id: "brain_capture", title: "brain_capture", meta: "trusted" },
        { kind: "tool", id: "brain_write", title: "brain_write", meta: "trusted" },
      ],
      total: 4,
    });
    expect(findAlso("station", units, tools).rows.map((r) => r.id)).toEqual(["workstation-test"]);
  });

  it("is empty below the find threshold and caps the strip at eight while counting the rest", () => {
    expect(findAlso("b", units, tools)).toEqual({ rows: [], total: 0 });
    const many = Array.from({ length: 12 }, (_, i) => ({ name: `brain_tool_${i}`, doors: "trusted" }));
    const r = findAlso("brain", [], many);
    expect(ALSO_CAP).toBe(8);
    expect(r.rows).toHaveLength(8);
    expect(r.total).toBe(12);
  });
});

describe("the module stays client-safe", () => {
  it("imports nothing from node or React — the same tree builds on the server and in the browser", () => {
    const src = readFileSync("lib/explorer.ts", "utf8");
    expect(src).not.toMatch(/from "node:/);
    expect(src).not.toMatch(/from "react/);
    expect(src).not.toMatch(/from "\.\/(corpus|health|heat|github|mirror)"/);
  });
});
