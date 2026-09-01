import { AsyncLocalStorage } from "node:async_hooks";
import { after } from "next/server";
import { kv, kvEnv, resetKvForTests } from "./kv";

/**
 * The call log — the one source the console's live panels need and the corpus cannot provide.
 *
 * Deliberately NOT the brain repo: every write there is a commit, and a commit per MCP call
 * would turn a memory into a changelog of itself. The durable home is the KV store
 * (cortex-calls, Upstash via the Vercel Marketplace): every instance writes to it
 * fire-and-forget, every console render reads from it, and it survives cold starts and
 * deployments alike. The in-memory ring stays as the always-there fallback — local dev without
 * the store, and any render where the store read fails — and the console labels which of the
 * two it is looking at rather than letting a fallback impersonate the durable record.
 *
 * The one inviolable rule, in both modes: logging is an observation, never the product. A store
 * outage must never slow, break, or reorder a tool call.
 */

/**
 * Which door the call came through — the only surface signal the server actually has, and now
 * also a trust level: terminal and connector may write, guest may only propose.
 */
export type Surface = "terminal" | "connector" | "guest";

export interface CallRow {
  /** Epoch ms. */
  ts: number;
  surface: Surface;
  tool: string;
  /** The verdict for brain_ask; the outcome word for the others (COMMITTED / READ / BOOT). */
  stamp: string;
  /** Whole milliseconds the tool took. */
  ms: number;
  /**
   * Which reader model answered — brain_ask only; absent on every other tool, and absent on
   * every row written before this field shipped (2026-08-03). Optional on purpose: the store
   * holds up to two days of older rows, and a reader that demanded this field would drop them
   * all and call the server idle. The console counts unattributed rows out loud instead.
   */
  model?: string;
  /** Tokens narrowing kept out of a context on this ask: scoped corpus minus the pack actually
   *  sent. brain_ask only; absent on rows written before the field shipped (2026-08-05) — the
   *  trends screen counts those out loud rather than folding them into zero. */
  saved?: number;
  /** True when the reply came from the answer cache — zero model calls on this row. `model`
   *  then names the reader that answered ORIGINALLY, so the row stays attributable, but the
   *  row is excluded from that model's verdict record (see modelRecordRows): replaying an
   *  answer is not evidence about the model, and repeats must not inflate its record. */
  cached?: true;
}

/** Two days of headroom at a heavy cadence; the console never reads more than 24h of it. */
const CAP = 5000;
/** A console render must never hang on the store; past this it falls back to memory. */
const READ_TIMEOUT_MS = 1500;

/**
 * Pinned to globalThis, not a module-level array: Next bundles the route handlers and the
 * console pages separately, so a plain module-scoped log is instantiated twice in one process —
 * the tools write to one copy and the console reads the other, forever empty.
 */
const g = globalThis as typeof globalThis & {
  __cortexCalls?: { log: CallRow[]; since: number };
};
g.__cortexCalls ??= { log: [], since: Date.now() };
const log = g.__cortexCalls.log;
const since = g.__cortexCalls.since;

// Namespacing, not isolation: all three prefixes share one store and one read-write token, so
// anyone holding the development credentials can read or write the production keys. Accepted —
// the rows carry nothing sensitive (door, tool name, stamp, duration) and this is a personal
// ops console; revisit with per-environment stores if the log ever gains interesting content.
const keyRows = () => `cortex:calls:${kvEnv()}`;
const keySince = () => `cortex:calls:${kvEnv()}:since`;

const redis = kv;

/** Test seam: forget the memoized client so env stubs take effect. */
export function resetStoreForTests(): void {
  resetKvForTests();
}

/**
 * The surface a call arrived on. The alias route rewrites connector requests into the same
 * bearer-gated handler, so by the time a tool runs the two doors are indistinguishable — the
 * marker has to ride an async context set at the edge, not be re-derived here.
 */
const surface = new AsyncLocalStorage<Surface>();

export function withSurface<T>(s: Surface, fn: () => T): T {
  return surface.run(s, fn);
}

export function currentSurface(): Surface {
  return surface.getStore() ?? "terminal";
}

/** The caveat for the fallback mode only — the durable store has no instance boundary. */
export const SCOPE_NOTE =
  "one instance's view — the server runs several, and each keeps its own log";

export function record(row: CallRow): void {
  log.push(row);
  if (log.length > CAP) log.splice(0, log.length - CAP);

  // Durable write, fire-and-forget: newest-first list, trimmed to CAP, plus a set-once marker
  // for when collection began. A failure here is swallowed whole — the tool call this row
  // describes has already succeeded, and no log may retroactively break it.
  const r = redis();
  if (!r) return;
  const p = r.pipeline();
  p.lpush(keyRows(), JSON.stringify(row));
  p.ltrim(keyRows(), 0, CAP - 1);
  p.setnx(keySince(), String(row.ts));
  const write = p.exec().catch(() => {
    /* the log is an observation, never the product */
  });
  // Registered with the request lifecycle so a suspending instance flushes it — a bare floating
  // promise is dropped exactly on the last call before idle, the row a durable log most needs.
  // after() throws outside a request scope (tests, scripts); there, fire-and-forget is the deal.
  try {
    after(write);
  } catch {
    /* no request scope — the write races the process, and a lost row is accepted */
  }
}

export interface CallWindow {
  rows: CallRow[];
  /** True when the log covers less than the window — the chart is partial, and says so. */
  partial: boolean;
  since: number;
  /** Milliseconds the log actually claims inside this window. */
  covers: number;
  /** True when this came from the shared store; false means the in-memory fallback. */
  durable: boolean;
  /** Where the rows came from — "store", or which kind of fallback this is. */
  source: "store" | "unconfigured" | "unreachable";
}

