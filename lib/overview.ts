/**
 * overview — the Overview screen's view model (v2).
 *
 * Every figure the screen states is derived here from the loaders WIRING.md names, in plain
 * serialisable shapes the client islands can hold: the dot field (W08), the activity buckets and
 * the call windows the lens opens for them (W10 · L9), the doors (W13), how answers checked out
 * (W15). Nothing here invents a number a loader did not return — a missing source is a null the
 * screen names, never a zero.
 */
import type { CallRow, CallWindow } from "./calls";
import { CUT_STAMP, TIMED_OUT_STAMP } from "./deadline";
import { answeredFromMemory, stoppedByClock } from "./trends";
import type { NoteRow } from "./health";
import type { CommitInfo } from "./github";
import type { AccessPulse, MirrorPulse, TemperaturePulse } from "./pulse";

/** One relative-time dialect for every instrument on the screen. "just now" carries its own
 *  completeness — never "now ago"; an unparseable stamp is a dash, never "— ago". */
export function agoLabel(ms: number, now: number): string {
  const m = Math.floor((now - ms) / 60_000);
  if (m < 1) return "just now";
  if (m < 60) return `${m} min ago`;
  if (m < 2880) return `${Math.floor(m / 60)} hr ago`;
  return `${Math.floor(m / 1440)} d ago`;
}
export function agoIso(iso: string | null | undefined, now: number): string {
  if (!iso) return "—";
  const ts = new Date(iso).getTime();
  return Number.isFinite(ts) ? agoLabel(ts, now) : "—";
}

/** What the log can honestly claim to cover, as a caption. */
/** The covered window as a noun phrase, so a sentence can say "no calls in <this>". coversLabel
 *  reads as a clause ("log covers 40 min") and cannot be dropped into one. */
export function windowLabel(covers: number): string {
  if (covers < 60_000) return "the log so far";
  if (covers < 3_600_000) return `${Math.round(covers / 60_000)} min`;
  if (covers < 172_800_000) return `${Math.round(covers / 3_600_000)} hr`;
  return `${Math.round(covers / 86_400_000)} d`;
}

export function coversLabel(covers: number): string {
  if (covers < 60_000) return "log just started";
  if (covers < 3_600_000) return `log covers ${Math.round(covers / 60_000)} min`;
  if (covers < 172_800_000) return `log covers ${Math.round(covers / 3_600_000)} hr`;
  return `log covers ${Math.round(covers / 86_400_000)} d`;
}

/* ── W08 · the dot field ─────────────────────────────────────────────────── */

/** One mark per block in the corpus is the art; past this many the field reads as texture and
 *  the cap is stated in the caption rather than silently truncating. */
export const MARK_CAP = 1400;

/** What the lens says about a note (L1) — the row without its strip. */
export interface NoteLite {
  path: string;
  title: string;
  desc: string;
  dir: string;
  blocks: number;
  tokens: number;
  retracted: number;
  age: number | null;
}
export function noteLite(n: NoteRow): NoteLite {
  return { path: n.path, title: n.title, desc: n.desc, dir: n.dir, blocks: n.blocks, tokens: n.tokens, retracted: n.retracted, age: n.age };
}
export interface FieldNote extends NoteLite {
  /** The strip, cut at the cap: one char per mark, "." live, "x" retracted. */
  strip: string;
}
export interface DotField {
  notes: FieldNote[];
  shown: number;
  total: number;
  /** "all shown" or "first 1,400 of N shown" — the cap, stated. */
  capNote: string;
}

export function dotField(notes: NoteRow[], totalBlocks: number, cap = MARK_CAP): DotField {
  const out: FieldNote[] = [];
  let shown = 0;
  for (const n of notes) {
    if (shown >= cap) break;
    const strip = n.strip.slice(0, cap - shown);
    if (!strip) continue;
    out.push({ ...noteLite(n), strip });
    shown += strip.length;
  }
  return {
    notes: out,
    shown,
    total: totalBlocks,
    capNote: shown < totalBlocks ? `first ${shown.toLocaleString()} of ${totalBlocks.toLocaleString()} shown` : "all shown",
  };
}

/* ── W10 · activity, and L9 · a window of calls ─────────────────────────── */

export interface AskRow { ts: number; stamp: string; model: string | null; ms: number; surface: string; cached: boolean }

