/**
 * hop — graph-assisted narrowing: BM25's shortlist, widened by one hop along note_edges.
 *
 * Layer 2 of the learning layer (spec 2026-08-11): "candidates = BM25 top-k ∪ 1-hop neighbours
 * of the top hits. Ships only if eval-retrieval says it beats the incumbent — otherwise it stays
 * a query surface like search_notes()." This module is that machinery, built EVAL-FIRST: every
 * shape below ran the full labelled set before anything was allowed near the default path.
 *
 * THE FAILURE MODE THIS IS DESIGNED AGAINST is on the record (the retrieval decision note
 * behind this module): the FTS hybrid "won" at k=10 and LOST at k=5, because interleaving spends scarce candidate
 * slots on the weaker arm. A union is not free — every slot a hop neighbour takes is a slot a
 * BM25 candidate loses. So displacement here is explicit, bounded, and k-aware: a config says
 * exactly how many bottom slots hops may claim (`tailSlots`) and below what budget they may
 * claim none at all (`displaceAboveK`). BM25's protected prefix is never reordered and never
 * displaced; hops otherwise only FILL — when BM25 itself ran out of positive-score candidates.
 *
 * MEASURED, 2026-08-11 — 170 routable labels, 97-note corpus, 1,516 edges (coaccess live from
 * prod). The incumbent column is BM25 re-measured in the SAME RUN, because the recorded
 * 97.6/95.3 was the 86-note corpus and a gate that compares across snapshots compares nothing:
 *
 *   strategy                 recall@10   recall@5
 *   BM25 (incumbent)             95.3%      90.6%
 *   hop fill-only                95.3%      90.6%
 *   hop tail-1 all-kinds         95.3%      87.1%
 *   hop tail-2 structural        94.7%      85.3%
 *   hop tail-2 strong            94.7%      85.3%
 *   hop k-aware tail-2           94.7%      90.6%
 *   hop tail-2 coaccess          94.7%      85.3%
 *
 * THE GATE SAID NO, so NOTHING ROUTES THROUGH THIS MODULE BY DEFAULT — it ships as a query
 * capability, the precedent search_notes() set: built, measured, kept off the path. No shape
 * beat the incumbent on either k, let alone both: every displacing shape lost at k=5 (tail-2
 * also at k=10), because a hop slot is paid for with a BM25 candidate that turned out to be the
 * labelled note more often than the neighbour was. That is the FTS-hybrid lesson
 * reproduced a second time with a different second arm, which upgrades it from an observation
 * about FTS to a property of this corpus: BM25's tail is not weak enough to be worth spending.
 * The non-displacing shapes (fill-only, and k-aware at or below its threshold) tie the incumbent
 * exactly, because BM25 underfills on almost no labelled question — they are insurance, not lift.
 * (The displacing rows' higher MRR is an artifact, not a consolation: MRR averages only over
 * FOUND labels, and what displacement lost was precisely the deep-ranked ones.)
 *
 * Six shapes were measured and the sweep stopped there on purpose: a seventh, eighth, ninth
 * variation until one clears the bar is not a better retriever, it is overfitting 170 labels
 * and shipping the noise.
 */
import { rank, narrow } from "./narrow";
import { byName } from "./frontmatter";
import type { EdgeRow } from "./edges";

export type HopKind = EdgeRow["kind"];

/** One end of an edge, as seen from a note: who the neighbour is and how strong the tie. */
export interface HopNeighbour {
  other: string;
  kind: HopKind;
  weight: number;
}

/**
 * Every kind EXCEPT lexical is "structural" for hop purposes. Lexical edges are each note's
 * top-K BM25 neighbours — built by the SAME scorer that produced the shortlist being widened,
 * so a lexical hop is redundant with BM25 by construction: it mostly re-reaches notes the
 * ranking already placed, and where it differs it is the scorer disagreeing with itself about
 * a different query. The eval bears the redundancy out — no lexical-bearing shape gained a
 * single label anywhere. Documented here because the graph stores lexical edges for the
 * console's benefit, and a reader of this file should know why retrieval's structural set
 * deliberately leaves them out.
 */
export const STRUCTURAL_KINDS: readonly HopKind[] = ["link", "tag", "coaccess", "correction"];
export const ALL_KINDS: readonly HopKind[] = ["link", "tag", "coaccess", "lexical", "correction"];

export interface HopConfig {
  /** Bottom-of-pack slots hop neighbours may claim from BM25. 0 = fill-only: BM25's own top-k
   *  is inviolate and hops only enter when BM25 underfills. */
  tailSlots: number;
  /** Displacement is allowed only when k EXCEEDS this. At or below it, tailSlots is treated as
   *  0 — the k-aware answer to the FTS lesson: never spend a scarce slot on the weaker arm. */
  displaceAboveK: number;
  /** How many top BM25 hits contribute their neighbourhoods. Fixed at 3 across every measured
   *  shape — sweeping it too would multiply the config space past what 170 labels can support. */
  seeds: number;
  kinds: readonly HopKind[];
  /** Minimum edge weight. Link/tag/correction weights are small integers (reference count,
   *  shared-tag count); coaccess is a co-read count. 0 = every edge. */
  minWeight: number;
}

/**
 * The measured shapes, frozen. The eval harness runs exactly these — the table in the header is
 * reproducible by name, and a shape that was never measured cannot quietly become a default.
 * SIX IS THE CEILING, asserted by tests: more shapes than this is overfitting the label set.
 */
