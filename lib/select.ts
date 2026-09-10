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
import { utf8Bytes } from "./utf8";

export interface Selection {
  /** Notes to return, in order. */
  paths: string[];
  /** Selected but over budget. Reachable by calling again with `cursor`. */
  dropped: number;
  /** Explicitly requested and not in the corpus. Reported, never silently skipped. */
  missing: string[];
  /** Selected notes that can never fit this per-call budget. Open them with brain_read. */
  oversized: string[];
  /** Notes skipped to keep an exact, progressing page bounded. Open them with brain_read. */
  recoverable: string[];
  bytes: number;
  /** Pass as `after` to continue. Null when nothing remains — and never null while `dropped` is
   *  positive: a page that withholds notes always names the coordinate to resume from. */
  cursor: string | null;
}

export type SelectionDraft = Selection;

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
  /** Fixed bytes reserved for the response header, coverage and omission notices. */
  envelopeBytes?: number;
  /** Cost of rendering one admitted note, including its boundary. */
  measureBytes?: (path: string, text: string, index: number) => number;
  /** Maximum candidates classified on one page, including permanent oversize omissions. */
  maxExamined?: number;
  /** Exact final-envelope admission check. When present it is authoritative over arithmetic. */
  fits?: (draft: SelectionDraft) => boolean;
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
    const unique = [...new Set(opts.paths)];
    chosen = unique.filter((p) => files.has(p));
    missing = unique.filter((p) => !files.has(p));
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
  const oversized: string[] = [];
  const recoverable: string[] = [];
  let bytes = 0;
  let renderedBytes = opts.envelopeBytes ?? 0;
  let examined = 0;
  const examinationLimit = Math.min(chosen.length, opts.maxExamined ?? chosen.length);
  const draft = (
    nextPaths: string[],
    nextOversized: string[],
    nextRecoverable: string[],
    nextBytes: number,
    nextExamined: number
  ): SelectionDraft => {
    const dropped = chosen.length - nextExamined;
    return {
      paths: nextPaths,
      oversized: nextOversized,
      recoverable: nextRecoverable,
      missing,
      bytes: nextBytes,
      dropped,
      cursor: dropped > 0 ? chosen[nextExamined - 1] ?? null : null,
    };
  };
  for (let i = 0; i < examinationLimit; i++) {
    const p = chosen[i];
    const text = files.get(p) ?? "";
    const len = utf8Bytes(text);
    const cost = opts.measureBytes?.(p, text, i) ?? len;
    if (opts.fits) {
      // Permanent means it cannot fit even on an otherwise empty response. If it can fit alone
      // but not after earlier omission metadata, leave it for the next precise continuation.
      const fitsAlone = opts.fits(draft([p], [], [], len, chosen.length));
      if (!fitsAlone) {
        const next = draft(paths, [...oversized, p], recoverable, bytes, i + 1);
        if (!opts.fits(next)) {
          if (examined > 0) break;
          // Nothing examined yet, so there is no coordinate to hand back. Breaking here would
          // report every note as dropped with a null cursor, and the reply prints its
          // continuation only when there is a cursor — silent loss, the failure this module
          // exists to prevent. A budget that cannot hold one omission receipt is a caller error.
          throw new RangeError(
            `selection cannot fit the omission receipt for ${p}` +
              (missing.length ? ` alongside ${missing.length} missing path${missing.length === 1 ? "" : "s"} already named in the envelope` : "")
          );
        }
        oversized.push(p);
        examined = i + 1;
        continue;
      }
      const next = draft([...paths, p], oversized, recoverable, bytes + len, i + 1);
      if (!opts.fits(next)) {
        if (examined > 0) break;
        // At the first candidate there is no prior coordinate to return. A near-ceiling body can
        // fit by itself yet fail only when the exact cursor needed to reach later notes is added.
        // Replace that body with a direct-read receipt: this advances the coordinate, preserves a
        // bounded continuation if a later candidate also fails, and lets later small notes compete.
        const recovery = draft(paths, oversized, [...recoverable, p], bytes, i + 1);
        if (!opts.fits(recovery)) {
          throw new RangeError(`selection cannot fit exact recovery metadata for ${p}`);
        }
        recoverable.push(p);
        examined = i + 1;
        continue;
      }
      paths.push(p);
      bytes += len;
      examined = i + 1;
      continue;
    }
    // A permanently oversized note is not a continuation: no later call with this same budget
    // can admit it. Name it, keep walking, and leave the cursor for genuinely resumable rows.
    if ((opts.envelopeBytes ?? 0) + cost > opts.budgetBytes) {
      oversized.push(p);
      examined = i + 1;
      continue;
    }
    if (renderedBytes + cost > opts.budgetBytes) {
      break;
    }
    paths.push(p);
    bytes += len;
    renderedBytes += cost;
    examined = i + 1;
  }

  return draft(paths, oversized, recoverable, bytes, examined);
}