/** What the lens says about a window of calls: the same rows the chart counted, summarised. */
export interface CallsWindow {
  total: number;
  asks: number;
  /** asks answered from memory: not NOT IN BRAIN, not ERROR, not stopped by the clock */
  mem: number;
  fresh: number;
  errors: number;
  /** asks the platform killed at the wall — a started row with no final row. */
  cut: number;
  /** asks the request deadline stopped inside the budget — the corpus did not load in time. */
  timedOut: number;
  p50ms: number | null;
  byTool: Array<[string, number]>;
  byDoor: Array<[string, number]>;
  /** The newest asks, capped — the lens lists them. */
  askRows: AskRow[];
}

const ASK_ROWS_CAP = 14;

export function callsWindow(rows: CallRow[]): CallsWindow {
  const asks = rows.filter((r) => r.tool === "brain_ask");
  const count = (key: (r: CallRow) => string): Array<[string, number]> => {
    const m = new Map<string, number>();
    for (const r of rows) m.set(key(r), (m.get(key(r)) ?? 0) + 1);
    return [...m.entries()].sort((a, b) => b[1] - a[1]);
  };
  // A cut-off row's ms is the platform wall, not a measurement, and a timed-out row's is time
  // spent not answering — neither is the latency of an answer, so both leave the figure.
  const ms = asks.filter((r) => !stoppedByClock(r.stamp)).map((r) => r.ms).sort((a, b) => a - b);
  return {
    total: rows.length,
    asks: asks.length,
    mem: asks.filter((r) => answeredFromMemory(r.stamp)).length,
    fresh: asks.filter((r) => r.stamp === "NOT IN BRAIN").length,
    errors: asks.filter((r) => r.stamp === "ERROR").length,
    cut: asks.filter((r) => r.stamp === CUT_STAMP).length,
    timedOut: asks.filter((r) => r.stamp === TIMED_OUT_STAMP).length,
    p50ms: ms.length ? ms[Math.floor((ms.length - 1) / 2)] : null,
    byTool: count((r) => r.tool),
    byDoor: count((r) => r.surface),
    askRows: [...asks]
      .sort((a, b) => b.ts - a.ts)
      .slice(0, ASK_ROWS_CAP)
      .map((r) => ({ ts: r.ts, stamp: r.stamp, model: r.model ?? null, ms: r.ms, surface: r.surface, cached: r.cached === true })),
  };
}

export interface Bucket {
  label: string;
  from: number;
  to: number;
  n: number;
  asks: number;
  win: CallsWindow;
}
export interface RangeData {
  buckets: Bucket[];
  ticks: string[];
  /** Null when the log covers the whole range; otherwise what it does cover. */
  note: string | null;
}
export type RangeKey = "day" | "week" | "month";
export interface Activity {
  day: RangeData;
  week: RangeData;
  month: RangeData;
  covers: number;
  durable: boolean;
  source: CallWindow["source"];
  /** The caveat under the chart: what the log covers, and whose log it is. */
  callsNote: string;
}

/** The fallback mode's caveat — the durable store has no instance boundary. */
export const ONE_INSTANCE = "one instance\u2019s view — the server runs several, and each keeps its own log";

export function callsNote(win: Pick<CallWindow, "covers" | "durable" | "source">): string {
  if (win.source === "unconfigured") return `no durable store — ${ONE_INSTANCE}`;
  if (win.source === "unreachable") return `store unreachable this render — ${ONE_INSTANCE}`;
  return `${coversLabel(win.covers)} · bars outside it are silence, not zero`;
}

/**
 * The one caveat line under the chart. The selected range carries its own coverage note when the
 * log is shorter than the range, and callsNote opens with the very same sentence whenever the
 * store is healthy — so printing both said "log covers 6 hr · log covers 6 hr · bars outside it
 * are silence, not zero". The range's note is prepended only when it adds something the log's
 * note does not already say.
 */
export function chartNote(rangeNote: string | null, note: string, total: number): string {
  const lead = rangeNote && total > 0 && !note.startsWith(rangeNote) ? `${rangeNote} · ` : "";
  return `${lead}${note}`;
}

const DAY = 86_400_000;
const HOUR = 3_600_000;

