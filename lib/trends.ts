import type { CallRow } from "./calls";
import { CUT_STAMP, PLATFORM_WALL_MS, TIMED_OUT_STAMP } from "./deadline";

/**
 * The Trends screen's derivations, in one place the server and the browser both read.
 *
 * Every figure here is computed from CallRow[] and nothing else — the log is the only source
 * the corpus cannot provide, and the screen's honesty rules live in these functions rather
 * than in the markup: a window is always the window the log covers, a pattern renders only
 * when its premise holds in the rows, and the value claim (tokens the brain saved) is a
 * lifetime number that says "est." because it is priced against today's corpus size.
 *
 * The browser recomputes the windowed instruments (clock, heat, patterns, who answered) from
 * the same rows when a pulse hour is clicked, so these are pure and dependency-free.
 */

export const HOUR = 3_600_000;
export const DAY = 86_400_000;
/** A session = a burst of calls with under 30 quiet minutes inside it. */
export const SESSION_GAP = 1_800_000;
/** Reading pace, tokens per minute — the one derived figure on the strip, labelled est. */
export const READING_PACE = 330;

/** The fields the browser needs of a row. `saved` stays server-side (the strip sums it). */
export type CallLite = Pick<CallRow, "ts" | "surface" | "tool" | "stamp" | "ms" | "model" | "cached">;

export function liteOf(rows: CallRow[]): CallLite[] {
  return rows.map((r) => ({
    ts: r.ts, surface: r.surface, tool: r.tool, stamp: r.stamp, ms: r.ms,
    ...(r.model ? { model: r.model } : {}),
    ...(r.cached ? { cached: true as const } : {}),
  }));
}

/** A call the clock stopped, either way: killed by the platform at the wall (CUT OFF), or
 *  stopped by the request deadline before the corpus was loaded (TIMED OUT). Neither answered
 *  anything, and the console must never score either as an answer, an error, or a latency. */
export const stoppedByClock = (stamp: string): boolean => stamp === CUT_STAMP || stamp === TIMED_OUT_STAMP;
/** Memory answered = the brain had it: everything except an explicit miss, an error, or a call
 *  the clock stopped before it could answer — those answered nothing and must not read as a
 *  success. */
export const answeredFromMemory = (stamp: string): boolean => stamp !== "NOT IN BRAIN" && stamp !== "ERROR" && !stoppedByClock(stamp);
/** Scored = could have been answered from somewhere: errors and clock stops both leave every
 *  memory-rate denominator, so one predicate says so wherever a rate is computed. */
export const scoredAsk = (r: { stamp: string }): boolean => r.stamp !== "ERROR" && !stoppedByClock(r.stamp);
/** A call the platform killed at the wall: the started row was written, the final one never was. */
export const cutOff = (r: { stamp: string }): boolean => r.stamp === CUT_STAMP;
/** A call the request deadline stopped inside the budget — the corpus did not load in time. */
export const timedOut = (r: { stamp: string }): boolean => r.stamp === TIMED_OUT_STAMP;
/** The known limit behind a CUT OFF row, in the words the screens print beside the figure: the
 *  started and final rows are independent writes, so a final row the store lost reads exactly
 *  like a kill. The label says both rather than promising a verdict the log cannot back. */
export const CUT_OFF_CAVEAT = "cut off = a started row with no final row: killed at the wall, or its final row was lost";
/** A row's elapsed time in the console's words. A cut-off row's `ms` IS the wall, and the label
 *  says who stopped it rather than presenting the wall as a measured duration; a timed-out row's
 *  `ms` is measured, but it is time spent not answering, so the label says that too. */
export const elapsedLabel = (r: { stamp: string; ms: number }): string =>
  cutOff(r)
    ? `cut off by the platform after ${Math.round(PLATFORM_WALL_MS / 1000)} s`
    : timedOut(r)
      ? `timed out in budget after ${(r.ms / 1000).toFixed(1)} s`
      : `${(r.ms / 1000).toFixed(1)} s`;
