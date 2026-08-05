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
 * THE BUDGET IS ENFORCED, NOT REQUESTED. The bare call used to pack the ENTIRE corpus into one
 * reply, and the tool description spent sixty words asking the model not to do that. A
 * limit that lives in prose is a limit the interface does not have. This one is applied after
 * selection, to every path equally, so even an explicit `paths` request is bounded.
 *
 * WHAT IS DROPPED IS COUNTED AND RESUMABLE. Silent truncation would be the same silent-loss failure
 * this system exists to prevent, one layer up: a caller that received a third of the corpus and was told
 * nothing would reason as though it had read the brain.
 */
import { narrow } from "./narrow";

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
  const all = [...files.keys()].sort();

  let chosen: string[];
  let missing: string[] = [];

  if (opts.paths?.length) {
    chosen = opts.paths.filter((p) => files.has(p));
    missing = opts.paths.filter((p) => !files.has(p));
  } else if (opts.question) {
    chosen = narrow(files, opts.question, opts.k ?? opts.defaultK);
  } else {
    // Sorted order, so a cursor is a stable position rather than a bet on map insertion order.
    const start = opts.after ? all.findIndex((p) => p > opts.after!) : 0;
    chosen = start === -1 ? [] : all.slice(start);
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
    cursor: dropped > 0 ? paths[paths.length - 1] : null,
  };
}
