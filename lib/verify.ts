/**
 * verify — deterministic proof that a cited quote actually exists in the file it claims.
 *
 * A reader answering from the corpus can still misquote it, and a fabricated quote looks
 * exactly like a real one. This makes that a string comparison instead of a matter of trust.
 * No model, no network.
 *
 * WHAT IT PROVES, AND WHAT IT DOES NOT. It proves this text is present, inside one block, at
 * this commit. It does not prove the answer follows from the quote, and it does not prove the
 * file still believes the quote. The verdict carries `superseded` for the second, and the
 * stamp wording in ask.ts carries the first. A checker that overclaims launders confidence.
 *
 * THREE THINGS AN EARLIER VERSION GOT WRONG, all of which said VERIFIED to text the file does
 * not assert:
 *
 *   1. Whitespace was collapsed across the WHOLE file, so the corpus normalised to one line
 *      per file and a "quote" could be spliced from the end of one paragraph and the start of
 *      the next. Measured on the live brain: ~80,000 verifying spans existed on no single
 *      line of any file, 192 of them across a heading. Matching is now scoped to one BLOCK, so
 *      soft-wrapped lines still join inside a paragraph and nothing joins across a boundary.
 *   2. `[*_\`>#]` was stripped everywhere, not where those characters mean markdown. That made
 *      `brain_ask` == `brainask`, `#7` == `7`, `notes/*.md` == `notes/.md`, and — worst —
 *      `top-1 > 58.4%` == `top-1 58.4%`, turning a measurement into an inequality. Stripping
 *      is now positional: line-leading markers, and balanced emphasis pairs only.
 *   3. JS `\s` and Python `\s` are different sets, so the eval scored a function the server
 *      does not run. U+FEFF is `\s` in JS but not Python — production was the more permissive
 *      of the two. Both sides now pin an explicit space class and delete zero-width characters
 *      outright.
 *
 * Port of brain/tools/eval/verify_citation.py; the two must agree exactly or the eval's
 * numbers do not describe the serving path. Every failure path fails CLOSED.
 */

