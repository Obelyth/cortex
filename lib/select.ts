/**
 * select — which notes a `brain_corpus` reply carries, and where it stops.
 *
 * Pulled out of the tool handler so the interesting part is testable without an MCP server. The
 * handler is then only assembly: choose, pack, report.
 *
 * THREE WAYS TO CHOOSE, most precise first, because precision is now available. Before the router
 * existed a caller had no way to know what any note held, so the only honest options were "rank it
 * for me" or "give me everything". With every note carrying a description in the boot call, the
 * common case is that the caller already knows exactly which notes it wants — so asking for them
 * by name is the primary path, and ranking is the fallback for when it does not.
 *
 * THE BUDGET IS ENFORCED, NOT REQUESTED. The bare call used to pack all 83 notes — ~113k tokens —
 * into one reply, and the tool description spent sixty words asking the model not to do that. A
 * limit that lives in prose is a limit the interface does not have. This one is applied after
 * selection, to every path equally, so even an explicit `paths` request is bounded.
 *
 * WHAT IS DROPPED IS COUNTED AND RESUMABLE. Silent truncation would be the same silent-loss failure
 * this system exists to prevent, one layer up: a caller that received 30 of 83 notes and was told
 * nothing would reason as though it had read the brain.
 */
import { narrow } from "./narrow";
import { byName } from "./frontmatter";

export interface Selection {
  /** Notes to return, in order. */
  paths: string[];
  /** Selected but over budget. Reachable by calling again with `cursor`. */
  dropped: number;
  /** Explicitly requested and not in the corpus. Reported, never silently skipped. */
  missing: string[];
  bytes: number;
  /** Pass as `after` to continue. Null when nothing remains. */
  cursor: string | null;
}

export interface SelectOptions {
  /** Exact notes, by path. Most precise, and the one the router makes possible. */
  paths?: string[];
  /** Rank by relevance instead. */
  question?: string;
  k?: number;
  /** Resume a listing after this path. */
  after?: string;
  budgetBytes: number;
  defaultK: number;
}

export function selectNotes(files: Map<string, string>, opts: SelectOptions): Selection {
  const all = [...files.keys()].sort(byName);

  let chosen: string[];
  let missing: string[] = [];

  // PRESENCE, not length. `paths: []` is a caller saying "none of them" — a model that filtered
  // the router down to zero matches and asked for exactly that. The old truthiness test made an
  // empty array fall through to the listing branch and return the ENTIRE corpus up to the
  // budget: the largest, most expensive, highest-exposure reply this tool can produce, in
  // answer to a request for nothing.
  if (opts.paths !== undefined) {
    chosen = opts.paths.filter((p) => files.has(p));
    missing = opts.paths.filter((p) => !files.has(p));
  } else if (opts.question) {
    chosen = narrow(files, opts.question, opts.k ?? opts.defaultK);
  } else {
    // Sorted, so a cursor is a stable position rather than a bet on map insertion order.
    chosen = all;
  }

  /**
   * THE CURSOR APPLIES IN EVERY MODE, because the reply advertises it in every mode.
   *
   * It used to be read only in the listing branch, while lib/tools.ts printed
   * `call again with after="…"` whenever anything was dropped. A caller in `paths` or `question`
   * mode did exactly what it was told, hit a branch that never looked at `after`, and got a
   * byte-identical page back — forever, with the dropped notes unreachable through any argument the
   * schema allows. An interface that instructs a caller into an infinite loop is worse than one
   * that never offered a cursor.
   *
   * The position is resolved INSIDE `chosen` rather than in the sorted corpus, because `paths` and
   * `question` order their results differently — the caller's own argument order, and relevance
   * rank — and a position taken from a different ordering is a different coordinate system.
   *
   * THE COMPARATOR IN THE FALLBACK MUST MATCH THE SORT. `>` is codepoint order; the listing is
   * collated. Those disagree on real note names — collation puts readme-draft.md before README.md,
   * codepoint puts it after — so a cursor compared the wrong way points backwards into the page it
   * just returned, and paging repeats two notes forever while the rest stay unreachable.
   */
  if (opts.after) {
    const at = chosen.indexOf(opts.after);
    chosen =
      at >= 0
        ? chosen.slice(at + 1)
        : // Not in this result set: the corpus moved under a paging caller, or the caller changed
          // its own request mid-walk. Fall back to the sorted position so a listing still makes
          // progress instead of restarting at the top and looping.
          chosen.filter((p) => byName(p, opts.after!) > 0);
  }

  const paths: string[] = [];
  let bytes = 0;
  for (const p of chosen) {
    const len = files.get(p)?.length ?? 0;
    // Always yield at least one note. Otherwise a single note larger than the budget returns
    // nothing, the cursor never advances past it, and paging is stuck forever on one file.
    if (paths.length > 0 && bytes + len > opts.budgetBytes) break;
    paths.push(p);
    bytes += len;
  }

  const dropped = chosen.length - paths.length;
  return {
    paths,
    dropped,
    missing,
    bytes,
    cursor: dropped > 0 ? paths.at(-1)! : null,
  };
}