/** Proven = VERIFIED + CORRECTED; SUPERSEDED and PARTIAL are warnings, not proofs. */
export const proven = (stamp: string): boolean => stamp === "VERIFIED" || stamp === "CORRECTED";
export const isAsk = (r: { tool: string }): boolean => r.tool === "brain_ask";

export function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 10_000) return `${Math.round(n / 1000)}k`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}

export function fmtDur(mins: number): string {
  if (mins < 1) return "under a min";
  if (mins < 60) return `${Math.round(mins)}m`;
  return `${Math.floor(mins / 60)}h ${String(Math.round(mins % 60)).padStart(2, "0")}m`;
}

/** Median of whole milliseconds, as "1.4 s"; a dash when there is nothing to take one of. */
export function p50(ms: number[]): string {
  if (ms.length === 0) return "—";
  const s = [...ms].sort((a, b) => a - b);
  return `${(s[Math.floor((s.length - 1) / 2)] / 1000).toFixed(1)} s`;
}

/** Bursts of calls, 30 quiet minutes apart. */
export function sessionsOf(rows: ReadonlyArray<{ ts: number }>): number {
  return [...rows]
    .sort((a, b) => a.ts - b.ts)
    .reduce((n, r, i, all) => (i === 0 || r.ts - all[i - 1].ts > SESSION_GAP ? n + 1 : n), 0);
}

/**
 * Tokens the brain read FOR the session, server-side, so only the answer entered a context:
 * corpus-at-ask minus what narrowing sent, priced against today's corpus size because the row
 * carries no historical size. Rows written before the field shipped are counted out loud.
 */
export function tokensSaved(asks: ReadonlyArray<Pick<CallRow, "saved">>, corpusTokens: number): { tokens: number; measured: number; unmeasured: number } {
  let tokens = 0, measured = 0;
  for (const r of asks) {
    if (typeof r.saved !== "number") continue;
    measured++;
    tokens += Math.max(0, Math.min(corpusTokens, corpusTokens - r.saved));
  }
  return { tokens, measured, unmeasured: asks.length - measured };
}

/** "log just started" / "12 min of log" / "48 h of log" — what the window really covers. */
export function coverageOf(covers: number): string {
  if (covers < 60_000) return "log just started";
  if (covers < HOUR) return `${Math.round(covers / 60_000)} min of log`;
  return `${Math.round(covers / HOUR)} h of log`;
}

/** Whole hours the log covers inside the 48 h window — the number of pulse bars drawn. */
export function hoursCovered(covers: number): number {
  return Math.max(1, Math.min(48, Math.ceil(covers / HOUR)));
}

/** "-3h → now" / "-9h → -6h", relative to now. */
export function fmtWin(from: number, to: number, now: number): string {
  const ago = (t: number) => `-${Math.round((now - t) / HOUR)}h`;
  return `${ago(from)} → ${to >= now - 60_000 ? "now" : ago(to)}`;
}

export interface HourBin { from: number; to: number; calls: number; asks: number }

/** One bin per covered hour, oldest first; the last bin ends now. */
export function hourBins(rows: ReadonlyArray<CallLite>, now: number, hoursN: number): HourBin[] {
  const bins: HourBin[] = Array.from({ length: hoursN }, (_, i) => {
    const from = now - (hoursN - i) * HOUR;
    return { from, to: from + HOUR, calls: 0, asks: 0 };
  });
  const start = now - hoursN * HOUR;
  for (const r of rows) {
    if (r.ts < start || r.ts >= now) continue;
    const b = bins[Math.min(hoursN - 1, Math.floor((r.ts - start) / HOUR))];
    b.calls++;
    if (isAsk(r)) b.asks++;
  }
  return bins;
}

export interface MemoryBucket { from: number; to: number; label: string; memory: number; fresh: number; all: number }

