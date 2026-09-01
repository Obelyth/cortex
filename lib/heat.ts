/**
 * heat — the memory system's live state, computed for the console: every note's temperature,
 * what the boot call actually loads (THE SEAT), and who is pinned.
 *
 * THE SEAT IS DERIVED, NEVER ASSERTED. "In the seat" here means exactly what boot serves:
 * profile.md in full, the router rows routerCut keeps under the boot budget, and the recent
 * days cutRecentDays expands verbatim. All three walks are the SAME functions getContext runs
 * (lib/brain.ts, lib/frontmatter.ts) with the same constants — the header number is the boot
 * reply's own footer figure recomputed, not an estimate of it, and tests/heat.test.ts holds
 * the two in parity so they cannot drift apart silently.
 *
 * DELIBERATELY NO ACCESS LOGGING. Opening the console must not warm the notes it looks at:
 * note_scores counts every note_access row, so a heat view that logged reads would ratchet
 * its own display hotter each time the operator glanced at it — the bundle-feeding-its-own-
 * coaccess failure, one surface over.
 *
 * The rich score read lives here rather than widening MirrorStore: the boot path needs four
 * columns and keeps them; this screen needs the scoring's working (access/write components,
 * last read) to show intensity honestly, and a console-only need does not belong on the
 * interface every store fake in the tests must satisfy.
 */
import { loadCorpus } from "./corpus";
import { bubbleStore, renderBubble } from "./bubble";
import {
  cutRecentDays,
  lastNDates,
  RECENT_DAYS,
  ROUTER_BUDGET_BYTES,
} from "./brain";
import {
  buildRouter,
  routerCut,
  safeText,
  MAX_DESCRIPTION,
  type Temperature,
} from "./frontmatter";
import { logDigest } from "./digest";
import { redact } from "./redact";
import { readPins, type PinRow } from "./pins";

/** One row of note_scores with the scoring's working — what the migration's view exposes. */
export interface HeatScoreRow {
  path: string;
  reads: number;
  last_read: string | null;
  access_score: number;
  write_score: number;
  dir_prior: number;
  pinned: Temperature | null;
  score: number;
  temperature: Temperature;
}

const HEAT_TIMEOUT_MS = 10_000;

/** Test seam for the rich score read, same contract as the other stores: undefined = env. */
let overriddenScores: (() => Promise<HeatScoreRow[] | null>) | null | undefined;
export function __setHeatScores(f: (() => Promise<HeatScoreRow[] | null>) | null | undefined): void {
  overriddenScores = f;
}

/**
 * Every note's score row with its components, or null when the store cannot answer — off,
 * missing, unwell. Null and [] mean different things here and both are surfaced: null is
 * "scoring unavailable", [] is "the mirror holds no scored rows yet".
 */
export async function heatScores(): Promise<HeatScoreRow[] | null> {
  if (overriddenScores !== undefined) return overriddenScores ? overriddenScores() : null;
  const base = process.env.SUPABASE_URL?.replace(/\/$/, "");
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!base || !key) return null;
  try {
    const res = await fetch(
      `${base}/rest/v1/note_scores?select=path,reads,last_read,access_score,write_score,dir_prior,pinned,score,temperature&order=path.asc`,
      {
        headers: { apikey: key, Authorization: `Bearer ${key}` },
        signal: AbortSignal.timeout(HEAT_TIMEOUT_MS),
      }
    );
    if (!res.ok) return null;
    return (await res.json()) as HeatScoreRow[];
  } catch (err) {
    console.error(`[heat] note_scores unavailable — the heat view degrades to unscored: ${String(err)}`);
    return null;
  }
}

/** Why a note is in the seat. "profile" and "recent" ride verbatim; "router" rides as its
 *  one-line description. Null = not loaded at boot (still one call away). */
export type SeatKind = "profile" | "recent" | "router" | null;

