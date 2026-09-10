import { requireSecret } from "@/lib/gate";
import { readCalls } from "@/lib/calls";
import { CUT_STAMP, TIMED_OUT_STAMP } from "@/lib/deadline";
import { edgesPulse } from "@/lib/edges";
import { assembleHeat } from "@/lib/heat";
import { listSkipped } from "@/lib/corpus";
import { opsBoard } from "@/lib/ops-board";
import { readSettings, safeActiveReader } from "@/lib/settings";
import { DEFAULT_K, DEFAULT_MAX_PARTS_PER_PAGE, NARROW_BUDGET_BYTES } from "@/lib/ask";
import { DEFAULT_MAX_LOGS } from "@/lib/narrow";
import { ROUTER_BUDGET_BYTES } from "@/lib/brain";
import roster from "@/lib/tool-roster.json";
import { consoleHealth } from "../loaders";
import { PROCESS_CEILING, spentThisInstance } from "./ceiling";
import { AskScreen } from "./ask-screen";
import { sortFrom, type AskModel, type Connections, type RetractedLine, type ToolFacts } from "./ask-model";
import "./ask.css";

export const dynamic = "force-dynamic";
export const maxDuration = 60;
export const metadata = { title: "Ask · Cortex console" };

/**
 * Ask — the explorer, the ask, and what it read (v2).
 *
 * The Notes screen folded in here as a file-type explorer: the whole live corpus as files —
 * directory tree, kinds, counts, stamps, temperatures — every note trackable in the lens, and
 * every answer showing its work: what was narrowed and why, what was read, what was quoted, at
 * which commit, at what cost. "No black box." This file is the server half only: gate, load,
 * serialize. The composition is ask-screen.tsx; the state is ask-explorer.tsx.
 *
 * The roster below is READ FROM lib/tool-roster.json, never retyped. That file is pinned to
 * registerTools() by a test, and its own comment records that a hardcoded roster going stale in
 * a verifier caused three separate multi-night outages.
 */
const WHAT: Record<string, string> = {
  brain_ask: "Fetches the whole live corpus, hands a reader model the actual notes, then checks the quote it cited against the file.",
  brain_corpus: "Returns the notes into the calling conversation instead, with no model call at all.",
  brain_context: "The boot call: profile, the router, and the bubble — what every session pays before you type.",
  brain_bubble: "Working memory: list, add, update in place, file into a note, or drop.",
  brain_handoff: "One call resumes a project: page, bubble items, log mentions and graph neighbours — every piece cited, the bundle budgeted.",
  brain_read: "One note, by path.",
  brain_write: "Create, replace, append, or edit in place. Returns the commit SHA.",
  brain_capture: "Timestamped append to today's log. Zero friction, any device.",
  brain_propose: "Guest-only. Leaves a suggestion in a review queue — commits nothing, ever.",
  brain_proposals: "The review queue, for the door that may decide.",
  brain_accept: "Accepting is what commits.",
  brain_reject: "Rejecting leaves no trace.",
};

const DAY = 86_400_000;