/** Explicit, because JS \s and Python \s disagree — and disagreed in the unsafe direction. */
const SPACE = /[ \t\n\r\f\v\u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+/g;
/** Deleted rather than treated as space: invisible, and a match-widener if folded to " ". */
const ZERO_WIDTH = /[\u200b\u200c\u200d\u2060\u00ad\ufeff]/g;

/** Markers that only mean markdown at the start of a line. */
const LINE_LEAD = /^[ \t]*(?:(?:>[ \t]?)+|#{1,6}[ \t]+|(?:[-*+]|\d+[.)])[ \t]+)/gm;

/** Measured on the NORMALISED quote — see verifyQuote(). */
export const MIN_QUOTE = 12;

// Emphasis markers are recognised POSITIONALLY, by the characters either side, never by
// pairing. Pair-matching looked more principled and is wrong here: a quote is a FRAGMENT of a
// document, so a quote that starts or ends mid-span pairs differently from the file it came
// from and stops matching it. Measured on the eval, pair-matching broke 10 of 71 evidence
// labels — every one a quote that cut through an inline code span.
//
// A local rule cannot have that problem: both sides see the same neighbours.
//
// Backticks are handled separately from `*` and `_`, because they are not the same kind of
// character. A backtick is only ever a code-span delimiter; `*` is also a glob and `_` is also
// an identifier separator, which is why those two need the positional test and a backtick does
// not. Treating all three alike is what made `brain_ask` == `brainask`.
const CODE = /`+/g;
// The predecessor class is "anything except space, a marker, or `/`". Naming the allowed
// characters instead was too narrow and cost real recall: `%`, `.`, `:` and accented letters
// were all excluded, so `**58.4%**,` normalised to `58.4%**,` and the flagship metric line in
// projects/cortex.md stopped verifying when a reader dropped the bold. Measured before the
// widening: 267 of 1162 blocks kept a stray marker and 259 of 727 markdown-bearing blocks
// failed the exact fold normalise() exists to permit. `/` stays excluded on both sides so
// `notes/*.md` keeps its glob.
const OPEN = /(^|[\s([{"'])([*_]{1,3})(?=\S)/g;
const CLOSE = /([^\s*_/])([*_]{1,3})(?=[\s)\]}"'.,;:!?/]|$)/g;

function stripEmphasis(s: string): string {
  return (
    s
      .replace(CODE, "")
      .replace(OPEN, "$1")
      .replace(CLOSE, "$1")
      // A fragment can begin or end on the far half of a span it cut through; the file's copy
      // has a word character on the other side and loses it, so the fragment must too.
      .replace(/^[*_]+/, "")
      .replace(/[*_]+$/, "")
  );
}

/**
 * Meaning-preserving comparison form: unify unicode, drop markdown that is acting as markup,
 * collapse space.
 *
 * Deliberately NOT lowercasing. Case is part of an identifier — `By Rig` vs `By rig` is the
 * exact bug that has had the OTS pipeline dead for a month — so a quote that changes case has
 * changed the fact.
 */
export function normalise(s: string): string {
  return stripEmphasis(
    s
      .normalize("NFKC")
      .replace(ZERO_WIDTH, "")
      .replace(/[\u2018\u2019]/g, "'")
      .replace(/[\u201c\u201d]/g, '"')
      .replace(/\u2014/g, "--")
      .replace(/\u2013/g, "-")
      .replace(LINE_LEAD, "")
  )
    .replace(SPACE, " ")
    .trim();
}

export interface Block {
  text: string;
  /** 1-indexed line in the original file. */
  line: number;
  /** Nearest heading at or above this block, for provenance. */
  heading: string;
}

/**
 * Split a note into the units a quote may live inside: paragraphs, list items, table rows,
 * headings, fenced code. Soft-wrapped lines inside a paragraph stay together — brain notes are
 * hard-wrapped, so joining them is load-bearing for honest quotes — but nothing merges across
 * a blank line, a bullet, a table row or a heading.
 */
export function splitBlocks(text: string): Block[] {
  const lines = text.split("\n");
  const blocks: Block[] = [];
  let buf: string[] = [];
  let start = 1;
  let heading = "";
  let fence = false;

  const flush = () => {
    if (buf.length && buf.join("").trim()) blocks.push({ text: buf.join("\n"), line: start, heading });
    buf = [];
  };

  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (/^[ \t]*(```|~~~)/.test(l)) {
      if (!fence) flush();
      buf.push(l);
      if (fence) flush();
      fence = !fence;
      if (!fence) start = i + 2;
      else start = i + 1;
      continue;
    }
    if (fence) {
      buf.push(l);
      continue;
    }
    const isHeading = /^[ \t]*#{1,6}[ \t]+/.test(l);
    // A new list item, table row or heading starts its own block; a continuation line does not.
    // A blockquote starts its own block too. Without that, `> **SUPERSEDED ...**` merged into
    // the bullet above it and the retraction check could not see it as a neighbour — which is
    // exactly how notes/grain-grain.md's dead SHIPPED line kept passing as current.
    const startsBlock =
      isHeading || /^[ \t]*([-*+]|\d+[.)])[ \t]+/.test(l) || /^[ \t]*\|/.test(l) || /^[ \t]*>/.test(l);
    if (!l.trim()) {
      flush();
      start = i + 2;
      continue;
    }
    if (startsBlock) {
      flush();
      start = i + 1;
    }
    if (!buf.length) start = i + 1;
    buf.push(l);
    if (isHeading) {
      heading = l.replace(/^[ \t]*#{1,6}[ \t]+/, "").trim();
      flush();
      start = i + 2;
    }
  }
  flush();
  return blocks;
}

/**
 * Text the brain uses to retract a claim while keeping it on the page. All three conventions
 * are live in the corpus, and a quote pulled from inside one is the single most dangerous
 * false VERIFIED: `SHIPPED 2026-07-14 ... live in production` is verbatim in a note whose next
 * line says not to answer from it.
 */
const SUPERSEDED_RE = /\bSUPERSEDED\b|\bCORRECTION\b|\bDEPRECATED\b|was:\s*["\u201c]|\bDo not answer\b/i;

/**
 * The two markers say different things, and conflating them cost the stamp its credibility.
 *
 * A BANNER retires a passage: `> **SUPERSEDED 2026-07-25 \u2026**`, `DEPRECATED`, `Do not answer`.
 * Everything near it is history.
 *
 * An IN-PLACE CORRECTION does the opposite. House style is `<current claim> (was: "<old
 * claim>")`, so the block carrying `was:` is the block carrying the TRUTH \u2014 the marker is
 * evidence of currency, not of death. Reading it as a retraction meant the freshest, most
 * asked-about content in the brain got stamped "It is history. Do not answer from it." while
 * being exactly right. That is the wolf-crying this file's own comments warn about: a warning
 * that fires on healthy text stops being read.
 *
 * Detection stays as broad as it was \u2014 nothing that used to be flagged is now silent. Only the
 * sentence changes, and the absolute one is reserved for the case where it is true.
 */
const BANNER_RE = /\bSUPERSEDED\b|\bCORRECTION\b|\bDEPRECATED\b|\bDo not answer\b/i;
const WAS_RE = /was:\s*["\u201c]/i;
/** The retired wording itself, captured out of `(was: "\u2026")`. */
const WAS_QUOTED_RE = /was:\s*["\u201c]([^"\u201d]{1,400})["\u201d]/gi;

export type Retraction = "none" | "banner" | "correction";

/**
 * The banner usually sits in its own block immediately above or below the text it retracts —
 * `> **SUPERSEDED 2026-07-25 ...**` on one line, the dead claim on the next. Checking only the
 * matched block misses every one of them.
 *
 * Neighbours only, deliberately. Flagging everything below a banner until the next heading
 * would mark most of grain-grain.md, and a warning that fires on healthy text stops being
 * read. Erring toward over-flagging is still the right direction — a spurious "check this"
 * costs a glance, a missed retraction costs a wrong answer with a green stamp — so the radius
 * is one block, not zero.
 */
export function retracted(blocks: Block[], i: number): boolean {
  for (const b of [blocks[i], blocks[i - 1], blocks[i + 1]]) {
    if (b && SUPERSEDED_RE.test(b.text)) return true;
  }
  return SUPERSEDED_RE.test(blocks[i].heading);
}

/**
 * Which kind of marker fired, so render() can say the true thing rather than the strong thing.
 *
 * `matched` is the file's own text for the citation. It decides the one case a `was:` marker
 * alone cannot: whether the quote is the CURRENT claim standing beside the retired wording, or
 * the retired wording itself. Quoting the inside of `(was: "…")` is a genuinely dead citation
 * and keeps the absolute stamp — that is exactly what the landmine test hunts for.
 */
export function retraction(blocks: Block[], i: number, matched?: string): Retraction {
  const near = [blocks[i], blocks[i - 1], blocks[i + 1]].filter(Boolean) as Block[];
  const heading = blocks[i].heading;
  if (near.some((b) => BANNER_RE.test(b.text)) || BANNER_RE.test(heading)) return "banner";
  if (!near.some((b) => WAS_RE.test(b.text)) && !WAS_RE.test(heading)) return "none";

  // A `was:` marker is present. If the citation is the retired wording, this is a retraction
  // after all — compared on normalised text, the same footing every other check here uses.
  const needle = normalise(matched ?? "");
  if (needle) {
    for (const b of [...near.map((b) => b.text), heading]) {
      for (const m of b.matchAll(WAS_QUOTED_RE)) {
        const old = normalise(m[1]);
        if (old && (old.includes(needle) || needle.includes(old))) return "banner";
      }
    }
  }
  return "correction";
}

export interface Verdict {
  verified: boolean;
  reason: string;
  /** The file's OWN text for the match, so displayed and verified cannot diverge. Truncated
   *  for display — use `block` for anything that has to be complete. */
  matched?: string;
  /**
   * The same block, UNTRUNCATED.
   *
   * `matched` is capped at 400 characters because it is printed. That cap is a display
   * decision, and it leaked: the eval harness scored "did the reader quote the labelled
   * passage" against `matched`, so any labelled span sitting past character 400 of its own
   * block was unreachable — a perfect reader capped at 83.5% because of a formatting constant.
   * Anything measuring rather than showing reads this field.
   */
  block?: string;
  line?: number;
  heading?: string;
  /** The block, or the heading above it, is marked as retracted or corrected. */
  superseded?: boolean;
  /**
   * WHICH marker fired. `superseded` stays the broad boolean every caller already relies on;
   * this says whether the passage is retired ("banner") or is an in-place correction whose
   * quoted claim is the current one ("correction"). Only the stamp's wording depends on it.
   */
  retraction?: Retraction;
}

/** True iff `quote` appears verbatim inside a single block of `text`. */
export function verifyQuote(text: string | undefined, quote: string): Verdict {
  // Length is checked AFTER normalising. Checking the raw string let a citation made of pure
  // markdown wrappers clear the guard, normalise to "", and then match every file — proof of
  // nothing, reported as proof.
  const nq = normalise(quote ?? "");
  if (nq.length < MIN_QUOTE) {
    return { verified: false, reason: `quote too short to prove (<${MIN_QUOTE} chars of actual text)` };
  }
  if (text === undefined) return { verified: false, reason: "cited file is not in the corpus" };

  const blocks = splitBlocks(text);
  for (let i = 0; i < blocks.length; i++) {
    const b = blocks[i];
    if (!normalise(b.text).includes(nq)) continue;
    return {
      verified: true,
      reason: b.text.includes(quote) ? "exact" : "normalised (markdown/whitespace differs)",
      matched: b.text.trim().slice(0, 400),
      block: b.text.trim(),
      line: b.line,
      heading: b.heading,
      superseded: retracted(blocks, i),
      // Classified on the QUOTE, not the block: inside `(was: "…")` is a dead citation, beside
      // it is the live one, and the same block can hold both.
      retraction: retraction(blocks, i, quote),
    };
  }
  // Present in the file, but only by joining text across a block boundary. That is not a quote.
  if (normalise(text).includes(nq)) {
    return {
      verified: false,
      reason: "spans a paragraph, list or section boundary — not a contiguous quote",
    };
  }
  return { verified: false, reason: "NOT FOUND in the cited file" };
}

export interface Citation {
  path: string;
  /** What the reader claimed to be quoting. */
  quote: string;
  /** The FILE's own text for the block the quote was found in. Displayed instead of `quote`,
   *  so what the operator reads is what was actually proven rather than what the model typed. */
  evidence?: string;
  verified: boolean;
  reason: string;
  commit: string;
  line?: number;
  heading?: string;
  superseded?: boolean;
  retraction?: Retraction;
  /** The cited block, untruncated. For measurement, never for display. */
  block?: string;
}

/** What every answer carries. `commit` pins the proof to an exact revision. */
export function checkCitation(
  files: Map<string, string>,
  sha: string,
  path: string,
  quote: string
): Citation {
  const v = verifyQuote(files.get(path), quote);
  return {
    path,
    quote,
    // The FILE's text, not the model's — displayed and verified are then the same string by
    // construction, which closes the remaining unicode games regardless of normalisation.
    evidence: v.matched,
    verified: v.verified,
    reason: v.reason,
    commit: sha.slice(0, 12),
    line: v.line,
    heading: v.heading,
    superseded: v.superseded,
    retraction: v.retraction,
    block: v.block,
  };
}