export const HOP_SHAPES: Readonly<Record<string, HopConfig>> = {
  "fill-only": { tailSlots: 0, displaceAboveK: 0, seeds: 3, kinds: ALL_KINDS, minWeight: 0 },
  "tail-1 all-kinds": { tailSlots: 1, displaceAboveK: 0, seeds: 3, kinds: ALL_KINDS, minWeight: 0 },
  "tail-2 structural": { tailSlots: 2, displaceAboveK: 0, seeds: 3, kinds: STRUCTURAL_KINDS, minWeight: 0 },
  "tail-2 strong": { tailSlots: 2, displaceAboveK: 0, seeds: 3, kinds: STRUCTURAL_KINDS, minWeight: 2 },
  "k-aware tail-2": { tailSlots: 2, displaceAboveK: 5, seeds: 3, kinds: STRUCTURAL_KINDS, minWeight: 0 },
  "tail-2 coaccess": { tailSlots: 2, displaceAboveK: 0, seeds: 3, kinds: ["coaccess"], minWeight: 0 },
};

/**
 * The one config a caller should reach for when asking for graph-assisted candidates by hand:
 * the only shape that never measured WORSE than the incumbent at any budget, because it never
 * displaces — hops enter only when BM25 itself ran out of positive-score candidates. NOT wired
 * as the ask default — the gate said no (see header) — but a query surface with six anonymous
 * configs is a menu, and this is the measured recommendation. A caller that wants aggressive
 * neighbourhood expansion can pick a tail shape by name, knowing the table says what it costs.
 */
export const BEST_MEASURED = "fill-only";

/**
 * Flat edge rows -> each note's neighbour list. Undirected on purpose: retrieval asks "what
 * travels with this note", and a correction that points A -> B makes B relevant to A exactly as
 * much as A to B. Direction matters to the console (who said it); it does not change aboutness.
 * Neighbour lists are sorted (weight desc, path asc, kind asc) so the same rows always produce
 * the same adjacency — determinism is what makes the eval numbers mean anything.
 */
export function buildAdjacency(rows: readonly EdgeRow[]): Map<string, HopNeighbour[]> {
  const adj = new Map<string, HopNeighbour[]>();
  const add = (note: string, n: HopNeighbour) => {
    if (!adj.has(note)) adj.set(note, []);
    adj.get(note)!.push(n);
  };
  for (const r of rows) {
    add(r.src, { other: r.dst, kind: r.kind, weight: r.weight });
    add(r.dst, { other: r.src, kind: r.kind, weight: r.weight });
  }
  for (const list of adj.values()) {
    list.sort((a, b) => b.weight - a.weight || byName(a.other, b.other) || a.kind.localeCompare(b.kind));
  }
  return adj;
}

/**
 * Candidate paths for a question: BM25's ranking, widened by one graph hop under `config`.
 *
 * The composition rule, in order:
 *   1. BM25's protected prefix — top (k - tailSlots) ranks, or all of top-k when k is at or
 *      below displaceAboveK. Never reordered, never displaced.
 *   2. Hop candidates — 1-hop neighbours of the top `seeds` BM25 hits, filtered to the config's
 *      kinds and minWeight, ordered by (best seed rank, edge weight desc, path asc).
 *   3. BM25's own tail, filling whatever hops did not take.
 * Nothing repeats; a hop that lands on a note BM25 already placed is a no-op, not a duplicate.
 *
 * When BM25 finds nothing at all there are no seeds to hop from, so the whole call degrades to
 * narrow()'s fallback — the two paths must agree about what an unanswerable question returns.
 */
export function hopNarrow(
  files: Map<string, string>,
  question: string,
  k: number,
  adjacency: Map<string, HopNeighbour[]>,
  config: HopConfig
): string[] {
  const ranked = rank(files, question).map((s) => s.path);
  if (ranked.length === 0) return narrow(files, question, k);

  const tail = k > config.displaceAboveK ? Math.min(config.tailSlots, k) : 0;
  const out = ranked.slice(0, k - tail);
  const seen = new Set(out);

  // Hop candidates carry their best (lowest) seed rank; a note reachable from seeds 1 and 3
  // ranks as seed-1's neighbour. Weight breaks ties, path settles them — same inputs, same list.
  const hops = new Map<string, { seedRank: number; weight: number }>();
  const seeds = ranked.slice(0, Math.min(config.seeds, ranked.length));
  for (let i = 0; i < seeds.length; i++) {
    for (const n of adjacency.get(seeds[i]) ?? []) {
      if (!config.kinds.includes(n.kind) || n.weight < config.minWeight) continue;
      // A neighbour the corpus (or the caller's scope) does not hold cannot be packed — live
      // coaccess rows can name notes a scoped or older snapshot lacks.
      if (!files.has(n.other)) continue;
      const cur = hops.get(n.other);
      if (!cur || i < cur.seedRank || (i === cur.seedRank && n.weight > cur.weight)) {
        hops.set(n.other, { seedRank: i, weight: n.weight });
      }
    }
  }
  const hopOrder = [...hops.entries()].sort(
    (a, b) => a[1].seedRank - b[1].seedRank || b[1].weight - a[1].weight || byName(a[0], b[0])
  );

  for (const [path] of hopOrder) {
    if (out.length >= k) break;
    if (seen.has(path)) continue;
    seen.add(path);
    out.push(path);
  }
  // BM25's tail fills what hops left open — including the whole tail, when there were no hops.
  // Walking from rank 0 is correct, not wasteful: the protected prefix is already in `seen`, so
  // the walk resumes exactly where BM25's ranking left off.
  for (const path of ranked) {
    if (out.length >= k) break;
    if (seen.has(path)) continue;
    seen.add(path);
    out.push(path);
  }
  return out;
}