export function activity(win: CallWindow, now: number): Activity {
  const { rows, covers } = win;
  const bucketize = (n: number, step: number, label: (back: number) => string): Bucket[] =>
    Array.from({ length: n }, (_, i) => {
      const from = now - (n - i) * step;
      const to = from + step;
      const inside = rows.filter((r) => r.ts >= from && r.ts < to);
      return { label: label(n - i), from, to, n: inside.length, asks: inside.filter((r) => r.tool === "brain_ask").length, win: callsWindow(inside) };
    });
  const dayName = (back: number) => new Date(now - back * DAY).toLocaleDateString("en-US", { weekday: "short" }).toLowerCase();
  const dateName = (back: number) => new Date(now - back * DAY).toLocaleDateString("en-US", { month: "short", day: "numeric" }).toLowerCase();
  const note = (span: number) => (covers >= span ? null : coversLabel(covers));
  return {
    day: { buckets: bucketize(24, HOUR, (k) => `${k} h ago`), ticks: ["-24h", "-18h", "-12h", "-6h", "now"], note: note(DAY) },
    week: { buckets: bucketize(7, DAY, (k) => dayName(k - 1)), ticks: Array.from({ length: 7 }, (_, i) => dayName(6 - i)), note: note(7 * DAY) },
    month: { buckets: bucketize(30, DAY, (k) => dateName(k - 1)), ticks: [29, 22, 15, 7, 0].map(dateName), note: note(30 * DAY) },
    covers,
    durable: win.durable,
    source: win.source,
    callsNote: callsNote(win),
  };
}

/* ── W13 · doors ─────────────────────────────────────────────────────────── */

export type DoorKey = "terminal" | "connector" | "guest";
export interface Door {
  key: DoorKey;
  name: string;
  sub: string;
  grant: "read + write" | "ask only";
  open: boolean;
  /** Epoch ms of the last call through this door in the window, when the door is open. */
  last: number | null;
  /** A live dot only when the last call is under 24 h old. */
  live: boolean;
}

/**
 * What each door's route actually requires, so the panel cannot call a door open that answers
 * 404. Every MCP door is served by the same bearer-gated handler — the path secret only chooses
 * which door reaches it — so a missing MCP_TOKEN closes all three, and the connector and guest
 * routes check it before their own secret (app/api/s/[secret]/[transport]/route.ts:30,
 * app/api/g/[secret]/[transport]/route.ts:38). The guest route additionally refuses a guest
 * secret equal to the connector's, which is a misconfiguration rather than a shortcut.
 */
export interface DoorEnv {
  /** MCP_TOKEN — the bearer every door's handler is invoked with. */
  token: boolean;
  /** CONNECTOR_PATH_SECRET */
  connector: boolean;
  /** GUEST_PATH_SECRET */
  guest: boolean;
  /** GUEST_PATH_SECRET equals CONNECTOR_PATH_SECRET — the guest route 404s on it. */
  guestClashes?: boolean;
}

/** `window` is what the call log COVERS, not the 30 days the page requested: readCalls returns
 *  covers = min(windowMs, now - start), which on a fresh deploy or either fallback mode is a
 *  fraction of that. The panel said "no calls in 30 d" beside a chart that said the log covered
 *  40 minutes. */
export function doors(rows: CallRow[], env: DoorEnv, now: number, window: string): Door[] {
  const lastBy = (s: DoorKey) => {
    const mine = rows.filter((r) => r.surface === s);
    return mine.length ? Math.max(...mine.map((r) => r.ts)) : null;
  };
  const row = (key: DoorKey, name: string, base: string, closed: string, grant: Door["grant"], open: boolean): Door => {
    const last = open ? lastBy(key) : null;
    const sub = open ? `${base}${last ? ` · ${agoLabel(last, now)}` : ` · no calls in ${window}`}` : closed;
    return { key, name, sub, grant, open, last, live: last !== null && now - last < DAY };
  };
  // A closed door names the thing that is actually missing: its own secret when that is absent,
  // otherwise the bearer the route checks first.
  const NO_TOKEN = "no bearer token — every door rides MCP_TOKEN";
  const closedFor = (secret: boolean, missing: string) => (secret ? NO_TOKEN : missing);
  const clash = env.guest && env.guestClashes === true;
  return [
    row("terminal", "Terminal", "Claude Code · Cursor · bearer", "no bearer token — door closed", "read + write", env.token),
    row("connector", "Claude app", "claude.ai · custom connector", closedFor(env.connector, "no connector secret"), "read + write", env.token && env.connector),
    row("guest", "Guests", "any assistant with the url",
      clash ? "guest secret equals the connector's — the route refuses it" : closedFor(env.guest, "no guest door open"),
      "ask only", env.token && env.guest && !clash),
  ];
}

