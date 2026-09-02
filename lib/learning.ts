import { kv, kvEnv } from "./kv";
import { ANSCACHE_TTL_DAYS } from "./anscache";
import {
  HANDOFF_BUDGET_BYTES,
  MAX_HANDOFF_BUDGET_BYTES,
  MIN_HANDOFF_BUDGET_BYTES,
} from "./handoff";

/**
 * Learning settings — the knobs on what the learning layer does, in one KV object.
 *
 * The systems these govern (the answer cache, the handoff bundle, the watch checks) each shipped
 * with their behaviour fixed in code. This module makes those constants the FLOOR of a
 * resolution order rather than the whole answer: explicit call argument (where a tool has one),
 * then the console's selection here, then an env var, then the code default. Every knob fails
 * closed to today's behaviour — a fresh deployment with an empty store resolves to exactly the
 * constants that were hardcoded before this file existed.
 *
 * Same three laws as lib/settings.ts, because this is the same kind of object:
 *
 * 1. THE STORE HOLDS SELECTION, NOT STATE. Only knobs the operator actually set are stored, as
 *    a partial object. An untouched knob keeps falling through to env-and-code defaults, so
 *    setting one switch never freezes the other six at whatever they resolved to that day.
 * 2. THE STORE IS NOT THE AUTHORITY. Unreachable or unconfigured KV degrades to the defaults
 *    and says which fallback it is; nothing on the read path may throw because a knob's home
 *    was slow. (This is also why a malformed env value is a rendered conflict here rather than
 *    READER_MODEL's loud throw: READER_MODEL misconfigured breaks the one call that needs it,
 *    but a typo'd COACCESS_FLOOR taking down every inbox render would be the tail wagging the
 *    corpus.)
 * 3. A VALUE THAT CANNOT BE HONOURED IS REPORTED, NOT REPAIRED. A stored or env value off its
 *    bounds becomes a conflict sentence the screen prints verbatim, and the knob falls through
 *    to the next layer — never silently clamped into something the operator did not choose.
 */

/**
 * The co-read floor for the coaccess-gap inbox check — the CODE DEFAULT the console knob sits
 * on. The floor means exactly one thing and the check's precision filters did not change it:
 * the minimum shared one-hour windows before a pair is even a CANDIDATE, applied before the
 * mutual-top-K ranking and the mention scan (lib/inbox.ts) decide what surfaces. Measured on
 * the live note_edges 2026-08-11 — weights: 6×4, 5×2, 4×10, 3×41, 2×264 edges, and 272 of the
 * 321 pairs have no link either way. A floor of 4 admits eleven unlinked pairs as candidates
 * and 3 admits fifty-two — dozens, which is how the last queue died. 5 keeps the candidate set
 * to a handful before the specificity filters even run, and a pair that genuinely belongs
 * together keeps accruing windows until it crosses whatever the floor is. Lives here (not
 * lib/inbox.ts) because it is now a knob's default and the registry below is the one home for
 * those; lib/inbox.ts re-exports it for its callers and tests.
 */
export const COACCESS_FLOOR = 5;

/** The resolved value of every knob — the shape consumers read. */
export interface LearningValues {
  /** Answer cache on/off. Off: brain_ask skips both the lookup and the store. */
  ansCache: boolean;
  /** Days a cache entry is kept. Bounds storage only — invalidation is the head SHA in the key. */
  ansCacheTtlDays: number;
  /** brain_handoff's default bundle budget in bytes. A call's own budget argument still wins. */
  handoffBudget: number;
  watchSupersededLink: boolean;
  watchCoaccessGap: boolean;
  watchCorrectionChain: boolean;
  /** Shared one-hour windows before the coaccess-gap check fires. */
  coaccessFloor: number;
}

/** What the store holds: only the knobs a person actually set. */
export type LearningSelection = Partial<LearningValues>;

export type LearningKnob = keyof LearningValues;
export type KnobSource = "console" | "env" | "built-in";

/** The code defaults — byte-identical to the behaviour before these knobs existed. */
export const LEARNING_DEFAULTS: LearningValues = {
  ansCache: true,
  ansCacheTtlDays: ANSCACHE_TTL_DAYS,
  handoffBudget: HANDOFF_BUDGET_BYTES,
  watchSupersededLink: true,
  watchCoaccessGap: true,
  watchCorrectionChain: true,
  coaccessFloor: COACCESS_FLOOR,
};

/** Bounds on the numeric knobs. The handoff pair reuses the tool's own ceiling and floor —
 *  a console default outside what the call argument may ask for would be unreachable by hand. */
export const LEARNING_BOUNDS = {
  ansCacheTtlDays: { min: 1, max: 30 },
  handoffBudget: { min: MIN_HANDOFF_BUDGET_BYTES, max: MAX_HANDOFF_BUDGET_BYTES },
  coaccessFloor: { min: 2, max: 10 },
} as const;

