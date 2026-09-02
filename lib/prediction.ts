/**
 * prediction — the one opinion of "what is this session about to need", shared by the eval that
 * gates it and the product that ships it.
 *
 * Layer 1 of the learning layer (spec 2026-08-11, "usage learning"). Everything here is pure,
 * deterministic and model-free: same rows in, same numbers out, which is what lets
 * scripts/eval-prediction.ts replay history for free on every PR.
 *
 * THE MEASURED VERDICT (2026-08-11, 19 scored windows): BASELINE 38.0% recall@10,
 * CANDIDATE 31.5% — the blend LOST, exactly the way FTS lost to BM25, and the incumbent
 * therefore stands: lib/handoff.ts ranks its bundle by recency+frequency (which in production
 * is the live temperature score — this module's baseline is that same signal, replayable), and
 * uses KIND_BLEND only as the tiebreak and the scores-unavailable fallback. Five days of log is
 * thin evidence; the candidate machinery stays here so the eval can re-ask the question as the
 * log grows — but no ranking change ships until it wins on the replay. Same law as everything
 * else: measured gates, not vibes.
 *
 * WHY THE BASELINE IS A PROXY. The incumbent to beat is temperature ranking, but note_scores is
 * a LIVE table — it holds today's temperatures, and replaying history against today's scores
 * would grade every past session with information from its own future. Historical temperature at
 * each window cannot be reconstructed (the scoring inputs were never snapshotted), so the
 * baseline here recomputes the same two ingredients temperature is made of — recency and
 * frequency of access — from exactly the rows that existed before the window being predicted.
 * It is a proxy and says so; it is not an attempt to rebuild note_scores.
 */
import { byName } from "./frontmatter";

/** One note_access row, reduced to what prediction can legitimately see. */
export interface AccessEvent {
  /** ISO timestamp (note_access.at). */
  at: string;
  path: string;
}

/**
 * A clock-hour of non-boot access rows, standing in for "a session". The same window the
 * coaccess derivation in edges_rebuild uses (date_trunc('hour', at)) — two definitions of
 * "together" that disagreed would make the eval grade a signal the graph does not carry.
 */
export interface SessionWindow {
  /** Epoch ms of the hour boundary. */
  start: number;
  /** Distinct paths touched in the window, sorted for determinism. */
  paths: string[];
}

/** Recency decay half-life. Seven days: the boot call's own definition of "recent". */
export const HALF_LIFE_DAYS = 7;

/**
 * How much each edge kind is worth when weighing "likely next" material, relative to coaccess.
 *
 * Coaccess is the strongest signal because it is the only BEHAVIOURAL one — the operator's own
 * hands putting two notes in the same hour, repeatedly. Links and corrections are deliberate
 * authored references; tags are shared vocabulary; lexical similarity is the weakest, being an
 * observation about words rather than about work.
 *
 * Where these numbers actually run today: the handoff bundle's TIEBREAK and its
 * scores-unavailable fallback (see the module comment — the blend lost the replay as a primary
 * ranking). The eval's candidate ranker scores the three kinds derivable from replayed data
 * (coaccess, link, tag) with these same constants, so any future promotion of the blend to
 * primary is a change the eval already measures.
 */
export const KIND_BLEND: Record<"coaccess" | "link" | "tag" | "lexical" | "correction", number> = {
  coaccess: 1.0,
  link: 0.6,
  tag: 0.3,
  lexical: 0.2,
  correction: 0.6,
};

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

/** The hour bucket an event falls in — UTC, matching date_trunc('hour') in the rebuild RPC. */
export function hourOf(at: string): number {
  return Math.floor(Date.parse(at) / HOUR_MS) * HOUR_MS;
}

/**
 * Group access events into hour-window sessions, oldest first. Rows whose timestamp does not
 * parse are dropped rather than guessed into a window — an unparseable `at` is a broken row,
 * and inventing a time for it would seat it in someone else's session.
 */
export function sessionize(rows: AccessEvent[]): SessionWindow[] {
  const byHour = new Map<number, Set<string>>();
  for (const r of rows) {
    const t = Date.parse(r.at);
    if (!Number.isFinite(t)) continue;
    const h = Math.floor(t / HOUR_MS) * HOUR_MS;
    if (!byHour.has(h)) byHour.set(h, new Set());
    byHour.get(h)!.add(r.path);
  }
  return [...byHour.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([start, set]) => ({ start, paths: [...set].sort(byName) }));
}

/** exp2-decay weight for something last seen `ageMs` before the moment being predicted. */
function decay(ageMs: number): number {
  return Math.pow(0.5, Math.max(0, ageMs) / (HALF_LIFE_DAYS * DAY_MS));
}

/**
 * BASELINE — recency + frequency from the prior log alone, one number per note: every prior
 * access contributes a half-life-decayed unit, so a note read often and recently outranks one
 * read once long ago. This is the proxy for temperature described in the module comment: the
 * same ingredients, recomputed from only the rows that legitimately exist at `now`.
 */
export function baselineScores(prior: AccessEvent[], now: number): Map<string, number> {
  const scores = new Map<string, number>();
  for (const r of prior) {
    const t = Date.parse(r.at);
    if (!Number.isFinite(t) || t >= now) continue;
    scores.set(r.path, (scores.get(r.path) ?? 0) + decay(now - t));
  }
  return scores;
}

