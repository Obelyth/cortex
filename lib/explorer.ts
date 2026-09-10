/**
 * explorer — the live corpus as a file tree, for the console's Ask screen (v2, 2026-09-05).
 *
 * Pure: notes in, groups out. No store, no React, no node imports, so the same function builds
 * the tree on the server for the first paint and on the client for every keystroke of the find
 * filter, and tests/explorer.test.ts can hold every rule still with fixtures.
 *
 * THE ORDER IS THE SEAT'S, NOT THE ALPHABET'S. root · projects/ · notes/ · log/ · history/ ·
 * archive/ is the order the router values directories (lib/frontmatter.ts ORDER) and the order
 * a newcomer should learn them; alphabetical would put the dead directory first.
 *
 * log/ COLLAPSES BY MONTH EXACTLY AS THE ROUTER DOES — monthKey() from lib/digest.ts, the same
 * function buildRouter spends one row per month on — so a month row here is one router row
 * there. history/ collapses by source page (historyPageName), the parts in order.
 *
 * archive/ IS SHOWN AND NEVER SEARCHED. Its rows come from listSkipped() (paths and bytes, no
 * text, no temperature, no stamp) and are typed apart from live notes so nothing downstream can
 * confuse the two; the find filter skips the group entirely. It is on the screen so "the brain
 * does not know" can be told apart from "the brain filed it away".
 */
import { historyPageName, isLogPath, monthKey } from "./digest";

export type Temp = "hot" | "warm" | "cold";
export type SeatKind = "profile" | "recent" | "router" | null;
export type ExplorerSort = "name" | "heat" | "size" | "stamp";

/** What the explorer needs of a live note — lib/health.ts NoteRow, slimmed for the client. */
export interface ExplorerNote {
  path: string;
  title: string;
  tokens: number;
  retracted: number;
  /** Days since `_Facts last verified_`, or null when the note makes no claim. */
  age: number | null;
  /** False when the note says `decays: false` — settled history, its stamp cannot go stale. */
  decays: boolean;
}

/** What the explorer needs of a heat tile — lib/heat.ts HeatTile, slimmed for the client. */
export interface ExplorerHeat {
  path: string;
  temperature: Temp | null;
  score: number | null;
  reads: number;
  seat: SeatKind;
  pinned: Temp | null;
  pinReason: string;
}

/** One file outside the reader tier: lib/corpus.ts SkippedFile. Path and size, no text. */
export interface SkippedFile {
  path: string;
  bytes: number;
}

/** A row's relation to the last answer: read (in the pack), cited (the quoted note), or cut
 *  (scored, refused by a cap). */
export type Mark =
  | { kind: "read"; rank: number }
  | { kind: "cited"; rank: number }
  | { kind: "cut"; by: string };

export interface ExplorerOpts {
  sort?: ExplorerSort;
  /** The find filter: a case-insensitive substring over path and title. Two characters or
   *  more; shorter is "no filter", so a first keystroke does not blank the tree. */
  find?: string;
  /** Today, for the current month and nothing else. */
  now?: Date;
  marks?: Record<string, Mark>;
  /** A path whose ancestors must be open — the `?note=` target. */
  reveal?: string | null;
  /** Days after which a decaying stamp is stale. lib/health.ts's own threshold. */
  staleDays?: number;
}

/**
 * The stamp cell. `fresh` and `stale` count days; `settled` counts them dimly (decays: false);
 * `rec` is a dated record whose stamp cannot go stale; `none` is a note that makes no claim.
 */
export interface Stamp {
  kind: "fresh" | "stale" | "settled" | "rec" | "none";
  days: number | null;
}

export interface ExplorerRow {
  path: string;
  leaf: string;
  dir: string;
  title: string;
  depth: number;
  temp: Temp | null;
  score: number | null;
  seat: SeatKind;
  reads: number;
  stamp: Stamp;
  retracted: number;
  tokens: number;
  pin: { temperature: Temp; reason: string } | null;
  mark: Mark | null;
  /** True for an archive/ row: outside the reader tier, no temperature, no stamp. */
  off: boolean;
}