export interface HeatTile {
  path: string;
  dir: string;
  /** ≈ chars/4 at the live commit — the same unit every console figure uses. */
  tokens: number;
  /** Null when scoring is unavailable — never faked cool. */
  temperature: Temperature | null;
  score: number | null;
  /** Total reads ever served, from note_access — all time, not a window. */
  reads: number;
  lastRead: string | null;
  /** Decayed-read share, 30-day half-life, normalised to the busiest note (0..1). */
  accessScore: number | null;
  /** Write recency, 21-day half-life on the last commit that touched the note (0..1). */
  writeScore: number | null;
  pinned: Temperature | null;
  pinReason: string;
  pinnedAt: string | null;
  seat: SeatKind;
}

export interface SeatFigures {
  /** ≈ body bytes / 4 — the same "~N tokens" figure the boot reply's own footer states. */
  tokens: number;
  bodyBytes: number;
  profileBytes: number;
  routerBytes: number;
  bubbleBytes: number;
  recentBytes: number;
  /** Router rows rendered / refused by the byte budget / not rendered because cold. */
  routerRows: number;
  droppedRows: number;
  coldRows: number;
  expandedDays: string[];
  digestedDays: string[];
  bubble: "live" | "empty" | "absent" | "failed";
  /** False when scoring is down: the router still renders, but unranked in path order. */
  ranked: boolean;
}

export interface HeatView {
  sha: string;
  /** Which live corpus this was computed from — notes, not files-in-repo. */
  noteCount: number;
  scoring: "scored" | "off" | "unavailable" | "empty";
  /** Scores exist but nothing has ever been read: the designed cold start, where write-recency
   *  and the directory prior carry every temperature. Said out loud, never painted as usage. */
  coldStart: boolean;
  /** False when note_pins could not be read (or cannot exist) — the pin controls then say so
   *  instead of rendering a writable-looking control over a store that is not there. */
  pinsAvailable: boolean;
  tiles: HeatTile[];
  seat: SeatFigures;
}

/**
 * The view, assembled from the live corpus, the score view and the pin table. Everything the
 * three treatments render comes from this one call — the data layer is built once, the
 * treatments are only renderings of it.
 */
