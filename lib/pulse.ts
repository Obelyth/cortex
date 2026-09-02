/**
 * pulse — what the console's overview needs to know about the tiers phases 2 and 3 added:
 * the mirror's sync state, the note-level access activity, and the bubble.
 *
 * Everything here FAILS SOFT to null and the screen says so with a consequence attached — a
 * console that errors because its telemetry store blinked would be the tail wagging the dog.
 * Every request carries its own timeout, INCLUDING the GitHub head lookup: a hung socket that
 * blocked the page past its maxDuration would 5xx the whole overview over a telemetry read.
 *
 * And every number is exact or says it is not: counts come from Prefer: count=exact headers,
 * never from counting a page that PostgREST silently caps at its max-rows — the lesson
 * lib/mirror.ts's all() already paid for.
 */
import { gh, repo, branch } from "./github";
import { bubbleStore, type BubbleRead } from "./bubble";
import { sidecarPaths } from "./corpus";

const PULSE_TIMEOUT_MS = 6_000;

function env(): { base: string; key: string } | null {
  const base = process.env.SUPABASE_URL?.replace(/\/$/, "");
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  return base && key ? { base, key } : null;
}

function pg(e: { base: string; key: string }, path: string, init: RequestInit = {}): Promise<Response> {
  return fetch(`${e.base}/rest/v1/${path}`, {
    ...init,
    headers: { apikey: e.key, Authorization: `Bearer ${e.key}`, ...(init.headers ?? {}) },
    signal: AbortSignal.timeout(PULSE_TIMEOUT_MS),
  });
}

/**
 * The exact row count for a PostgREST filter, from the Content-Range header of a HEAD request.
 * "0-0/123" and "*\/0" both parse; a missing or malformed header returns null rather than a
 * number that looks real. Exported for tests.
 */
export function parseExactCount(contentRange: string | null): number | null {
  const total = contentRange?.split("/")[1];
  if (total === undefined || total === "*") return null;
  const n = Number(total);
  return Number.isInteger(n) && n >= 0 ? n : null;
}

async function exactCount(e: { base: string; key: string }, pathWithFilter: string): Promise<number | null> {
  const res = await pg(e, pathWithFilter, {
    method: "HEAD",
    headers: { Prefer: "count=exact", Range: "0-0", "Range-Unit": "items" },
  });
  if (!res.ok) return null;
  return parseExactCount(res.headers.get("content-range"));
}

export interface MirrorPulse {
  /** "live" = mirror head equals git head · "healing" = behind, next read patches it ·
   *  "off" = env absent. A configured-but-unreachable mirror returns null from mirrorPulse. */
  state: "live" | "healing" | "off";
  gitHead: string;
  mirrorHead: string | null;
  notes: number | null;
  syncedAt: string | null;
}

export async function mirrorPulse(): Promise<MirrorPulse | null> {
  const e = env();
  if (!e) return { state: "off", gitHead: "", mirrorHead: null, notes: null, syncedAt: null };
  try {
    const [headRes, syncRes, notes] = await Promise.all([
      // The same 6s budget as the store calls: gh() sets no timeout of its own, and a hung
      // GitHub socket must degrade this card, never the page.
      gh(`/repos/${repo()}/commits/${branch()}`, { signal: AbortSignal.timeout(PULSE_TIMEOUT_MS) }),
      pg(e, "sync_state?select=head_sha,synced_at&id=is.true"),
      // NOTES, not rows: the mirror also carries sidecar files the corpus explicitly excludes,
      // and a count that includes one makes this card disagree with the hero by exactly the
      // amount nobody can explain from the screen.
      exactCount(e, `notes?select=path&path=not.in.(${encodeURIComponent(sidecarPaths().map((s) => `"${s}"`).join(","))})`),
    ]);
    if (!headRes.ok || !syncRes.ok) return null;
    const gitHead = ((await headRes.json()) as { sha: string }).sha;
    const sync = ((await syncRes.json()) as Array<{ head_sha: string; synced_at: string }>)[0] ?? null;
    return {
      state: sync?.head_sha === gitHead ? "live" : "healing",
      gitHead,
      mirrorHead: sync?.head_sha ?? null,
      notes,
      syncedAt: sync?.synced_at ?? null,
    };
  } catch (err) {
    console.error(`[pulse] mirror state unavailable: ${String(err)}`);
    return null;
  }
}

export interface AccessPulse {
  /** EXACT count of notes served in the last 24 hours (rolling window, not a calendar day —
   *  the label on screen must say "24 h", never "today"). */
  last24h: number;
  /** Exact count for the 24 hours before that. */
  prior24h: number;
  byTool: Array<{ tool: string; n: number }>;
  topNotes: Array<{ path: string; n: number }>;
  /** How many recent rows the breakdowns are computed from. When basis < last24h the detail
   *  lists are a sample of the most recent reads, and the screen says so. */
  basis: number;
  /** When collection began — the oldest row's timestamp, so "collecting since" is measured,
   *  never a date literal rotting in source. Null when the table is empty. */
  firstAt: string | null;
}