/** Asks across the covered hours in up to eight equal buckets: from memory vs not. */
export function memoryBuckets(rows: ReadonlyArray<CallLite>, now: number, hoursN: number, count = Math.max(2, Math.min(8, hoursN))): MemoryBucket[] {
  const bucketMs = (hoursN * HOUR) / count;
  return Array.from({ length: count }, (_, i) => {
    const from = now - (count - i) * bucketMs;
    const to = from + bucketMs;
    const inB = rows.filter((r) => isAsk(r) && r.ts >= from && r.ts < to);
    return {
      from, to,
      label: i === count - 1 ? "now" : `-${Math.round(((count - i) * bucketMs) / HOUR)}h`,
      memory: inB.filter((r) => answeredFromMemory(r.stamp)).length,
      fresh: inB.filter((r) => r.stamp === "NOT IN BRAIN").length,
      all: inB.length,
    };
  });
}

/** Wall-clock derivations run in the browser's zone once it is known; the server has only UTC. */
export type Tz = "utc" | "local";
export const hourOf = (ts: number, tz: Tz): number => (tz === "utc" ? new Date(ts).getUTCHours() : new Date(ts).getHours());
/** Monday = 0 … Sunday = 6. */
export const dayOf = (ts: number, tz: Tz): number => (((tz === "utc" ? new Date(ts).getUTCDay() : new Date(ts).getDay()) + 6) % 7);

export const DAYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"] as const;
export const DAYS_FULL = ["Mondays", "Tuesdays", "Wednesdays", "Thursdays", "Fridays", "Saturdays", "Sundays"] as const;
export const BANDS = ["12am", "4am", "8am", "12pm", "4pm", "8pm"] as const;

/** Calls per hour of day, 24 wedges. */
export function clockHours(rows: ReadonlyArray<CallLite>, tz: Tz): number[] {
  const byHour = Array<number>(24).fill(0);
  for (const r of rows) byHour[hourOf(r.ts, tz)]++;
  return byHour;
}

/** Calls per 4-hour band × weekday, 6 × 7. */
export function heatGrid(rows: ReadonlyArray<CallLite>, tz: Tz): number[][] {
  const heat = Array.from({ length: 6 }, () => Array<number>(7).fill(0));
  for (const r of rows) heat[Math.floor(hourOf(r.ts, tz) / 4)][dayOf(r.ts, tz)]++;
  return heat;
}

/** The index of the largest value; the first on a tie. */
export function argmax(vals: ReadonlyArray<number>): number {
  return vals.reduce((a, v, i) => (v > vals[a] ? i : a), 0);
}

export interface Pattern {
  up: boolean;
  /** True when the pattern is a warning-toned finding (amber) rather than a steady one. */
  pop: boolean;
  title: string;
  sub: string;
  chip: string;
  /** Its derivation, for the lens: the premise, the numbers, the threshold. */
  how: Array<[string, string]>;
}

/**
 * Patterns — only claims the window can back. A pattern the log cannot attest is not shown
 * dimmed, it is not shown at all; each carries the derivation the lens prints.
 */