/* ── W15 · how answers checked out ──────────────────────────────────────── */

/** The verdict tones, as a value — the screen composes `ovTone-<tone>` from them and the classes
 *  test enumerates them from here rather than from a list that can fall behind. */
export const TONES = ["ok", "crit", "muted", "warn"] as const;
export type Tone = (typeof TONES)[number];
/** The chip tones, likewise: `ovChip-<tone>`, across the lens bodies, the pipeline and the doors. */
export const CHIP_TONES = ["accent", "warn", "muted", "faint"] as const;
export type ChipTone = (typeof CHIP_TONES)[number];
/** The highest entry-stagger band: marks and bars carry ovD0…ovD{MAX_BAND}. */
export const MAX_BAND = 12;
export interface Checked {
  asks: number;
  rows: Array<{ k: string; n: number; tone: Tone; pct: number }>;
  /** Every stamp the 24 h asks carried, for the precise line. */
  stamps: Array<{ s: string; n: number }>;
}

const STAMP_ORDER = ["VERIFIED", "CORRECTED", "SUPERSEDED", "PARTIALLY VERIFIED", "NOT IN BRAIN", "UNVERIFIED", "ERROR", CUT_STAMP, TIMED_OUT_STAMP];

/** Historical stamps describe source/quote evidence, never semantic answer correctness. */
export function checkedOut(rows: CallRow[], now: number): Checked {
  const asks = rows.filter((r) => r.tool === "brain_ask" && r.ts >= now - DAY);
  const n = (pred: (r: CallRow) => boolean) => asks.filter(pred).length;
  const base: Array<{ k: string; n: number; tone: Tone }> = [
    { k: "source verified", n: n((r) => r.stamp === "VERIFIED" || r.stamp === "CORRECTED"), tone: "ok" },
    { k: "unverified evidence", n: n((r) => r.stamp === "UNVERIFIED"), tone: "warn" },
    { k: "reported absent", n: n((r) => r.stamp === "NOT IN BRAIN"), tone: "muted" },
    { k: "errors", n: n((r) => r.stamp === "ERROR"), tone: "warn" },
    // Its own row, not folded into errors: a kill at the wall is the platform's verdict, not the
    // reader's, and the fix (budget) is different from the fix for an error (the call).
    { k: "cut off by the platform", n: n((r) => r.stamp === CUT_STAMP), tone: "warn" },
    // Likewise its own row: the request deadline stopped the call before the corpus loaded.
    // Without a row of its own the stamp entered the ask count and no bucket, so the bar's
    // denominator silently lost it.
    { k: "timed out in budget", n: n((r) => r.stamp === TIMED_OUT_STAMP), tone: "warn" },
  ];
  const total = Math.max(1, base.reduce((a, r) => a + r.n, 0));
  return {
    asks: asks.length,
    rows: base.map((r) => ({ ...r, pct: Math.round((r.n / total) * 100) })),
    stamps: STAMP_ORDER.map((s) => ({ s, n: n((r) => r.stamp === s) })),
  };
}

/* ── W14 · recent saves ──────────────────────────────────────────────────── */

export interface Save extends CommitInfo {
  /** The note the commit message names, when the corpus has it — the lens ties to it. */
  note: NoteLite | null;
}

/** The two shapes a day-log commit arrives in: `log 2026-09-05` from the remember CLI, and
 *  `brain: capture 2026-09-05 14:20` from brain_capture — which writes the same `log/<date>.md`
 *  and so must tie to the same note. Anchored, because a date this far left is the subject of
 *  the message rather than a mention inside one. */
const LOG_COMMIT = /^(?:log|brain: capture) (\d{4}-\d{2}-\d{2})/;
/** The path wherever the message names it: `brain: append log/2026-09-05.md`, `brain: write
 *  notes/foo.md`, `projects/bar: …`. The folders are the ones the brain will write to
 *  (validatePath in lib/brain.ts) plus people/, which the corpus carries. */