/** The env layer, one var per knob. Blank or unset means "not chosen here". */
export const LEARNING_ENV: Record<LearningKnob, string> = {
  ansCache: "ANSWER_CACHE",
  ansCacheTtlDays: "ANSWER_CACHE_TTL_DAYS",
  handoffBudget: "HANDOFF_BUDGET",
  watchSupersededLink: "WATCH_SUPERSEDED_LINK",
  watchCoaccessGap: "WATCH_COACCESS_GAP",
  watchCorrectionChain: "WATCH_CORRECTION_CHAIN",
  coaccessFloor: "COACCESS_FLOOR",
};

const BOOL_KNOBS = [
  "ansCache",
  "watchSupersededLink",
  "watchCoaccessGap",
  "watchCorrectionChain",
] as const;
const NUM_KNOBS = ["ansCacheTtlDays", "handoffBudget", "coaccessFloor"] as const;

/** Human names for refusal and conflict sentences — a message naming a camelCase field reads
 *  like a stack trace, and these sentences land on a screen. */
const KNOB_WORDS: Record<LearningKnob, string> = {
  ansCache: "the answer-cache switch",
  ansCacheTtlDays: "the answer-cache TTL",
  handoffBudget: "the handoff budget",
  watchSupersededLink: "the superseded-link check switch",
  watchCoaccessGap: "the coaccess-gap check switch",
  watchCorrectionChain: "the correction-chain check switch",
  coaccessFloor: "the co-read floor",
};

const boundsWord = (k: (typeof NUM_KNOBS)[number]) =>
  `${LEARNING_BOUNDS[k].min}-${LEARNING_BOUNDS[k].max}`;

function inBounds(k: (typeof NUM_KNOBS)[number], v: number): boolean {
  return Number.isInteger(v) && v >= LEARNING_BOUNDS[k].min && v <= LEARNING_BOUNDS[k].max;
}

export interface LearningState {
  selection: LearningSelection;
  /** Where the selection came from — "store", or which kind of fallback this is. */
  source: "store" | "unconfigured" | "unreachable";
  /** Stored values that could not be honoured, in words the screen can print verbatim. */
  conflicts: string[];
}

/** A settings read must never hang a console render or a tool call — settings.ts's budget. */
const READ_TIMEOUT_MS = 1500;

const key = () => `cortex:learning:${kvEnv()}`;

/**
 * Parse whatever the store holds into a selection plus what had to be ignored. Never throws.
 * Unknown keys pass silently — a newer deploy may store knobs this one does not know, and an
 * older reader screaming about them would make every rollout a conflict parade. Known keys with
 * impossible values are the ones reported: those were chosen, and cannot be honoured.
 */
function parse(raw: unknown): { selection: LearningSelection; conflicts: string[] } {
  const conflicts: string[] = [];
  let o: unknown = raw;
  if (typeof o === "string") {
    try {
      o = JSON.parse(o) as unknown;
    } catch {
      return { selection: {}, conflicts: ["stored learning settings are not valid JSON — ignored"] };
    }
  }
  if (o === null || typeof o !== "object" || Array.isArray(o)) return { selection: {}, conflicts };
  const r = o as Record<string, unknown>;

  const selection: LearningSelection = {};
  for (const k of BOOL_KNOBS) {
    if (!(k in r)) continue;
    if (typeof r[k] === "boolean") selection[k] = r[k];
    else conflicts.push(`stored ${KNOB_WORDS[k]} is not on/off — ignored`);
  }
  for (const k of NUM_KNOBS) {
    if (!(k in r)) continue;
    const v = r[k];
    if (typeof v === "number" && inBounds(k, v)) selection[k] = v;
    else {
      conflicts.push(
        `stored ${KNOB_WORDS[k]} is not a whole number in ${boundsWord(k)} — ignored, falling back to ${resolveEnvOrDefaultWord(k)}`
      );
    }
  }
  return { selection, conflicts };
}

/** What a dropped stored value falls back TO, for the conflict sentence — env if one is set
 *  (whatever it parses to), the built-in otherwise. */
function resolveEnvOrDefaultWord(k: LearningKnob): string {
  return process.env[LEARNING_ENV[k]]?.trim() ? LEARNING_ENV[k] : String(LEARNING_DEFAULTS[k]);
}