export function patternsOf(args: { rows: ReadonlyArray<CallLite>; heat: number[][]; from: number; to: number; windowLabel: string }): Pattern[] {
  const { rows, heat, from, to, windowLabel } = args;
  const asks = rows.filter(isAsk);
  const out: Pattern[] = [];

  const heatMax = Math.max(0, ...heat.flat());
  if (heatMax >= 3) {
    let hb = 0, hd = 0;
    heat.forEach((band, b) => band.forEach((v, d) => { if (v > heat[hb][hd]) { hb = b; hd = d; } }));
    out.push({
      up: true, pop: false,
      title: `${DAYS_FULL[hd]} run hot`,
      sub: `${heat[hb][hd]} calls between ${hb * 4}:00 and ${hb * 4 + 4}:00`,
      chip: "peak",
      how: [
        ["premise", "the busiest heat cell holds ≥ 3 calls"],
        ["cell", `${DAYS[hd]} · ${BANDS[hb]} · ${heat[hb][hd]} calls`],
        ["window", windowLabel],
      ],
    });
  }

  if (asks.length >= 8 && to - from >= 2 * HOUR) {
    const half = from + (to - from) / 2;
    const rate = (xs: CallLite[]) => {
      const s = xs.filter((r) => r.stamp !== "ERROR");
      return s.length ? s.filter((r) => r.stamp === "NOT IN BRAIN").length / s.length : null;
    };
    const re = rate(asks.filter((r) => r.ts < half)), rl = rate(asks.filter((r) => r.ts >= half));
    if (re !== null && rl !== null && re > 0) {
      const delta = Math.round(((rl - re) / re) * 100);
      if (Math.abs(delta) >= 15) {
        out.push({
          up: delta < 0, pop: true,
          title: delta < 0 ? "Re-explaining is fading" : "More questions the brain lacks",
          sub: `not-in-memory rate ${delta < 0 ? "fell" : "rose"} across the window`,
          chip: `${delta > 0 ? "+" : ""}${delta}%`,
          how: [
            ["premise", "≥ 8 asks and ≥ 2 h of log"],
            ["first half", `${Math.round(re * 100)}% not in memory`],
            ["second half", `${Math.round(rl * 100)}% not in memory`],
            ["threshold", "|Δ| ≥ 15% relative"],
          ],
        });
      }
    }
  }

  const ver = asks.filter((r) => proven(r.stamp)).length;
  if (ver > 0) {
    out.push({
      up: true, pop: false,
      title: "Answers proving right",
      sub: `${ver} of ${asks.length} asks came back proven against the notes`,
      chip: `${Math.round((ver / asks.length) * 100)}%`,
      how: [
        ["premise", "at least one VERIFIED or CORRECTED stamp"],
        ["proven", `${ver} of ${asks.length}`],
        ["counts as proven", "VERIFIED + CORRECTED · SUPERSEDED and PARTIAL are warnings"],
      ],
    });
  }

  const guest = rows.filter((r) => r.surface === "guest").length;
  if (guest > 0) {
    out.push({
      up: true, pop: true,
      title: "Guests are using the door",
      sub: `${guest} guest calls in the window`,
      chip: `${guest}×`,
      how: [
        ["premise", "any call with surface = guest"],
        ["calls", String(guest)],
        ["door", "/api/g/<GUEST_PATH_SECRET>/mcp · ask + propose only"],
      ],
    });
  }
  return out;
}

export interface ModelShare { model: string; n: number; ok: number; p50: string; pct: number }

/** Attributed asks by reader, busiest first. Cached replays stay attributed but carry no ms. */
export function byModel(asks: ReadonlyArray<CallLite>): ModelShare[] {
  const attributed = asks.filter((r) => r.model);
  const models = [...new Set(attributed.map((r) => r.model as string))];
  return models
    .map((model) => {
      const mine = attributed.filter((r) => r.model === model);
      return {
        model,
        n: mine.length,
        ok: mine.filter((r) => proven(r.stamp)).length,
        p50: p50(mine.filter((r) => !r.cached).map((r) => r.ms)),
        pct: Math.round((mine.length / Math.max(1, attributed.length)) * 100),
      };
    })
    .sort((a, b) => b.n - a.n);
}

/** Counts by one key, busiest first, as "ask 12 · read 4". */
export function countBy(rows: ReadonlyArray<CallLite>, key: "tool" | "surface"): string {
  const m = new Map<string, number>();
  for (const r of rows) m.set(r[key], (m.get(r[key]) ?? 0) + 1);
  return [...m.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([k, v]) => `${k.replace("brain_", "")} ${v}`)
    .join(" · ");
}