export async function assembleHeat(): Promise<HeatView> {
  const store = bubbleStore();
  const [corpus, scores, pins, bubbleOutcome] = await Promise.all([
    loadCorpus(),
    heatScores(),
    readPins(),
    store
      ? store.open().then(
          (read) => ({ state: "read" as const, read }),
          () => ({ state: "failed" as const })
        )
      : Promise.resolve({ state: "absent" as const }),
  ]);

  const byPath = new Map<string, HeatScoreRow>();
  for (const s of scores ?? []) byPath.set(s.path, s);
  const pinByPath = new Map<string, PinRow>();
  for (const p of pins ?? []) pinByPath.set(p.path, p);

  // ── The seat, recomputed exactly as getContext assembles it ────────────────────────────────
  // Same constants, same walks, same redaction; the nonce is a fixed placeholder of the same
  // length as the real one (randomBytes(4).hex = 8 chars), so the byte count cannot wobble.
  const nonce = "00000000";
  const temps = new Map<string, { temperature: Temperature }>();
  for (const s of scores ?? []) temps.set(s.path, { temperature: s.temperature });

  const profile = corpus.files.get("profile.md");
  const profileSection =
    "# PROFILE\n\n" + (profile === undefined ? "(profile.md missing)" : redact(profile));

  const routerStr = buildRouter(corpus.files, temps, ROUTER_BUDGET_BYTES);
  const cut = routerCut(corpus.files, temps, ROUTER_BUDGET_BYTES);

  const bubbleSection = bubbleOutcome.state === "read" ? renderBubble(bubbleOutcome.read) : "";
  const present = lastNDates(RECENT_DAYS).filter((d) => corpus.files.has(`log/${d}.md`));
  const { expand, elide } = bubbleSection
    ? { expand: [] as string[], elide: [...present] }
    : cutRecentDays(present, corpus.files);

  let recentSection = "";
  if (present.length > 0) {
    const blocks = [
      ...expand.map(
        (d) => `--- ${nonce} log/${d}.md ---\n${redact(corpus.files.get(`log/${d}.md`)!)}`
      ),
      ...elide.map((d) => {
        const { description } = logDigest(corpus.files.get(`log/${d}.md`)!);
        return `--- log/${d}.md · ${safeText(description, MAX_DESCRIPTION)} · not expanded — brain_read log/${d}.md for the full day ---`;
      }),
    ];
    recentSection = `# RECENT (last ${RECENT_DAYS} days)\n\n${blocks.join("\n\n")}`;
  }

  const parts = [profileSection, routerStr];
  if (bubbleSection) parts.push(bubbleSection);
  if (recentSection) parts.push(recentSection);
  const bodyBytes = parts.join("\n\n").length;

  // ── Seat membership per note ────────────────────────────────────────────────────────────────
  // Precedence: verbatim beats a router line. profile.md also has a router row; the row is not
  // the reason it is in the seat.
  const seatOf = new Map<string, SeatKind>();
  for (const e of cut.rendered) seatOf.set(e.path, "router");
  for (const d of expand) seatOf.set(`log/${d}.md`, "recent");
  if (profile !== undefined) seatOf.set("profile.md", "profile");

  // ── Tiles ───────────────────────────────────────────────────────────────────────────────────
  const tiles: HeatTile[] = [];
  for (const [path, text] of corpus.files) {
    const s = byPath.get(path);
    const p = pinByPath.get(path);
    tiles.push({
      path,
      dir: path.includes("/") ? path.split("/")[0] : "root",
      tokens: Math.round(text.length / 4),
      temperature: s?.temperature ?? null,
      score: s?.score ?? null,
      reads: s?.reads ?? 0,
      lastRead: s?.last_read ?? null,
      accessScore: s?.access_score ?? null,
      writeScore: s?.write_score ?? null,
      // The pin table is the authority (it carries reason and date); the score view's pinned
      // column backstops a pins-read blip so a placed pin never silently unmarks itself.
      pinned: p?.temperature ?? s?.pinned ?? null,
      // Operator-entered text, scrubbed at egress like every other foreign string.
      pinReason: p ? safeText(p.reason, 200) : "",
      pinnedAt: p?.pinned_at ?? null,
      seat: seatOf.get(path) ?? null,
    });
  }
  tiles.sort((a, b) => (b.score ?? 0) - (a.score ?? 0) || a.path.localeCompare(b.path));

  // Derived from what the read RETURNED, not from env alone: null with no store configured is
  // "off" (scoring cannot exist here), null with one configured is "unavailable" (it did not
  // answer this render) — different sentences, different fixes, never conflated.
  const off = !process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY;
  const scoring =
    scores === null ? (off ? "off" : "unavailable") : scores.length === 0 ? "empty" : "scored";

  return {
    sha: corpus.sha.slice(0, 12),
    noteCount: corpus.files.size,
    scoring,
    coldStart: scoring === "scored" && scores!.every((s) => s.reads === 0),
    pinsAvailable: pins !== null,
    tiles,
    seat: {
      tokens: Math.round(bodyBytes / 4),
      bodyBytes,
      profileBytes: profileSection.length,
      routerBytes: routerStr.length,
      bubbleBytes: bubbleSection.length,
      recentBytes: recentSection.length,
      routerRows: cut.rendered.length,
      droppedRows: cut.dropped.length,
      coldRows: cut.cold.length,
      expandedDays: expand,
      digestedDays: elide,
      bubble:
        bubbleOutcome.state === "read"
          ? bubbleSection
            ? "live"
            : "empty"
          : bubbleOutcome.state,
      ranked: scores !== null && scores.length > 0,
    },
  };
}