function fromMemory(windowMs: number, now: number): CallWindow {
  const from = now - windowMs;
  // Chronological, not append order: rows are stamped when a call STARTS and appended when it
  // finishes, so a slow call lands after faster ones that began later.
  const rows = log.filter((r) => r.ts >= from).sort((a, b) => a.ts - b.ts);
  // Coverage follows the data too: once the ring evicts, the log no longer holds the window
  // its start time implies, and a chart drawn over evicted hours reads as silence.
  const start = Math.max(since, log[0]?.ts ?? since);
  return {
    rows,
    partial: start > from,
    since: start,
    covers: Math.min(windowMs, now - start),
    durable: false,
    source: "unconfigured",
  };
}

function parseRow(raw: unknown): CallRow | null {
  // The SDK may hand back an already-deserialized object or the raw JSON string.
  const o = typeof raw === "string" ? (JSON.parse(raw) as unknown) : raw;
  if (o === null || typeof o !== "object") return null;
  const r = o as Record<string, unknown>;
  if (typeof r.ts !== "number" || typeof r.tool !== "string" || typeof r.stamp !== "string") {
    return null;
  }
  // An unknown surface is dropped, not folded into "terminal" — a future deploy writing a new
  // door must not light the bearer row as a side effect of an old reader's coercion. (This is
  // exactly what happened when "guest" arrived: older instances drop those rows, which is the
  // safe direction — undercounting a door beats attributing its calls to the trusted one.)
  if (r.surface !== "terminal" && r.surface !== "connector" && r.surface !== "guest") return null;
  return {
    ts: r.ts,
    surface: r.surface,
    tool: r.tool,
    stamp: r.stamp,
    ms: typeof r.ms === "number" ? r.ms : 0,
    ...(typeof r.saved === "number" && r.saved >= 0 ? { saved: r.saved } : {}),
    // Passed through as the free string it is, NOT checked against the allowlist: this row is
    // history. A model retired from READER_MODEL_IDS still answered these calls, and a reader
    // that dropped the field on rename would quietly rewrite the past as unattributed.
    ...(typeof r.model === "string" && r.model ? { model: r.model } : {}),
    // Only literal true counts. Coercing a truthy junk value would mark a real model call as
    // cached and silently drop it from the model's record — the failure direction that matters.
    ...(r.cached === true ? { cached: true as const } : {}),
  };
}

/**
 * Rows that count toward a model's verdict record: attributed AND actually answered by the
 * model on that call. A cached row is a replay of an earlier answer — counting it would let a
 * repeated question inflate (or, on a repeated UNVERIFIED-adjacent verdict, damage) a model's
 * record without the model ever running. Lives here rather than in the page so every screen
 * that draws a per-model record applies the same honesty rule.
 */
export function modelRecordRows(rows: CallRow[]): CallRow[] {
  return rows.filter((r) => r.model && !r.cached);
}

/**
 * Every row inside the window, oldest first, plus what the log can honestly claim to cover.
 * Reads the shared store when it is configured; a slow or failing store falls back to this
 * instance's memory, flagged `durable: false` so the page can say which record it shows.
 */
export async function readCalls(windowMs = 86_400_000, now = Date.now()): Promise<CallWindow> {
  const r = redis();
  if (!r) return fromMemory(windowMs, now);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const read = Promise.all([
      r.lrange(keyRows(), 0, CAP - 1),
      r.get<string>(keySince()),
    ]);
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("kv read timeout")), READ_TIMEOUT_MS);
    });
    const [raw, sinceRaw] = await Promise.race([read, timeout]);

    const from = now - windowMs;
    const all: CallRow[] = [];
    for (const item of raw) {
      try {
        const row = parseRow(item);
        if (row) all.push(row);
      } catch {
        /* one malformed row must not empty the chart */
      }
    }
    all.sort((a, b) => a.ts - b.ts);
    const rows = all.filter((row) => row.ts >= from);
    const storedSince = Number(sinceRaw);
    // Same eviction honesty as memory: once LTRIM has dropped rows, the record starts at the
    // oldest surviving row, whatever the set-once marker says. Judged on the RAW list — a
    // malformed row lowers the parsed count, and a full-but-unparseable list still evicted.
    const evicted = raw.length >= CAP;
    const base = Number.isFinite(storedSince) && storedSince > 0 ? storedSince : now;
    const start = evicted ? Math.max(base, all[0]?.ts ?? base) : base;
    return {
      rows,
      partial: start > from,
      since: start,
      covers: Math.min(windowMs, Math.max(0, now - start)),
      durable: true,
      source: "store",
    };
  } catch {
    // The store is down or slow — the panel still renders, from the honest fallback.
    return { ...fromMemory(windowMs, now), source: "unreachable" };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The stamp a reply carries, derived from the rendered answer rather than re-deciding it.
 * verify.ts owns what a verdict means; this only reads the word it already stamped, so the
 * console and the answer can never disagree about a call.
 */
const STAMPS = [
  "PARTIALLY VERIFIED",
  "NOT IN BRAIN",
  "SUPERSEDED",
  "CORRECTED",
  "UNVERIFIED",
  "VERIFIED",
] as const;

export function stampOf(rendered: string): string {
  // Anchored to the leading token of line 1, where render() always puts the verdict — a
  // substring scan of the whole reply reads the answer's own prose and the evidence block,
  // and this brain documents the verifier, so a VERIFIED quote about UNVERIFIED logged as a
  // failure. The console must agree with the answer the caller was handed.
  const head = rendered.split("\n", 1)[0].trimStart();
  for (const s of STAMPS) if (head.startsWith(s)) return s;
  return "ANSWERED";
}