export async function readLearning(): Promise<LearningState> {
  const r = kv();
  if (!r) return { selection: {}, source: "unconfigured", conflicts: [] };
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("kv read timeout")), READ_TIMEOUT_MS);
    });
    const raw = await Promise.race([r.get<unknown>(key()), timeout]);
    const { selection, conflicts } = parse(raw);
    return { selection, source: "store", conflicts };
  } catch {
    return { selection: {}, source: "unreachable", conflicts: [] };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Apply one screen click (or one hand-crafted POST) to the current selection. Refuses rather
 * than repairs — same rule as writeSettings: the one thing worse than a refused setting is a
 * silently adjusted one the screen then reports back as if it were what was asked for. `null`
 * clears a knob, handing it back to env-and-code defaults.
 */
export function applyLearningPatch(
  current: LearningSelection,
  patch: Record<string, unknown>
): LearningSelection {
  const next: LearningSelection = { ...current };
  for (const [k, v] of Object.entries(patch)) {
    if ((BOOL_KNOBS as readonly string[]).includes(k)) {
      const knob = k as (typeof BOOL_KNOBS)[number];
      if (v === null) delete next[knob];
      else if (typeof v === "boolean") next[knob] = v;
      else throw new Error(`${KNOB_WORDS[knob]} must be true or false`);
    } else if ((NUM_KNOBS as readonly string[]).includes(k)) {
      const knob = k as (typeof NUM_KNOBS)[number];
      if (v === null) delete next[knob];
      else if (typeof v === "number" && inBounds(knob, v)) next[knob] = v;
      else throw new Error(`${KNOB_WORDS[knob]} must be a whole number between ${boundsWord(knob)}`);
    } else {
      throw new Error(`"${k}" is not a learning setting`);
    }
  }
  return next;
}

/** Persist a whole selection. Validates everything again — the route validates too, but a
 *  second caller someday will not, and the store must never hold a value parse() would refuse. */
export async function writeLearning(next: LearningSelection): Promise<void> {
  for (const k of BOOL_KNOBS) {
    if (k in next && typeof next[k] !== "boolean") {
      throw new Error(`${KNOB_WORDS[k]} must be true or false`);
    }
  }
  for (const k of NUM_KNOBS) {
    if (k in next && !(typeof next[k] === "number" && inBounds(k, next[k]!))) {
      throw new Error(`${KNOB_WORDS[k]} must be a whole number between ${boundsWord(k)}`);
    }
  }
  const r = kv();
  if (!r) {
    throw new Error(
      "no KV store is configured, so a learning setting has nowhere durable to live — set the env vars instead"
    );
  }
  await r.set(key(), JSON.stringify(next));
}

export interface EffectiveLearning extends LearningValues {
  /** Where each resolved value came from, for the screen. */
  sources: Record<LearningKnob, KnobSource>;
  /** Store parse conflicts plus env values that could not be honoured. */
  conflicts: string[];
}

const TRUE_WORDS = new Set(["1", "true", "on", "yes"]);
const FALSE_WORDS = new Set(["0", "false", "off", "no"]);

/**
 * Resolve the effective values: console selection, then env, then the code default. Pure given
 * a state, so tests can hold every layer still. Env garbage degrades to the default WITH a
 * conflict — see law 2 in the header for why this is quieter than READER_MODEL's throw.
 */
export function resolveLearning(state: LearningState): EffectiveLearning {
  const conflicts = [...state.conflicts];
  const values = { ...LEARNING_DEFAULTS };
  const sources = Object.fromEntries(
    (Object.keys(LEARNING_DEFAULTS) as LearningKnob[]).map((k) => [k, "built-in" as KnobSource])
  ) as Record<LearningKnob, KnobSource>;

  for (const k of BOOL_KNOBS) {
    const env = process.env[LEARNING_ENV[k]]?.trim().toLowerCase();
    if (env) {
      if (TRUE_WORDS.has(env)) (values[k] = true), (sources[k] = "env");
      else if (FALSE_WORDS.has(env)) (values[k] = false), (sources[k] = "env");
      else conflicts.push(`${LEARNING_ENV[k]} is not on/off — ignored, using ${LEARNING_DEFAULTS[k] ? "on" : "off"}`);
    }
    if (k in state.selection) (values[k] = state.selection[k]!), (sources[k] = "console");
  }
  for (const k of NUM_KNOBS) {
    const env = process.env[LEARNING_ENV[k]]?.trim();
    if (env) {
      const n = Number(env);
      if (inBounds(k, n)) (values[k] = n), (sources[k] = "env");
      else {
        conflicts.push(
          `${LEARNING_ENV[k]} is not a whole number in ${boundsWord(k)} — ignored, using ${LEARNING_DEFAULTS[k]}`
        );
      }
    }
    if (k in state.selection) (values[k] = state.selection[k]!), (sources[k] = "console");
  }
  return { ...values, sources, conflicts };
}

/** The read-and-resolve most callers want: one KV GET, defaults on any degraded state. */
export async function effectiveLearning(): Promise<EffectiveLearning> {
  return resolveLearning(await readLearning());
}