const NOTE_COMMIT = /(?:projects|notes|people|log|history)\/[\w-]+(?:\.md)?/;

/** `log 2026-09-05` and `brain: capture 2026-09-05 …` → log/2026-09-05.md; `notes/foo` or
 *  `projects/bar` → that note. Only a note the corpus actually holds is tied — a guess that is
 *  not a note is null. */
export function saves(commits: CommitInfo[], notes: Map<string, NoteLite>): Save[] {
  return commits.map((c) => {
    const day = LOG_COMMIT.exec(c.message);
    const named = day ? null : NOTE_COMMIT.exec(c.message);
    const p = day ? `log/${day[1]}.md` : named ? (named[0].endsWith(".md") ? named[0] : `${named[0]}.md`) : null;
    return { ...c, note: (p && notes.get(p)) || null };
  });
}

/* ── W12 · the memory pipeline ───────────────────────────────────────────── */

export interface Pipeline {
  /** in sync · healing · mirror off · unreachable */
  state: string;
  tone: "accent" | "warn" | "faint";
  rows: Array<{ k: string; v: string }>;
  /** Sentences the rows cannot carry: a healing mirror, deletion candidates, a sampled breakdown. */
  notes: string[];
}

/** Every source states its mode: a null pulse is "unreachable", a mirror with no env is
 *  "mirror off" — never a fabricated zero on the row. */
export function pipeline(mirror: MirrorPulse | null, access: AccessPulse | null, temps: TemperaturePulse | null, now: number): Pipeline {
  const rows: Array<{ k: string; v: string }> = [];
  const notes: string[] = [];
  if (mirror === null) {
    rows.push({ k: "git → Postgres mirror", v: "unreachable this render" });
    notes.push("reads fall back to the repo tarball on their own");
  } else if (mirror.state === "off") {
    rows.push({ k: "mirror", v: "off · every read hauls the tarball" });
  } else {
    rows.push({ k: "git → Postgres mirror", v: `${mirror.notes ?? "—"} notes` });
    rows.push({ k: "served at commit", v: (mirror.mirrorHead ?? "—").slice(0, 8) });
    rows.push({ k: "last reconciled", v: mirror.syncedAt ? agoIso(mirror.syncedAt, now) : "—" });
    if (mirror.state === "healing") notes.push("behind the repo — the next read patches it forward; reads stay served meanwhile");
  }
  // accessPulse and temperaturePulse gate on the same env() as mirrorPulse (lib/pulse.ts:20) but
  // return null where the mirror returns state "off". Read literally that printed one missing
  // env as three rows in two different modes — "mirror off" beside "telemetry unreachable",
  // which is a different fault with a different remedy. The mirror's own answer names the cause.
  const storeOff = mirror !== null && mirror.state === "off";
  if (access === null) {
    rows.push({ k: "notes served · 24 h", v: storeOff ? "no Supabase env — nothing is recorded" : "telemetry unreachable" });
  } else {
    rows.push({ k: "notes served · 24 h", v: access.byTool.length ? access.byTool.map((x) => `${x.tool.replace("brain_", "")} ${x.n}`).join(" · ") : "none" });
    if (access.topNotes.length) rows.push({ k: "most read", v: access.topNotes.slice(0, 3).map((x) => `${x.path.split("/").pop()!.replace(/\.md$/, "")} ×${x.n}`).join(" · ") });
    if (access.basis < access.last24h) notes.push(`the breakdown is from the ${access.basis} most recent reads`);
  }
  if (temps === null) {
    rows.push({ k: "what every session loads", v: storeOff ? "no Supabase env — nothing is scored" : "temperatures unreachable" });
  } else {
    rows.push({ k: "what every session loads", v: `${temps.hot} hot · ${temps.warm} warm · ${temps.cold} cold` });
    rows.push({ k: "deletion candidates", v: temps.pendingDeletions ? `${temps.pendingDeletions} awaiting your call` : "none" });
    if (temps.pendingDeletions) notes.push("nothing is ever deleted automatically — review on Attention");
  }
  const state = mirror === null ? "unreachable" : mirror.state === "live" ? "in sync" : mirror.state === "healing" ? "healing" : "mirror off";
  const tone = mirror === null ? "warn" : mirror.state === "live" ? "accent" : mirror.state === "healing" ? "warn" : "faint";
  return { state, tone, rows, notes };
}
