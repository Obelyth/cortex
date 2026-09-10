import type { AlsoTool, AlsoUnit, ExplorerHeat, ExplorerNote, ExplorerSort, SkippedFile } from "@/lib/explorer";
import type { NoteEdge } from "@/lib/edges";

/**
 * What the Ask screen is handed, and what an ask hands back. page.tsx builds AskModel from the
 * live loaders; scripts/dev/render-ask.tsx builds one from fixtures; the client
 * (ask-explorer.tsx) reads nothing else. Plain data — serializable, so the server can pass it
 * across the client boundary and a test can hold it still.
 */

/** A live note as the explorer and the note lens see it — lib/health.ts NoteRow, slimmed. */
export interface NoteFacts extends ExplorerNote {
  dir: string;
  desc: string;
  headings: Array<{ h: string; line: number }>;
  blocks: number;
}

/** A heat tile as the lens needs it — lib/heat.ts HeatTile, slimmed. */
export interface HeatFacts extends ExplorerHeat {
  lastRead: string | null;
}

export interface RetractedLine {
  line: number;
  heading: string;
  text: string;
}

/**
 * The connections graph, as the lens receives it. "off" never reaches the client — the page
 * collapses it to null so an unconfigured deployment renders no panel at all (the opt-in law).
 * Every other degraded state does arrive, because each names something true.
 */
export type Connections =
  | { state: "missing" | "empty" | "unavailable" }
  | { state: "built"; head: string; builtAt: string; byNote: Record<string, NoteEdge[]> };

export interface ToolFacts extends AlsoTool {
  /** What the tool does, in the product's own sentence. */
  what: string;
  trusted: boolean;
  guest: boolean;
  /** Calls in the last 30 d from this environment's log; null when the log is not durable. */
  calls: number | null;
}

/** How answers checked out in the last 24 h, from readCalls — the empty readout's line. */
export interface Glance {
  asks: number;
  verified: number;
  superseded: number;
  partial: number;
  unverified: number;
  notInBrain: number;
  errors: number;
  /** Asks the platform killed at the wall — a started row whose final row never came. */
  cutOff: number;
  /** Asks the request deadline stopped inside the budget — the corpus did not load in time. */
  timedOut: number;
  source: "store" | "unconfigured" | "unreachable";
  /** Milliseconds the call log actually spans. Under a day the 24 h figure is over a
   *  shorter window and has to say so. */
  covers: number;
}

export interface AskModel {
  /** The live head, in full; the screen prints sha8 and links the rest. */
  sha: string;
  notes: NoteFacts[];
  heat: HeatFacts[];
  /** archive/ as a listing, or null when it could not be made this render. */
  skipped: SkippedFile[] | null;
  retractedByPath: Record<string, RetractedLine[]>;
  connections: Connections | null;
  units: AlsoUnit[];
  tools: ToolFacts[];
  /** The reader that would answer, or null with the reason. */
  reader: string | null;
  readerError: string | null;
  /** Asks this instance has answered, against its ceiling — printed before the first ask. */
  spent: number;
  ceiling: number;
  /** The caps the narrowing applies, by name, for the hint and the busy steps. */
  narrowing: { k: number; maxLogs: number; maxPartsPerPage: number; budgetBytes: number };
  corpusTokens: number;
  /** The seat strip: the figure, then one clause per part. */
  seat: { tokens: number; parts: string[] };
  scoring: "scored" | "off" | "unavailable" | "empty";
  coldStart: boolean;
  pinsAvailable: boolean;
  glance: Glance;
  /** https://github.com/<BRAIN_REPO>, or null when the repo is not named on this deploy. */
  repoUrl: string | null;
  /** The query string, already read: ?note= opens the lens, ?q= prefills, ?find= seeds the filter, ?sort= sorts. */
  initial: { note: string | null; q: string | null; find: string | null; sort: ExplorerSort | null };
}

export type CutBy = "log-cap" | "parts-cap" | "budget" | "k";

/** The reply from POST ask/run, as the route writes it. The stamp arrives decided. */
export interface AskAnswer {
  stamp: string;
  stampLine: string;
  answer: string;
  model: string;
  commit: string;
  packTokens: number;
  corpusTokens: number;
  candidates: string[];
  notInBrain: boolean;
  protocol: import("@/lib/ask").AskResult["protocol"];
  coverage: import("@/lib/ask").Coverage;
  citedOutsidePack: boolean;
  unresolvedTag: boolean;
  citation: {
    path: string;
    evidence: string;
    verified: boolean;
    reason: string;
    commit: string;
    line: number | null;
    heading: string | null;
    superseded: boolean;
  } | null;
  shortlist: Array<{ rank: number; path: string; score: number | null; terms: string[]; bytes: number }>;
  cut: Array<{ path: string; score: number; by: CutBy }>;
  zeroCount: number;
  narrowing: { mode: "narrowed" | "fallback" | "full"; k: number; budgetBytes: number; maxLogs: number | null; maxPartsPerPage: number | null };
  ms: number;
  spent: number;
  ceiling: number;
}

/** The sort words the URL may carry. Anything else is "name". */
export function sortFrom(v: string | undefined | null): ExplorerSort | null {
  return v === "name" || v === "heat" || v === "size" || v === "stamp" ? v : null;
}

/** 247439 → "247,439"; the console's one number format. */
export const num = (n: number): string => n.toLocaleString("en-US");

/** Tokens past 10k print as "64.4k"; below, in full. The group row's ledger figure. */
export const tok = (n: number): string => (n >= 10_000 ? `${(n / 1000).toFixed(1)}k` : num(n));