export default async function Ask({
  params,
  searchParams,
}: {
  params: Promise<{ secret: string }>;
  searchParams: Promise<{ note?: string; q?: string; find?: string; sort?: string }>;
}) {
  await requireSecret(params);
  const sp = await searchParams;
  const now = Date.now();

  // No data dependency between these; serial awaits would stack GitHub, Postgres and KV round
  // trips for nothing. consoleHealth and assembleHeat share loadCorpus's per-instance cache, so
  // the corpus is fetched once; listSkipped is its own read (archive/ is never in the corpus).
  const [h, heat, skipped, settings, calls, edges, board] = await Promise.all([
    consoleHealth(),
    assembleHeat(),
    listSkipped(),
    readSettings(),
    readCalls(30 * DAY, now),
    edgesPulse(),
    opsBoard(),
  ]);
  const { active, error: readerError } = await safeActiveReader(settings);

  // "off" collapses to null — the opt-in law: with no SUPABASE_URL there is no graph store, so
  // the panel does not render at all rather than rendering an apology. Every OTHER state
  // reaches the client, because each one names something true the operator can act on.
  const connections: Connections | null =
    edges.state === "off"
      ? null
      : edges.state === "built"
        ? { state: "built", head: edges.head.slice(0, 8), builtAt: edges.builtAt, byNote: edges.byNote }
        : { state: edges.state };

  // Grouped once here so the client gets a plain serializable map, capped per note — the lens
  // is a glance, not the attention screen.
  const retractedByPath: Record<string, RetractedLine[]> = {};
  for (const r of h.retractedList) (retractedByPath[r.path] ??= []).push({ line: r.line, heading: r.heading, text: r.text });
  for (const k of Object.keys(retractedByPath)) retractedByPath[k] = retractedByPath[k].slice(0, 6);

  // The seat strip: exactly what one brain_context boot call serves at this head.
  const s = heat.seat;
  const tokOf = (bytes: number) => Math.round(bytes / 4);
  const bubbleWord =
    s.bubble === "live" ? `bubble live ~${tokOf(s.bubbleBytes).toLocaleString("en-US")} tok`
    : s.bubble === "empty" ? "an empty bubble"
    : s.bubble === "failed" ? "bubble unavailable this render"
    : "no bubble on this deploy";
  const recentWord = s.expandedDays.length
    ? `${s.expandedDays.length} recent day${s.expandedDays.length === 1 ? "" : "s"} verbatim ~${tokOf(s.recentBytes).toLocaleString("en-US")} tok`
    : s.digestedDays.length
      ? `${s.digestedDays.length} recent day${s.digestedDays.length === 1 ? "" : "s"} as digest lines`
      : "no recent days";
  const seatParts = [
    heat.tiles.some((t) => t.seat === "profile") ? "profile included" : "no profile.md",
    `router ${s.routerRows} rows${s.ranked ? "" : " · unranked"} · ${s.droppedRows} refused by the ${Math.round(ROUTER_BUDGET_BYTES / 1000)} KB budget · ${s.coldRows} cold not rendered`,
    bubbleWord,
    recentWord,
  ];

  // How answers checked out — the last 24 h of the 30 d window, by the stamp the log recorded.
  const asks = calls.rows.filter((r) => r.tool === "brain_ask" && r.ts >= now - DAY);
  const count = (stamp: string) => asks.filter((r) => r.stamp === stamp).length;
  const glance = {
    asks: asks.length,
    verified: count("VERIFIED") + count("CORRECTED"),
    superseded: count("SUPERSEDED"),
    partial: count("PARTIALLY VERIFIED"),
    unverified: count("UNVERIFIED"),
    notInBrain: count("NOT IN BRAIN"),
    errors: count("ERROR"),
    cutOff: count(CUT_STAMP),
    timedOut: count(TIMED_OUT_STAMP),
    source: calls.source,
    covers: calls.covers,
  };

  // Both memberships are real: painting "trusted" on every row would show brain_propose as
  // reachable from the trusted doors, which is exactly backwards.
  const trusted = new Set<string>(roster.trusted);
  const guest = new Set<string>(roster.guest);
  const tools: ToolFacts[] = [...new Set([...roster.trusted, ...roster.guest])].sort().map((name) => ({
    name,
    doors: [trusted.has(name) ? "trusted" : null, guest.has(name) ? "guest" : null].filter(Boolean).join(" · "),
    what: WHAT[name] ?? "",
    trusted: trusted.has(name),
    guest: guest.has(name),
    calls: calls.durable ? calls.rows.filter((r) => r.tool === name).length : null,
  }));

  const model: AskModel = {
    sha: h.sha,
    notes: h.notes.map((n) => ({ path: n.path, dir: n.dir, title: n.title, desc: n.desc, headings: n.headings, tokens: n.tokens, blocks: n.blocks, retracted: n.retracted, age: n.age, decays: n.decays })),
    heat: heat.tiles.map((t) => ({ path: t.path, temperature: t.temperature, score: t.score, reads: t.reads, seat: t.seat, pinned: t.pinned, pinReason: t.pinReason, lastRead: t.lastRead })),
    skipped: skipped ? skipped.files : null,
    retractedByPath,
    connections,
    units: board.groups.flatMap((g) => g.rows).map((r) => ({ id: r.id, name: r.name, state: r.stateLabel })),
    tools,
    reader: active?.model ?? null,
    readerError,
    spent: spentThisInstance(),
    ceiling: PROCESS_CEILING,
    narrowing: { k: DEFAULT_K, maxLogs: DEFAULT_MAX_LOGS, maxPartsPerPage: DEFAULT_MAX_PARTS_PER_PAGE, budgetBytes: NARROW_BUDGET_BYTES },
    corpusTokens: h.totals.tokens,
    seat: { tokens: s.tokens, parts: seatParts },
    scoring: heat.scoring,
    coldStart: heat.coldStart,
    pinsAvailable: heat.pinsAvailable,
    glance,
    repoUrl: process.env.BRAIN_REPO ? `https://github.com/${process.env.BRAIN_REPO}` : null,
    initial: { note: sp.note?.trim() || null, q: sp.q?.trim() || null, find: sp.find?.trim() || null, sort: sortFrom(sp.sort) },
  };

  return <AskScreen model={model} />;
}