export interface ExplorerGroup {
  key: string;
  label: string;
  kind: "dir" | "month" | "page" | "archive";
  depth: number;
  open: boolean;
  off: boolean;
  /** The noun the count takes: notes · days · parts · files. */
  unit: string;
  count: number;
  tokens: number;
  read: number;
  stale: number;
  retracted: number;
  hot: number;
  warm: number;
  cold: number;
  /** A trailing clause for the group's ledger line, or null. */
  extra: string | null;
  rows: ExplorerRow[];
  groups: ExplorerGroup[];
}

export interface Explorer {
  groups: ExplorerGroup[];
  /** Live notes in the corpus, and how many the filter left showing. */
  total: number;
  shown: number;
  finding: boolean;
  hot: number;
  warm: number;
  cold: number;
  seat: number;
  stale: number;
  retracted: number;
  retractedNotes: number;
  read: number;
  /** archive/ files, or null when the listing could not be made this render. */
  skipped: number | null;
}

/** The directories in the order the seat values them. Anything else files after history/. */
const ORDER = ["root", "projects", "notes", "log", "history"];

/**
 * A note whose filename is a date is a record OF that date. Mirrors DATED_ENTRY in
 * lib/health.ts (which this client-safe module cannot import); tests/explorer.test.ts holds the
 * two sources equal.
 */
export const DATED_RECORD = /(^|\/)\d{4}-\d{2}-\d{2}\.md$/;

/** Two characters before the filter bites, so the first keystroke does not blank the tree. */
export const FIND_MIN = 2;

export function stampOf(n: ExplorerNote, staleDays: number): Stamp {
  if (DATED_RECORD.test(n.path)) return { kind: "rec", days: n.age };
  if (n.age === null) return { kind: "none", days: null };
  if (!n.decays) return { kind: "settled", days: n.age };
  return { kind: n.age > staleDays ? "stale" : "fresh", days: n.age };
}

function leafOf(path: string): string {
  return path.split("/").pop() ?? path;
}

function dirOf(path: string): string {
  return path.includes("/") ? path.split("/")[0] : "root";
}

/** Sort rows within one directory. `name` is stable; a month's days run newest first. */
function sortRows(rows: ExplorerRow[], sort: ExplorerSort, newestFirst: boolean): ExplorerRow[] {
  const byName = (a: ExplorerRow, b: ExplorerRow) =>
    newestFirst ? b.path.localeCompare(a.path) : a.path.localeCompare(b.path);
  const out = [...rows];
  switch (sort) {
    case "heat":
      // Score desc, unscored last, then name.
      out.sort((a, b) => (b.score ?? -1) - (a.score ?? -1) || byName(a, b));
      break;
    case "size":
      out.sort((a, b) => b.tokens - a.tokens || byName(a, b));
      break;
    case "stamp":
      // Oldest stamp first; a note with no stamp (or a dated record) last.
      out.sort((a, b) => {
        const ad = a.stamp.kind === "none" || a.stamp.kind === "rec" ? -1 : (a.stamp.days ?? -1);
        const bd = b.stamp.kind === "none" || b.stamp.kind === "rec" ? -1 : (b.stamp.days ?? -1);
        return bd - ad || byName(a, b);
      });
      break;
    default:
      out.sort(byName);
  }
  return out;
}

function ledger(g: ExplorerGroup): ExplorerGroup {
  const all = [...g.rows, ...g.groups.flatMap((s) => collectRows(s))];
  g.count = all.length;
  g.tokens = all.reduce((a, r) => a + r.tokens, 0);
  g.read = all.filter((r) => r.mark?.kind === "read" || r.mark?.kind === "cited").length;
  g.stale = all.filter((r) => r.stamp.kind === "stale").length;
  g.retracted = all.reduce((a, r) => a + r.retracted, 0);
  g.hot = all.filter((r) => r.temp === "hot").length;
  g.warm = all.filter((r) => r.temp === "warm").length;
  g.cold = all.filter((r) => r.temp === "cold").length;
  return g;
}

function collectRows(g: ExplorerGroup): ExplorerRow[] {
  return [...g.rows, ...g.groups.flatMap(collectRows)];
}

function group(
  key: string,
  label: string,
  kind: ExplorerGroup["kind"],
  depth: number,
  unit: string,
  open: boolean,
  rows: ExplorerRow[],
  groups: ExplorerGroup[] = [],
  extra: string | null = null,
  off = false
): ExplorerGroup {
  return ledger({ key, label, kind, depth, open, off, unit, count: 0, tokens: 0, read: 0, stale: 0, retracted: 0, hot: 0, warm: 0, cold: 0, extra, rows, groups });
}