export async function accessPulse(now = Date.now()): Promise<AccessPulse | null> {
  const e = env();
  if (!e) return null;
  try {
    const dayAgo = new Date(now - 24 * 3_600_000).toISOString();
    const twoDaysAgo = new Date(now - 48 * 3_600_000).toISOString();
    const enc = encodeURIComponent;
    // Counts are EXACT via headers — a paged SELECT capped at PostgREST's max-rows once made
    // 1200+800 reads render as "1000 today, +1000 vs yesterday". Details ride a bounded page
    // and disclose their basis.
    const [last24h, prior24h, rowsRes, firstRes] = await Promise.all([
      exactCount(e, `note_access?select=id&at=gte.${enc(dayAgo)}`),
      exactCount(e, `note_access?select=id&at=gte.${enc(twoDaysAgo)}&at=lt.${enc(dayAgo)}`),
      pg(e, `note_access?select=path,tool&at=gte.${enc(dayAgo)}&order=at.desc&limit=1000`),
      pg(e, "note_access?select=at&order=at.asc&limit=1"),
    ]);
    if (last24h === null || prior24h === null || !rowsRes.ok || !firstRes.ok) return null;
    const firstAt = ((await firstRes.json()) as Array<{ at: string }>)[0]?.at ?? null;
    const rows = (await rowsRes.json()) as Array<{ path: string; tool: string }>;
    const count = (xs: string[]) => {
      const m = new Map<string, number>();
      for (const x of xs) m.set(x, (m.get(x) ?? 0) + 1);
      return [...m.entries()].sort((a, b) => b[1] - a[1]);
    };
    return {
      last24h,
      prior24h,
      byTool: count(rows.map((r) => r.tool)).map(([tool, n]) => ({ tool, n })),
      topNotes: count(rows.map((r) => r.path)).slice(0, 6).map(([path, n]) => ({ path, n })),
      basis: rows.length,
      firstAt,
    };
  } catch (err) {
    console.error(`[pulse] access stats unavailable: ${String(err)}`);
    return null;
  }
}

export async function bubblePulse(): Promise<BubbleRead | null> {
  const store = bubbleStore();
  if (!store) return null;
  try {
    return await store.open();
  } catch (err) {
    console.error(`[pulse] bubble unavailable: ${String(err)}`);
    return null;
  }
}

export interface TemperaturePulse {
  hot: number;
  warm: number;
  cold: number;
  /** Deletion candidates awaiting a human decision. Never acted on by anything automatic. */
  pendingDeletions: number;
  /** The coldest few WITHHELD notes, so "cold" is a list of names rather than an abstraction.
   *  A sample when `cold` exceeds its length — the render says so rather than implying it is
   *  the complete set. */
  coldest: Array<{ path: string; score: number }>;
}

export interface NoteHeat {
  path: string;
  temperature: "hot" | "warm" | "cold";
  score: number;
  reads: number;
}

/** The three values note_scores is allowed to claim. Anything else in a row is a schema drift
 *  this reader refuses to forward, because the map turns temperature straight into brightness. */
const TEMPERATURES = new Set(["hot", "warm", "cold"]);

/**
 * Every note's temperature, for the map — the SAME rows the router and the trends read, so the
 * map can never disagree with the console about which notes are alive. This reads note_scores;
 * it never rescores. Paged like every other full-table read here, because trusting one response
 * silently serves a partial answer the day the table outgrows PostgREST's max-rows.
 *
 * Null for every not-an-answer state — store off, table missing, store unwell — so the map
 * renders without heat rather than rendering "everything is cold" out of a blink.
 */
export async function noteHeat(): Promise<NoteHeat[] | null> {
  const e = env();
  if (!e) return null;
  try {
    const out: NoteHeat[] = [];
    const PAGE = 1000;
    for (let from = 0; ; from += PAGE) {
      const res = await pg(e, "note_scores?select=path,temperature,score,reads&order=path.asc", {
        headers: { Range: `${from}-${from + PAGE - 1}`, "Range-Unit": "items" },
      });
      if (!res.ok) return null;
      const rows = (await res.json()) as NoteHeat[];
      out.push(...rows.filter((r) => TEMPERATURES.has(r.temperature)));
      if (rows.length < PAGE) return out;
    }
  } catch (err) {
    console.error(`[pulse] note heat unavailable — the map renders without temperatures: ${String(err)}`);
    return null;
  }
}

export async function temperaturePulse(): Promise<TemperaturePulse | null> {
  const e = env();
  if (!e) return null;
  try {
    const [hot, warm, cold, pending, coldestRes] = await Promise.all([
      exactCount(e, "note_scores?select=path&temperature=eq.hot"),
      exactCount(e, "note_scores?select=path&temperature=eq.warm"),
      exactCount(e, "note_scores?select=path&temperature=eq.cold"),
      exactCount(e, "deletion_candidates?select=path&decision=is.null"),
      // temperature=eq.cold, not "the three lowest scores". Without the filter this named the
      // bottom three notes of ANY tier: the first time one note went cold the console would have
      // printed a count of 1 beside three names, two of them warm and loaded into every single
      // session — the console contradicting itself, which is this project's recurring failure.
      pg(e, "note_scores?select=path,score&temperature=eq.cold&order=score.asc&limit=3"),
    ]);
    if (hot === null || warm === null || cold === null || !coldestRes.ok) return null;
    return {
      hot,
      warm,
      cold,
      pendingDeletions: pending ?? 0,
      coldest: (await coldestRes.json()) as Array<{ path: string; score: number }>,
    };
  } catch (err) {
    console.error(`[pulse] temperatures unavailable: ${String(err)}`);
    return null;
  }
}
