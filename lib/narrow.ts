/**
 * narrow — BM25 over full file text, used ONLY to pick candidates for the metered surface.
 *
 * This is deliberately not the old scorer. Two differences that matter:
 *
 *   1. It ranks the ACTUAL TEXT, not a generated summary line. A summary can omit the terms
 *      needed to retrieve the note, so ranking summaries was the bug.
 *   2. It never decides the answer. It hands the reader a shortlist and the reader reads.
 *      The shortlist is a cost optimisation, not a gatekeeper.
 *
 * Why it exists at all: the free surfaces (shells, Claude Code) can afford the whole corpus.
 * The phone goes through a metered model, so a bounded pack controls cost.
 */

import { isLogPath, historyPageName } from "./digest";
import { utf8Bytes } from "./utf8";
import { prepareLexical, tokenize } from "./lexical";
export { tokenize, K1, B } from "./lexical";

// Split pages do not require a different BM25 fit. They require opts.maxPartsPerPage (see
// NARROW_BUDGET_BYTES's neighbour in lib/ask.ts): a split page's
// history parts rank as near-duplicate siblings that crowd each other out of a pack, and B
// cannot fix that on its own.

export interface Scored {
  path: string;
  score: number;
}

/** A scored file with the question terms it actually matched, in question order. */
export interface ScoredTerms extends Scored {
  terms: string[];
}

/**
 * Rank files by BM25 against the question. Only files with a positive score are returned —
 * a zero score means no lexical signal at all, and padding a shortlist with them would make
 * "recall@k" measure nothing but "the file exists". (The Python eval had exactly that bug.)
 */
export function rank(files: Map<string, string>, question: string): Scored[] {
  return rankTerms(files, question).map(({ path, score }) => ({ path, score }));
}

/**
 * rank(), keeping the matched terms. One scorer: rank() is this with the terms dropped, so the
 * console's "why it ranked" and the pack the reader was handed cannot be two opinions of the
 * same question. The terms are the question's own tokens the file contains, in question order —
 * the words the score was made of, not a summary of the file.
 */
export function rankTerms(files: Map<string, string>, question: string): ScoredTerms[] {
  return prepareLexical(files).score(question);
}

/** Day-logs a pack may carry. One: a diary entry is context, not a fact page (see capLogs). */
export const DEFAULT_MAX_LOGS = 1;

/** Why a scored candidate did not make the pack. */
export type CutBy = "log-cap" | "parts-cap" | "budget" | "k";

export interface Shortlisted extends ScoredTerms {
  rank: number;
  /** Real UTF-8 bytes of the note body — what the budget counted. */
  bytes: number;
}

export interface Cut extends Scored {
  by: CutBy;
}

/**
 * The narrowing's working — what narrow() decided and why. `paths` is byte-for-byte what
 * narrow() returns for the same arguments (narrow() IS this with the working dropped), so the
 * console's "what it read" can never describe a pack the reader was not handed.
 */
export interface NarrowDetail {
  paths: string[];
  shortlist: Shortlisted[];
  /** Every scored candidate that is not in the pack, with the cap that refused it. */
  cut: Cut[];
  /** Files with no lexical signal for the question at all — never shown to the reader. */
  zeroCount: number;
  /**
   * Cut rows that carried lexical signal — the omitted notes that could still hold the answer.
   * Zero means every note the reader was not shown scored nothing for this question, which is
   * what lets ask() call a narrowed search complete FOR THIS QUESTION. Null when the question
   * tokenized to nothing ("???", a bare emoji): then no note was ever ranked against it and the
   * omissions say nothing either way.
   */
  matchedCut: number | null;
  /** "scored" — a ranked pack; "fallback" — nothing scored, the largest notes went to the caps. */
  mode: "scored" | "fallback";
}

/**
 * The candidate pack handed to a metered reader.
 *
 * When nothing scores, fall back to the LARGEST notes rather than the whole corpus. The old
 * fallback shipped everything, silently multiplying the bill, and it fired on inputs as
 * ordinary as `"???"` or an emoji because those tokenize to nothing. A caller who typos should not be
 * charged for a full read they did not ask for; `full: true` is how you ask for that.
 *
 * The fallback is offered to the SAME caps as a scored pack, so it is "the largest notes that
 * fit", not k of them. Under the production byte budget that is the one place the shortfall is
 * dramatic: the largest notes can consume the remaining budget quickly. That is the intended
 * cost behaviour and the same rule the budget states for
 * a scored pack — it only ever stops ADDING, and always lets at least one through — not a
 * separate promise of k. Nothing here pads to k; a padded pack would be zero-score filler, which
 * is exactly what rank() and the caps refuse to do.
 */