/**
 * The tree. `notes` is the live corpus (health.notes); `heat` its tiles, by path; `skipped` the
 * archive/ listing or null when it could not be made.
 */
export function buildExplorer(
  notes: ExplorerNote[],
  heat: ExplorerHeat[],
  skipped: SkippedFile[] | null,
  opts: ExplorerOpts = {}
): Explorer {
  const sort = opts.sort ?? "name";
  const staleDays = opts.staleDays ?? 14;
  const marks = opts.marks ?? {};
  const now = opts.now ?? new Date();
  const thisMonth = `log/${now.toISOString().slice(0, 7)}`;
  const needle = (opts.find ?? "").trim().toLowerCase();
  const finding = needle.length >= FIND_MIN;
  const reveal = opts.reveal ?? null;

  const heatBy = new Map(heat.map((h) => [h.path, h]));
  const rows: ExplorerRow[] = notes.map((n) => {
    const h = heatBy.get(n.path);
    return {
      path: n.path,
      leaf: leafOf(n.path),
      dir: dirOf(n.path),
      title: n.title,
      depth: 1,
      temp: h?.temperature ?? null,
      score: h?.score ?? null,
      seat: h?.seat ?? null,
      reads: h?.reads ?? 0,
      stamp: stampOf(n, staleDays),
      retracted: n.retracted,
      tokens: n.tokens,
      pin: h?.pinned ? { temperature: h.pinned, reason: h.pinReason } : null,
      mark: marks[n.path] ?? null,
      off: false,
    };
  });

  const matches = (r: ExplorerRow) =>
    !finding || r.path.toLowerCase().includes(needle) || r.title.toLowerCase().includes(needle);
  const kept = rows.filter(matches);
  const byDir = new Map<string, ExplorerRow[]>();
  for (const r of kept) (byDir.get(r.dir) ?? byDir.set(r.dir, []).get(r.dir)!).push(r);

  const revealDir = reveal ? dirOf(reveal) : null;
  const revealMonth = reveal ? monthKey(reveal) : null;
  const revealPage = reveal ? historyPageName(reveal) : null;

  const groups: ExplorerGroup[] = [];
  const dirs = [...ORDER, ...[...byDir.keys()].filter((d) => !ORDER.includes(d)).sort()];
  for (const dir of dirs) {
    const mine = byDir.get(dir) ?? [];
    if (mine.length === 0) continue;
    if (dir === "root") {
      groups.push(group("root", "root", "dir", 0, "note", true, sortRows(mine, sort, false)));
    } else if (dir === "log") {
      const months = new Map<string, ExplorerRow[]>();
      const loose: ExplorerRow[] = [];
      for (const r of mine) {
        const m = isLogPath(r.path) ? monthKey(r.path) : null;
        if (m) (months.get(m) ?? months.set(m, []).get(m)!).push({ ...r, depth: 2 });
        else loose.push(r);
      }
      const monthGroups = [...months]
        .sort((a, b) => b[0].localeCompare(a[0]))
        .map(([m, days]) =>
          group(m, m.slice("log/".length), "month", 1, "days", finding || m === thisMonth || m === revealMonth, sortRows(days, sort, true), [], "one router row")
        );
      groups.push(group("log", "log/", "dir", 0, "days", true, sortRows(loose, sort, true), monthGroups, `${months.size} month${months.size === 1 ? "" : "s"}`));
    } else if (dir === "history") {
      const pages = new Map<string, ExplorerRow[]>();
      const loose: ExplorerRow[] = [];
      for (const r of mine) {
        const p = historyPageName(r.path);
        if (p) (pages.get(p) ?? pages.set(p, []).get(p)!).push({ ...r, depth: 2 });
        else loose.push(r);
      }
      const pageGroups = [...pages]
        .sort((a, b) => a[0].localeCompare(b[0]))
        .map(([p, parts]) =>
          group(`history/${p}`, p, "page", 1, "parts", finding || p === revealPage, sortRows(parts, sort, false), [], `split from projects/${p}.md`)
        );
      groups.push(group("history", "history/", "dir", 0, "parts", true, sortRows(loose, sort, false), pageGroups, `${pages.size} page${pages.size === 1 ? "" : "s"}`));
    } else {
      groups.push(group(dir, `${dir}/`, "dir", 0, "notes", true, sortRows(mine, sort, false)));
    }
  }
  // A revealed note's directory is open whatever the default; every top directory is open
  // already, so this only matters for a directory this list does not name.
  for (const g of groups) if (g.key === revealDir) g.open = true;

  // archive/ — never in the searchable set: a find shows the reader's view only.
  if (!finding) {
    const files = skipped ?? [];
    const archiveRows: ExplorerRow[] = files.map((f) => ({
      path: f.path,
      leaf: leafOf(f.path),
      dir: "archive",
      title: leafOf(f.path).replace(/\.md$/i, ""),
      depth: 1,
      temp: null,
      score: null,
      seat: null,
      reads: 0,
      stamp: { kind: "none", days: null },
      retracted: 0,
      tokens: Math.round(f.bytes / 4),
      pin: null,
      mark: null,
      off: true,
    }));
    groups.push(
      group(
        "archive",
        "archive/",
        "archive",
        0,
        "files",
        false,
        sortRows(archiveRows, sort === "heat" || sort === "stamp" ? "name" : sort, false),
        [],
        skipped === null
          ? "not listed this render — git did not answer; the reader tier is unaffected"
          : "outside the reader tier — never narrowed, never read, never cited",
        true
      )
    );
  }

  return {
    groups,
    total: rows.length,
    shown: kept.length,
    finding,
    hot: rows.filter((r) => r.temp === "hot").length,
    warm: rows.filter((r) => r.temp === "warm").length,
    cold: rows.filter((r) => r.temp === "cold").length,
    seat: rows.filter((r) => r.seat).length,
    stale: rows.filter((r) => r.stamp.kind === "stale").length,
    retracted: rows.reduce((a, r) => a + r.retracted, 0),
    retractedNotes: rows.filter((r) => r.retracted > 0).length,
    read: rows.filter((r) => r.mark?.kind === "read" || r.mark?.kind === "cited").length,
    skipped: skipped ? skipped.length : null,
  };
}