/** Order-free pair key for the co-occurrence and structural tables. NUL as the separator
 *  because it is the one byte a note path can never contain — the same reasoning as the
 *  linkEdges key — and it is written as an escape so the convention is visible in source.
 *  Exported: StructuralEdges keys MUST be built with this, or the scorer cannot find them. */
export function pairKey(a: string, b: string): string {
  return byName(a, b) <= 0 ? `${a}\u0000${b}` : `${b}\u0000${a}`;
}

/**
 * Co-occurrence counts over prior windows: in how many distinct hour-windows were two notes
 * touched together? Same definition as the coaccess edge derivation, including the ≥2 floor
 * being the CONSUMER's job — this table reports every pair and lets the scorer weigh it,
 * because a replayed history is exactly where a one-window pair still carries a little signal.
 */
export function cooccurrence(priorWindows: SessionWindow[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const w of priorWindows) {
    for (let i = 0; i < w.paths.length; i++) {
      for (let j = i + 1; j < w.paths.length; j++) {
        const k = pairKey(w.paths[i], w.paths[j]);
        counts.set(k, (counts.get(k) ?? 0) + 1);
      }
    }
  }
  return counts;
}

/** Structural neighbours of a note, from the corpus: explicit links and shared tags. The eval
 *  hands this in derived from lib/edges.ts's linkEdges/tagEdges over the corpus. */
export interface StructuralEdges {
  /** pairKey(a,b) → true for an explicit [[link]] in either direction. */
  links: Set<string>;
  /** pairKey(a,b) → number of shared frontmatter tags. */
  tags: Map<string, number>;
}

/**
 * CANDIDATE — the baseline blended with what the prior data says travels together.
 *
 * On top of each note's own recency+frequency, every previously-touched note q pulls its
 * neighbours p up in proportion to (a) how recently q was touched and (b) how strongly p and q
 * are connected: co-accessed hours at KIND_BLEND.coaccess, an explicit link at KIND_BLEND.link,
 * shared tags at KIND_BLEND.tag. log1p on the counted signals so one obsessive fortnight with a
 * pair of notes cannot drown every other neighbour forever.
 */
export function candidateScores(
  prior: AccessEvent[],
  priorWindows: SessionWindow[],
  structure: StructuralEdges,
  now: number,
  blend: typeof KIND_BLEND = KIND_BLEND
): Map<string, number> {
  const scores = baselineScores(prior, now);
  const cooc = cooccurrence(priorWindows);

  // Each note's most recent prior touch — the "pull" a note exerts on its neighbours fades on
  // the same half-life as everything else here.
  const lastTouch = new Map<string, number>();
  for (const r of prior) {
    const t = Date.parse(r.at);
    if (!Number.isFinite(t) || t >= now) continue;
    if (t > (lastTouch.get(r.path) ?? -Infinity)) lastTouch.set(r.path, t);
  }

  // The candidate pool is everything either signal can name: previously-touched notes plus
  // their structural neighbours. Iterating pairs (not the full corpus product) keeps this
  // linear in the data rather than quadratic in the brain.
  const pull = new Map<string, number>();
  const addPull = (p: string, amount: number) => {
    if (amount > 0) pull.set(p, (pull.get(p) ?? 0) + amount);
  };
  const pairSignal = (k: string): number => {
    const c = cooc.get(k) ?? 0;
    const t = structure.tags.get(k) ?? 0;
    return (
      blend.coaccess * Math.log1p(c) +
      (structure.links.has(k) ? blend.link : 0) +
      blend.tag * Math.log1p(t)
    );
  };

  const seen = new Set<string>([...cooc.keys(), ...structure.links, ...structure.tags.keys()]);
  for (const k of seen) {
    const [a, b] = k.split("\u0000");
    const s = pairSignal(k);
    if (s <= 0) continue;
    const ta = lastTouch.get(a);
    const tb = lastTouch.get(b);
    if (ta !== undefined) addPull(b, decay(now - ta) * s);
    if (tb !== undefined) addPull(a, decay(now - tb) * s);
  }

  for (const [p, s] of pull) scores.set(p, (scores.get(p) ?? 0) + s);
  return scores;
}

/** Top-k paths by score, path-name tiebreak so equal scores never reorder between runs. */
export function topK(scores: Map<string, number>, k: number): string[] {
  return [...scores.entries()]
    .sort((a, b) => b[1] - a[1] || byName(a[0], b[0]))
    .slice(0, k)
    .map(([p]) => p);
}

/**
 * recall@k for one window: what fraction of the notes the session actually touched were in the
 * top-k prediction. A window that touched more than k notes cannot score 1.0 at k — true of
 * both rankers equally, and truer to the product question ("did the bundle contain what was
 * needed") than capping the denominator would be.
 */
export function recallAtK(predicted: string[], touched: string[], k: number): number {
  if (touched.length === 0) return 0;
  const top = new Set(predicted.slice(0, k));
  let hit = 0;
  for (const p of touched) if (top.has(p)) hit++;
  return hit / touched.length;
}