export function narrow(
  files: Map<string, string>,
  question: string,
  k = 10,
  opts: { maxLogs?: number; budgetBytes?: number; maxPartsPerPage?: number } = {}
): string[] {
  return narrowDetail(files, question, k, opts).paths;
}

/** narrow(), with its decisions kept. See NarrowDetail. */
export function narrowDetail(
  files: Map<string, string>,
  question: string,
  k = 10,
  opts: { maxLogs?: number; budgetBytes?: number; maxPartsPerPage?: number } = {}
): NarrowDetail {
  const maxLogs = opts.maxLogs ?? DEFAULT_MAX_LOGS;
  const scored = rankTerms(files, question);
  const ranked: ScoredTerms[] = scored.length
    ? scored
    : [...files.entries()]
        .sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]))
        .map(([path]) => ({ path, score: 0, terms: [] }));
  const { kept, cut } = capLogs(files, ranked, k, maxLogs, opts.budgetBytes, opts.maxPartsPerPage);
  const byPath = new Map(ranked.map((r) => [r.path, r]));
  return {
    paths: kept,
    shortlist: kept.map((path, i) => ({
      ...byPath.get(path)!,
      rank: i + 1,
      bytes: utf8Bytes(files.get(path) ?? ""),
    })),
    cut,
    zeroCount: files.size - scored.length,
    // A fallback pack's cut rows all score zero, so the count is honest there too: a question
    // whose words occur in no note at all has no omitted note that matched it.
    matchedCut: tokenize(question).length ? cut.filter((c) => c.score > 0).length : null,
    mode: scored.length ? "scored" : "fallback",
  };
}

/**
 * Post-rank filter: at most `maxLogs` day-logs make it into the top k, at most
 * `maxPartsPerPage` history parts of any one SOURCE PAGE make it in, and — when `budgetBytes`
 * is set — the pack stops growing once the running body-byte total would exceed it.
 *
 * A day log is a diary entry, not a fact page — one in the pack is useful context, a pack
 * that's half logs crowds out the notes that actually answer the question. A history part is
 * the same shape of problem one level up: splitting an oversized page turns it into several
 * near-identical siblings (same project, different months) that all score on the same terms
 * and can flood a pack together, pushing out the one part that actually answers the question.
 * Slots freed by either cap are filled only from the next-ranked SCORED candidates — never
 * from a zero-score file pulled in just to pad the count. rank()'s own rule is that a zero
 * score carries no lexical signal at all, and this cap must not quietly violate that by padding
 * the pack with query-irrelevant filler; a pack that loses slots to a cap and has no more
 * scored candidates to offer instead comes back shorter than k, on purpose.
 *
 * The budget never truncates a note. It refuses an over-budget candidate before that candidate
 * consumes a log/part slot, then continues so a later smaller note can still be admitted. There
 * is no first-note exception: a hard byte ceiling is more truthful than an oversized pack.
 */
function capLogs(
  files: Map<string, string>,
  ranked: Scored[],
  k: number,
  maxLogs: number,
  budgetBytes?: number,
  maxPartsPerPage?: number
): { kept: string[]; cut: Cut[] } {
  const out: string[] = [];
  // Every scored candidate that is not packed is recorded with the cap that refused it, so
  // "ranked, not packed" on the console is the loop's own record rather than a reconstruction.
  // Zero-score fallback rows are decisions too and are recorded the same way.
  const cut: Cut[] = [];
  let logs = 0;
  let total = 0;
  const partsSeen = new Map<string, number>();
  // Once the pack is full at k, every remaining candidate is refused by that closure. Budget
  // refusals do not close the pack because a later smaller candidate may still fit.
  let closed: CutBy | null = null;
  for (const { path: p, score } of ranked) {
    if (closed) {
      cut.push({ path: p, score, by: closed });
      continue;
    }
    const len = utf8Bytes(files.get(p) ?? "");
    // Admission precedes every cardinality counter. A candidate that cannot fit is absent, not
    // the one log/part the pack was allowed to carry.
    if (budgetBytes != null && total + len > budgetBytes) {
      cut.push({ path: p, score, by: "budget" });
      continue;
    }
    if (isLogPath(p)) {
      if (logs >= maxLogs) {
        cut.push({ path: p, score, by: "log-cap" });
        continue;
      }
      logs++;
    }
    if (maxPartsPerPage != null) {
      const page = historyPageName(p);
      if (page != null) {
        const seen = partsSeen.get(page) ?? 0;
        if (seen >= maxPartsPerPage) {
          cut.push({ path: p, score, by: "parts-cap" });
          continue;
        }
        partsSeen.set(page, seen + 1);
      }
    }
    total += len;
    out.push(p);
    if (out.length >= k) closed = "k";
  }
  return { kept: out, cut };
}