/** Every live row in tree order — the client's scroll-to and the tests' flat view. */
export function flattenRows(groups: ExplorerGroup[]): ExplorerRow[] {
  return groups.flatMap(collectRows);
}

/** Whether `q` is a find (two characters or more) rather than nothing. */
export function isFinding(q: string): boolean {
  return q.trim().length >= FIND_MIN;
}

/* ── The ALSO strip: units and tools a find matched ─────────────────────────────────────── */

/** An ops unit as the find sees it — lib/ops-board.ts BoardRow, slimmed for the client. */
export interface AlsoUnit {
  id: string;
  name: string;
  /** The register's state word, e.g. "Needs you". */
  state: string;
}

/** A tool from lib/tool-roster.json with what the strip says beside it. */
export interface AlsoTool {
  name: string;
  /** "trusted · guest" or "trusted" — which doors register it. */
  doors: string;
}

export interface AlsoRow {
  kind: "unit" | "tool";
  id: string;
  title: string;
  meta: string;
}

/** Jump rows the strip shows before it counts the rest — v2's cap. */
export const ALSO_CAP = 8;

/**
 * Units and tools have no directory, so a find lists them under the input rather than in the
 * tree. Same needle rule as the tree (FIND_MIN), same order every time: units by name, then
 * tools by name. `total` is the whole match so the strip can say "+n more".
 */
export function findAlso(q: string, units: AlsoUnit[], tools: AlsoTool[]): { rows: AlsoRow[]; total: number } {
  const needle = q.trim().toLowerCase();
  if (needle.length < FIND_MIN) return { rows: [], total: 0 };
  const rows: AlsoRow[] = [];
  for (const u of [...units].sort((a, b) => a.name.localeCompare(b.name))) {
    if (u.name.toLowerCase().includes(needle) || u.id.toLowerCase().includes(needle)) {
      rows.push({ kind: "unit", id: u.id, title: u.name, meta: u.state });
    }
  }
  for (const t of [...tools].sort((a, b) => a.name.localeCompare(b.name))) {
    if (t.name.toLowerCase().includes(needle)) rows.push({ kind: "tool", id: t.name, title: t.name, meta: t.doors });
  }
  return { rows: rows.slice(0, ALSO_CAP), total: rows.length };
}
