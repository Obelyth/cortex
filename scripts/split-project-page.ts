/**
 * split-project-page — cut a project page that outgrew the boot call into a status page plus a
 * monthly history, without losing a byte.
 *
 * WHY. A project page is written by appending: every session adds a dated H2 and nothing is ever
 * removed, so the two oldest pages in the corpus are a quarter of a megabyte each. That is fatal
 * twice over. The router has to describe the page in one line, and one line cannot describe 71
 * unrelated sessions; and any retrieval that opens the page spends its whole budget on one file,
 * most of which is a year of superseded plans. The fix is not summarisation — a summary throws
 * away the record — it is filing: the top of the page (what is true now) stays where every
 * reader already looks, and the dated record moves to `history/<name>-YYYY-MM.md`, one note per
 * month, each with its own description and its own router row.
 *
 * WHY BYTE-FOR-BYTE, AND WHY A VERIFIER. This edits the operator's only copy of a record that is
 * quoted back with citations — the verifier proves a quote against note BYTES, so a split that
 * trimmed a trailing newline or re-joined sections with its own whitespace would break citations
 * on exactly the material it just moved. So no section is ever rebuilt: every piece of output is
 * a SLICE of the input, and `verifySplit` afterwards parses the outputs back into sections and
 * matches them to the original's by exact bytes — a partition, every section claimed by exactly
 * one file. `--write` refuses on any discrepancy before writing anything, refuses again unless
 * git says those paths are clean, writes the history files before touching the page, and checks
 * once more from disk after.
 *
 * WHAT IS "NOW" IS A PARAMETER, NOT A GUESS. Which sections stay is given on the command line
 * (`--keep`), because only the operator knows whether his page's opening block is called
 * "Status" or "What this is". Everything not named is dated and filed. A section with no date of
 * its own inherits the month of the section above it, which is the correct reading of an append
 * -only log: an undated block was written in the same sitting as the dated one it follows.
 *
 * Dry run by default. `--write` is a separate, deliberate act.
 *
 * Usage:
 *   npx tsx scripts/split-project-page.ts --brain <dir> --page projects/<name>.md \
 *     --keep "Status,Decisions,Next" --max-status-bytes 8192 [--max-history-bytes 64000] [--write]
 */
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { parseFrontmatter, safeText, MAX_DESCRIPTION } from "../lib/frontmatter";
import { HISTORY_PATH, MAX_PAGE_BYTES } from "../lib/digest";
import { resolveTrustedExecutable } from "./command-path.cjs";

/**
 * One H2 section, as bytes.
 *
 * `body` is a SLICE of the original: the heading line, everything under it, and the blank lines
 * that separated it from the next heading. Carrying the separator inside the section is what lets
 * the output be a concatenation rather than a re-join — there is no "" to choose, so there is no
 * way to choose it differently from the original.
 */
export interface Section {
  /** The heading text, without the leading `## `. */
  heading: string;
  /** Heading line through to the byte before the next heading, verbatim. */
  body: string;
  /** `YYYY-MM-DD` from the heading, else from the section's first provenance stamp, else null. */
  date: string | null;
}

export interface ParsedPage {
  /** The frontmatter fence, verbatim, including its closing line and newline. `""` if absent. */
  frontmatter: string;
  /** Everything between the fence and the first `## ` — the H1 and any intro. Verbatim. */
  preamble: string;
  sections: Section[];
}

export interface SplitOpts {
  /** The page's short name: `history/<name>-YYYY-MM.md`, so `[a-z0-9-]+` (lib/digest's rule). */
  name: string;
  /** Headings that stay on the status page, matched by leading words (see `headingKey`). */
  keepHeadings: string[];
  /** The status page must fit in this many UTF-8 bytes, or the split refuses. */
  maxStatusBytes: number;
  /**
   * A month carrying more section bytes than this is written as ordered parts. Defaults to
   * DEFAULT_MAX_HISTORY_BYTES.
   */
  maxHistoryBytes?: number;
}

export interface HistoryFileReport {
  path: string;
  /** `YYYY-MM`. */
  month: string;
  /** 1-based part number, and how many parts this month was written as. `1 of 1` when whole. */
  part: number;
  parts: number;
  sections: number;
  bytes: number;
  /**
   * The date of the FIRST and LAST dated section in the file, in document order — not the
   * earliest and latest.
   *
   * The distinction is load-bearing and the earlier version of this got it wrong. Sections keep
   * the order the page wrote them, and a page written by appending is not in date order: one
   * part here runs 2026-08-09 … 2026-08-31 while the part after it holds a single 2026-08-31
   * section. Reporting min and max would present that as a tidy range and quietly claim an
   * ordering the file does not have.
   */
  firstDate: string;
  lastDate: string;
  firstHeading: string;
}

export interface SplitReport {
  sections: number;
  kept: number;
  moved: number;
  /**
   * Moved sections with no date of their own that inherited the month of the section above them.
   *
   * A count of guesses, which is why it is reported: every one of these is a placement no date in
   * the file justifies, and the operator may want to look.
   */
  undated: number;
  /**
   * Undated sections that stand BEFORE any dated section, and so had nothing above them to
   * inherit from. They go to the earliest month in the page. Counted apart from `undated`
   * because it is a different rule with a different failure mode — an inherited month is
   * probably right, a fallback month is only "the oldest thing here".
   */
  undatedLeading: number;
  statusBytes: number;
  months: HistoryFileReport[];
}

/**
 * The one sentence this script writes into a page it does not own.
 *
 * It is generated output living inside the operator's own status page, which makes it a false
 * positive for the export gate — the gate reads the brain and fails on any real brain line found
 * in shipped source, and this line is in both by construction. The first fix was to build it out
 * of fragments so the matcher could not see it, which is worse than the problem: a gate people
 * learn to route around is a dead gate, and that left a worked example of how to route around it.
 *
 * `no-brain-leakage.test.ts` already had the right mechanism for cortex's own output —
 * GENERATED_MARKER, which exempts a whole file cortex emits. A status page cannot use that: most
 * of it is the operator's writing, and exempting the file would blind the gate to exactly what it
 * guards. So the exemption is this one exported line, and the gate imports it from here rather
 * than carrying its own copy, so the two cannot drift.
 */
export const HISTORY_INTRO = "Dated entries for this page are stored in the monthly history notes below:";

export interface SplitResult {
  status: string;
  /** `history/<name>-YYYY-MM.md` → file text, in ascending month order. */
  history: Map<string, string>;
  report: SplitReport;
}

const MONTH_NAMES = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

/**
 * The default ceiling on one history note's sections, in bytes.
 *
 * A month is a filing rule, not a size. A large history note can consume the retrieval budget on
 * one file and crowd everything else out, so the shared generic threshold bounds each part.
 */
// The bound now lives with the history filing rule in lib/digest.ts, so the check that raises
// an oversized page and the tool that cuts one cannot disagree. Kept as a named re-export
// because this script's flags and usage line have always spoken of it under this name.
export const DEFAULT_MAX_HISTORY_BYTES = MAX_PAGE_BYTES;

/**
 * A date, with its month and day BOUNDED — `1234-56-78` is the shape of a date and none of its
 * values.
 *
 * The bound is not pedantry. A heading naming a serial number, a version range or a part code in
 * that shape would be read as a date, filed under month 56, and written to a note path no router
 * regex accepts — the split would fail at the very last step, after the operator had approved it.
 * A section whose only candidate is out of range is simply undated, and inherits like any other.
 */
const DATE = String.raw`\d{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01])`;
const ISO_DATE = new RegExp(DATE);

/**
 * A provenance stamp, which is the second place a section's date can live.
 *
 * Sections written as an append under an existing heading carry their date inline
 * (`**[stated, 2026-08-20]** …`) rather than in the heading. Reading only headings would file
 * those under whatever heading happened to be above them with no date at all.
 */
const STAMP = new RegExp(String.raw`\[(?:stated|inferred|unconfirmed),\s*(${DATE})\]`);

/** A fence opener/closer: three or more backticks or tildes, indented at most three spaces. */
const FENCE = /^ {0,3}(`{3,}|~{3,})/;

/**
 * The comparable form of a heading: everything before the first ` — ` or ` (`, folded.
 *
 * Headings in this corpus are titles with their circumstances attached — "Known defects (found
 * 2026-07-25 — two fixed 2026-07-27)". `--keep "Known defects"` has to match that, and so does
 * pasting the whole heading back in, so BOTH sides go through this. Nothing else is normalised:
 * two sections sharing a leading phrase are MEANT to collide, since that is how a page's
 * recurring "Next" blocks are named — `keptSectionIndexes` then decides which of them stays.
 */
export function headingKey(heading: string): string {
  let end = heading.length;
  for (const sep of [" — ", " ("]) {
    const at = heading.indexOf(sep);
    if (at >= 0 && at < end) end = at;
  }
  return heading.slice(0, end).trim().toLowerCase();
}

/**
 * Which sections stay on the status page: for each kept heading, its LAST occurrence only.
 *
 * A page written by appending restates its plan. The largest page in this corpus carries four
 * `## Next` blocks, three of them superseded lists from three different weeks. Keeping every
 * match would lift all four onto the status page and re-assert every abandoned plan as current —
 * the exact failure the split exists to end. The last one is the live one; the earlier ones are
 * history, dated by the sections they sit under like any other moved block.
 *
 * Exported so the CLI's tables and the split itself cannot disagree about what "kept" means.
 */
export function keptSectionIndexes(sections: Section[], keepHeadings: string[]): Set<number> {
  const keys = keepHeadings.map(headingKey);
  const last = new Map<string, number>();
  sections.forEach((s, i) => {
    const key = headingKey(s.heading);
    if (keys.includes(key)) last.set(key, i);
  });
  return new Set(last.values());
}

/**
 * Split a page into frontmatter, preamble and H2 sections — by offset, never by rebuilding.
 *
 * A `## ` line inside a fenced code block is not a heading. This is not hypothetical politeness:
 * these pages quote their own markdown, and treating a quoted heading as a real one would cut a
 * code block in half and file the halves in two different months.
 */
export function parsePage(text: string): ParsedPage {
  const fm = parseFrontmatter(text);
  // parseFrontmatter hands back the body as a slice of the input, so the fence is exactly what
  // the input had — CRLF, trailing spaces on the closing line and all.
  const frontmatter = text.slice(0, text.length - fm.body.length);
  const body = fm.body;

  const starts: number[] = [];
  let offset = 0;
  let fence: string | null = null;
  for (const line of body.split("\n")) {
    const f = FENCE.exec(line);
    if (f) {
      if (fence === null) fence = f[1];
      else if (f[1][0] === fence[0] && f[1].length >= fence.length) fence = null;
    } else if (fence === null && line.startsWith("## ")) {
      starts.push(offset);
    }
    offset += line.length + 1; // the "\n" that split consumed; a trailing "\r" stays in `line`
  }

  const preamble = starts.length ? body.slice(0, starts[0]) : body;
  const sections: Section[] = starts.map((start, i) => {
    const end = i + 1 < starts.length ? starts[i + 1] : body.length;
    const chunk = body.slice(start, end);
    const nl = chunk.indexOf("\n");
    const heading = (nl < 0 ? chunk : chunk.slice(0, nl)).slice(3).trim();
    const date = ISO_DATE.exec(heading)?.[0] ?? STAMP.exec(chunk)?.[1] ?? null;
    return { heading, body: chunk, date };
  });

  return { frontmatter, preamble, sections };
}

function monthLabel(month: string): string {
  return `${MONTH_NAMES[Number(month.slice(5, 7)) - 1]} ${month.slice(0, 4)}`;
}

/**
 * How a file's contents are described, in the terms that are actually true of them.
 *
 * "2026-08-09 to 2026-08-31" reads as a range, and a range implies the file is ordered and
 * complete between its ends. Neither is so: the sections are in the order the page wrote them,
 * and a neighbouring part can hold an earlier date. So the wording says what it is — sections in
 * document order, with the date the first one carries and the date the last one carries.
 */
function sectionSpan(m: HistoryFileReport): string {
  const count = `${m.sections} section${m.sections === 1 ? "" : "s"} in document order`;
  if (!m.firstDate) return count;
  return `${count}, dated ${m.firstDate === m.lastDate ? m.firstDate : `${m.firstDate}…${m.lastDate}`}`;
}

/**
 * The frontmatter a history note is born with.
 *
 * `decays: false` because a month that has ended cannot go stale — the freshness machinery exists
 * to flag a claim that may have changed, and 2026-07 will not change. The description is composed
 * from this module's own counts, so it keeps the `·` separator the router's composed rows use;
 * only the heading is foreign text, and that goes through safeText.
 */
function historyFrontmatter(name: string, tags: string[], m: HistoryFileReport): string {
  const of = m.parts > 1 ? `part ${m.part} of ${m.parts} · ` : "";
  const prefix = `${name} · history ${monthLabel(m.month)} · ${of}${sectionSpan(m)} · first: `;
  const firstHeading = m.firstHeading;
  // A double quote would close the YAML scalar early and truncate the description silently, which
  // is the failure applyDescription refuses input for. Here the text is not the caller's to fix,
  // so the quote is folded rather than rejected.
  const first = safeText(firstHeading.replace(/"/g, "'"), Math.max(24, MAX_DESCRIPTION - prefix.length));
  const all = tags.includes("history") ? tags : [...tags, "history"];
  return `---\ndescription: "${prefix}${first}"\ntags: [${all.join(", ")}]\ndecays: false\n---\n`;
}

/**
 * Cut one month's sections into parts that each fit the byte cap.
 *
 * The cap bounds the SECTIONS a part carries, not the finished file — frontmatter and title add a
 * few hundred bytes on top. Measuring the file instead would make the cap depend on the part
 * count and the part count depend on the cap, and the reported file sizes say what actually
 * landed anyway.
 *
 * A part always takes at least one section, so a single section larger than the cap gets a part
 * of its own rather than being cut. Splitting inside a section would break the one guarantee this
 * script has.
 */
function partitionMonth(sections: Section[], maxBytes: number): Section[][] {
  if (!sections.length) throw new Error("partitionMonth: a month with no sections should not have a file");
  const parts: Section[][] = [];
  let current: Section[] = [];
  let bytes = 0;
  for (const s of sections) {
    const b = Buffer.byteLength(s.body, "utf8");
    if (current.length && bytes + b > maxBytes) {
      parts.push(current);
      current = [];
      bytes = 0;
    }
    current.push(s);
    bytes += b;
  }
  if (current.length) parts.push(current);
  return parts;
}

/**
 * Guarantee a following heading starts its own line — and add NOTHING else.
 *
 * The tempting version of this appends a blank line so `## History` sits off the text above it.
 * That blank line lands INSIDE the previous section's bytes, because a section runs to the next
 * heading, and the verifier would then be comparing a section it had quietly edited. One newline,
 * only when there is not one already, is the whole allowance.
 */
function endWithNewline(text: string): string {
  return text.endsWith("\n") || text === "" ? text : `${text}\n`;
}

export function splitPage(text: string, opts: SplitOpts): SplitResult {
  if (!/^[a-z0-9-]+$/.test(opts.name)) {
    throw new Error(`name must be [a-z0-9-]+ to make a history path, got ${JSON.stringify(opts.name)}`);
  }
  const parsed = parsePage(text);
  const maxHistoryBytes = opts.maxHistoryBytes ?? DEFAULT_MAX_HISTORY_BYTES;

  const keptAt = keptSectionIndexes(parsed.sections, opts.keepHeadings);

  const dated = parsed.sections.filter((s) => s.date).map((s) => s.date!.slice(0, 7));
  const earliest = dated.reduce<string | null>((a, b) => a === null || b < a ? b : a, null);

  const byMonth = new Map<string, Section[]>();
  const kept: Section[] = [];
  let undated = 0;
  let undatedLeading = 0;
  let previousMonth: string | null = null;

  for (const [i, s] of parsed.sections.entries()) {
    // Document order decides inheritance, so a kept dated section still anchors what follows it.
    if (s.date) previousMonth = s.date.slice(0, 7);
    if (keptAt.has(i) || earliest === null) {
      // With nothing dated anywhere there is no month to file under, and inventing one would be a
      // lie in a filename. The page stays whole; the cap below then says whether that is a problem.
      kept.push(s);
      continue;
    }
    let month: string;
    if (s.date) month = s.date.slice(0, 7);
    else if (previousMonth) {
      month = previousMonth;
      undated++;
    } else {
      month = earliest;
      undatedLeading++;
    }
    const bucket = byMonth.get(month);
    if (bucket) bucket.push(s);
    else byMonth.set(month, [s]);
  }

  const tags = parseFrontmatter(text).tags;
  const history = new Map<string, string>();
  const months: HistoryFileReport[] = [];
  for (const month of [...byMonth.keys()].sort((a, b) => a < b ? -1 : a > b ? 1 : 0)) {
    const parts = partitionMonth(byMonth.get(month)!, maxHistoryBytes);
    parts.forEach((secs, i) => {
      // A month that fits stays under its plain name. Renaming every month to `-1` for the sake of
      // consistency would rewrite the paths of months that had no reason to change, and every one
      // of those is a citation and a label that has to be chased.
      const path = parts.length === 1 ? `history/${opts.name}-${month}.md` : `history/${opts.name}-${month}-${i + 1}.md`;
      if (!HISTORY_PATH.test(path)) throw new Error(`refusing to emit an unroutable history path: ${path}`);
      const title = parts.length === 1 ? `${month}` : `${month} (part ${i + 1} of ${parts.length})`;
      const inFile = secs.filter((s) => s.date).map((s) => s.date!);
      const entry: HistoryFileReport = {
        path,
        month,
        part: i + 1,
        parts: parts.length,
        sections: secs.length,
        bytes: 0,
        firstDate: inFile[0] ?? "",
        lastDate: inFile[inFile.length - 1] ?? "",
        firstHeading: secs[0].heading,
      };
      let file = `${historyFrontmatter(opts.name, tags, entry)}\n# ${opts.name} — history ${title}\n\n`;
      // Concatenation, not a join: each body already carries the whitespace that followed it.
      for (const s of secs) file += s.body;
      entry.bytes = Buffer.byteLength(file, "utf8");
      history.set(path, file);
      months.push(entry);
    });
  }

  let status = parsed.frontmatter + parsed.preamble;
  for (const s of kept) status += s.body;
  if (months.length) {
    status = endWithNewline(status);
    status += `## History\n\n${HISTORY_INTRO}\n\n`;
    for (const m of months) {
      const of = m.parts > 1 ? ` part ${m.part} of ${m.parts},` : "";
      status += `- \`${m.path}\` — ${monthLabel(m.month)},${of} ${sectionSpan(m)}\n`;
    }
  }

  const statusBytes = Buffer.byteLength(status, "utf8");
  if (statusBytes > opts.maxStatusBytes) {
    throw new Error(
      `status page would be ${statusBytes} bytes > cap ${opts.maxStatusBytes} — keep fewer sections, or raise the cap`
    );
  }

  return {
    status,
    history,
    report: {
      sections: parsed.sections.length,
      kept: kept.length,
      moved: parsed.sections.length - kept.length,
      undated,
      undatedLeading,
      statusBytes,
      months,
    },
  };
}

/** Claim one so-far-unassigned original section with exactly these bytes, or nothing. */
function claim(pending: Map<string, number[]>, body: string): number | undefined {
  const queue = pending.get(body);
  return queue && queue.length ? queue.shift() : undefined;
}

/**
 * The guarantee, checked structurally.
 *
 * The question is "is every section still there, exactly once", and the first version of this
 * answered it by counting substrings — which is a different question. One section's bytes occur
 * inside another's in at least three ordinary ways: a page whose last block repeats an earlier
 * one without its trailing blank line (a prefix), a section quoting another inside a code fence,
 * a page that simply says the same thing twice. Each of those reported a DUPLICATED that was not
 * there, and a guarantee that cries wolf is one people learn to override.
 *
 * So the outputs are PARSED, not searched. Each file is cut into sections by the same reader that
 * cut the original, each output section is matched to an original by exact bytes, and each
 * original can be claimed once. What that buys is a partition: every index in 0..n-1 assigned to
 * exactly one file, nothing invented, nothing left over. `missing` is what no file claimed;
 * `duplicated` is what a file carried that no original explains.
 *
 * Two structural checks stand alongside it. The frontmatter and preamble must be at the TOP of the
 * status page, anchored rather than merely present somewhere in it; and every file must equal its
 * header plus its sections, which is a parser invariant rather than a content guard — see the
 * note at the check itself.
 *
 * THE ONE TOLERANCE, stated out loud: the final section of a file may carry trailing newlines the
 * original did not have. That is the only byte this script ever adds — a heading cannot be glued
 * onto the end of the previous line — and it is allowed at the end of a file and nowhere else.
 */
export function verifySplit(
  original: string,
  status: string,
  history: Map<string, string>
): { ok: boolean; missing: string[]; duplicated: string[] } {
  const parsed = parsePage(original);
  const missing: string[] = [];
  const duplicated: string[] = [];

  // ANCHORED, both of them. `includes` would accept a preamble that had drifted anywhere into the
  // page — under a heading, at the bottom — while this check's own comment promised it was still
  // at the top. The status page is built as frontmatter + preamble + kept sections, so the top is
  // exactly where it has to be, and that is what is asserted.
  if (parsed.frontmatter && !status.startsWith(parsed.frontmatter)) missing.push("(frontmatter)");
  if (parsed.preamble && !status.startsWith(parsed.frontmatter + parsed.preamble)) missing.push("(preamble)");

  const pending = new Map<string, number[]>();
  parsed.sections.forEach((s, i) => {
    const queue = pending.get(s.body);
    if (queue) queue.push(i);
    else pending.set(s.body, [i]);
  });

  const assigned = new Set<number>();
  const files: Array<[string, string]> = [["(status page)", status], ...history];
  for (const [path, text] of files) {
    const out = parsePage(text);
    // A PARSER INVARIANT, and named as one. `parsePage` tiles its whole input — frontmatter, then
    // preamble, then sections that run to the end — so this equality holds for every possible
    // string and cannot fail today. It is not, as an earlier comment here claimed, what stops
    // content hiding in a header; nothing has to, because the tiling leaves nowhere to hide. What
    // it is worth is the day someone teaches parsePage to skip or normalise a byte: this fails
    // immediately and loudly, instead of the section matching below quietly ignoring the gap.
    const rebuilt = out.frontmatter + out.preamble + out.sections.map((s) => s.body).join("");
    if (rebuilt !== text) {
      duplicated.push(`${path} — the file is not its header plus its sections`);
      continue;
    }
    out.sections.forEach((s, i) => {
      const isLast = i === out.sections.length - 1;
      let index = claim(pending, s.body);
      for (let body = s.body; index === undefined && isLast && body.endsWith("\n"); ) {
        body = body.slice(0, -1);
        index = claim(pending, body);
      }
      if (index !== undefined) {
        assigned.add(index);
        return;
      }
      // The `## History` block this script appends is the one section no original explains, and
      // it can only ever be the last thing on the status page.
      if (path === "(status page)" && isLast && headingKey(s.heading) === "history") return;
      duplicated.push(`${path} — a section the original does not contain: ## ${s.heading}`);
    });
  }

  // The partition, read off what was claimed: an index no file took is a section that vanished.
  parsed.sections.forEach((s, i) => {
    if (!assigned.has(i)) {
      missing.push(`${s.heading} — section ${i + 1} of ${parsed.sections.length}, claimed by no output file`);
    }
  });

  return { ok: missing.length === 0 && duplicated.length === 0, missing, duplicated };
}

/**
 * The page-month a history file belongs to: `history/<name>-YYYY-MM[-n].md` → `history/<name>-YYYY-MM`.
 *
 * Greedy on purpose, and for the same reason `historyPageName` is: a page whose own name ends in
 * something year-month shaped (`tricam-2025-01`) must resolve to that page's month, not to a month
 * invented out of the middle of its name. Backtracking from the longest match gives
 * `history/tricam-2025-01-2026-08-2.md` → `history/tricam-2025-01-2026-08`, which is right.
 */
const PAGE_MONTH = /^(history\/[a-z0-9-]+-\d{4}-\d{2})(?:-\d+)?\.md$/;

/** The key a destination is compared on. Anything unparseable falls back to its own path, so an
 *  unexpected shape is still caught by an exact collision rather than waved through. */
function monthKeyOf(path: string): string {
  return PAGE_MONTH.exec(path)?.[1] ?? path;
}

/**
 * Files already on disk for any page-month `destinations` is about to write, in path order.
 *
 * Reads the directory rather than testing each destination, because the file that must stop the
 * run is often not a destination at all: it is the SAME month filed under a different part count,
 * which by construction has a name this run will never produce.
 */
function filedAlready(brain: string, destinations: string[]): string[] {
  const months = new Set(destinations.map(monthKeyOf));
  const dir = join(brain, "history");
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".md"))
    .map((f) => `history/${f}`)
    .filter((p) => months.has(monthKeyOf(p)))
    .sort();
}

/**
 * Put a split on disk — every history file first, the page last — or refuse and write nothing.
 *
 * THE REFUSAL IS THE POINT. `verifySplit` proves that the OUTPUT of one run accounts for the
 * INPUT of that run, and every check in this script is shaped the same way: it reasons about the
 * page it was handed. A history note already sitting on disk is not part of that reasoning, so
 * nothing above this line can see it. Running the split a second time on a page that has since
 * accumulated new dated sections — the natural thing to do — used to open
 * `history/<name>-YYYY-MM.md` and write the NEW sections over the old ones, destroying the filed
 * record while the run printed "every section preserved byte-for-byte". Neither safety net could
 * catch it: the git gate looks for UNCOMMITTED changes and the first split was committed, and the
 * from-disk re-verify re-reads only the files it has just written.
 *
 * So this fails closed before a single byte is written, and it asks the question one level wider
 * than "does this exact filename exist". A month that FITS is filed as `<name>-YYYY-MM.md` and a
 * month that does not is filed as `<name>-YYYY-MM-<i>.md`; those two schemes never collide with
 * each other, so a month whose part count changed between runs used to slip through — the second
 * run wrote happily and left the first run's files on disk, still real notes but no longer named
 * by the page's own `## History` listing. Nothing is destroyed that way, but a page that stops
 * pointing at its own record has lost it in every sense the operator cares about. So the check is
 * on the PAGE-MONTH prefix: if anything is already filed for a month this run is about to file,
 * under any part count, the run refuses.
 *
 * The same check covers the other route into the same hole: `name` comes from the basename, so
 * `projects/harbor.md` and `notes/harbor.md` both emit `history/harbor-YYYY-MM.md`, and splitting
 * the second would land on the first's months. All of it is one question — "is something already
 * filed here?" — and one answer.
 *
 * NO --force, AND NO MERGE. Appending or interleaving would mean this script deciding, on its own,
 * how someone's only copy of a record fits together with bytes it did not produce; doing the
 * clever thing with that material unasked is how the bug above existed at all. A refusal costs a
 * manual step and is always recoverable. The alternative is not.
 */
export function writeSplit(brain: string, page: string, out: SplitResult): string[] {
  const taken = filedAlready(brain, [...out.history.keys()]);
  if (taken.length) {
    const s = taken.length === 1 ? "" : "s";
    throw new Error(
      `REFUSED: ${taken.length} history file${s} already filed for ${taken.length === 1 ? "a month" : "months"} ` +
        `this run would write, in ${brain} — NOTHING was written:\n` +
        taken.map((p) => `  ${p}`).join("\n") +
        `\n\nRe-splitting an already-split page is not supported, and neither is splitting two pages ` +
        `with the same basename (projects/<name>.md and notes/<name>.md both file to history/<name>-*.md). ` +
        `This run would have replaced or orphaned ${taken.length === 1 ? "that file" : "those files"} — the ` +
        `new ones carry only the sections ${page} holds TODAY, and a month filed under a different part ` +
        `count keeps its bytes but loses its place in the page's ## History listing.\n` +
        `Move or rename the existing file${s} if this is really what you want; there is deliberately no --force.`
    );
  }

  // HISTORY FIRST, THE PAGE LAST. Writing the shortened source page first can leave the only copy
  // of its record incomplete if a later history write fails. In this order every
  // byte exists in a new file before the old one is touched, so the worst interruption leaves the
  // page whole and some extra files beside it.
  const written: string[] = [];
  for (const [p, t] of out.history) {
    const dest = join(brain, p);
    mkdirSync(dirname(dest), { recursive: true });
    writeFileSync(dest, t, "utf8");
    written.push(p);
  }
  writeFileSync(join(brain, page), out.status, "utf8");
  written.push(page);
  return written;
}

/* ------------------------------------------------------------------ CLI */

/**
 * Uncommitted changes under these paths, or null when git cannot answer.
 *
 * Null and empty are deliberately different. "Nothing is dirty" permits the write; "I could not
 * find out" must not, because the whole point of the check is that an undo exists.
 */
function gitStatus(dir: string, paths: string[]): string[] | null {
  try {
    const git = resolveTrustedExecutable("git");
    const out = execFileSync(git, ["-C", dir, "status", "--porcelain", "--", ...paths], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return out.split("\n").filter(Boolean);
  } catch {
    return null;
  }
}

/**
 * A flag's value, refusing to swallow the next flag as one.
 *
 * `--page --write` used to bind "--write" as the page name, and the run then failed on a missing
 * file with the flag reported back as a path. A value that opens with `--` is a forgotten
 * argument, not a value.
 */
function flag(argv: string[], name: string): string | undefined {
  const at = argv.indexOf(name);
  if (at < 0) return undefined;
  const value = argv[at + 1];
  if (value === undefined || value.startsWith("--")) throw new Error(`${name} needs a value`);
  return value;
}

function main(argv: string[]): number {
  const page = flag(argv, "--page");
  if (!page) {
    console.error(
      'usage: split-project-page.ts --page projects/<name>.md [--brain <dir>] [--keep "Status,Next"] ' +
        `[--max-status-bytes 8192] [--max-history-bytes ${DEFAULT_MAX_HISTORY_BYTES}] [--write]`
    );
    return 2;
  }
  const brain = resolve(flag(argv, "--brain") ?? join(process.cwd(), "..", "brain"));
  const keepHeadings = (flag(argv, "--keep") ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const maxStatusBytes = Number(flag(argv, "--max-status-bytes") ?? 8192);
  // NaN loses every comparison it is given, so a mistyped cap would not refuse anything — it
  // would silently permit a status page of any size, which is the one outcome this flag exists
  // to prevent.
  if (!Number.isFinite(maxStatusBytes) || maxStatusBytes <= 0) {
    console.error(`--max-status-bytes must be a positive number, got ${flag(argv, "--max-status-bytes")}`);
    return 2;
  }
  const maxHistoryBytes = Number(flag(argv, "--max-history-bytes") ?? DEFAULT_MAX_HISTORY_BYTES);
  if (!Number.isFinite(maxHistoryBytes) || maxHistoryBytes <= 0) {
    console.error(`--max-history-bytes must be a positive number, got ${flag(argv, "--max-history-bytes")}`);
    return 2;
  }
  const write = argv.includes("--write");
  const name = page.replace(/^.*\//, "").replace(/\.md$/, "");

  const abs = join(brain, page);
  const original = readFileSync(abs, "utf8");

  // Reported with the cap lifted, then judged against it. A run that busts the cap is exactly the
  // run whose section table the operator needs to see, so the numbers are printed before the
  // refusal rather than replaced by it.
  const out = splitPage(original, { name, keepHeadings, maxStatusBytes: Infinity, maxHistoryBytes });
  const parsed = parsePage(original);
  const keptAt = keptSectionIndexes(parsed.sections, keepHeadings);

  console.log(`page            ${page}`);
  console.log(`bytes           ${Buffer.byteLength(original, "utf8")}`);
  console.log(`sections        ${out.report.sections}`);
  console.log(`kept            ${out.report.kept} (the LAST occurrence of each kept heading)`);
  for (const k of keepHeadings) {
    const hits = parsed.sections.map((s, i) => [s, i] as const).filter(([s]) => headingKey(s.heading) === headingKey(k));
    console.log(`  ${k} — ${hits.length} match${hits.length === 1 ? "" : "es"}`);
    for (const [s, i] of hits) {
      const fate = keptAt.has(i) ? "KEPT     " : "→ history";
      console.log(`      ${fate}  ${String(Buffer.byteLength(s.body, "utf8")).padStart(6)} bytes  ## ${s.heading}`);
    }
  }
  console.log(`moved           ${out.report.moved}`);
  console.log(`undated         ${out.report.undated} inherited the month above, ${out.report.undatedLeading} leading`);
  console.log(`status page     ${out.report.statusBytes} bytes (cap ${maxStatusBytes})`);
  console.log(`history files   ${out.report.months.length} (cap ${maxHistoryBytes} bytes of sections per file)`);
  for (const m of out.report.months) {
    const dates = !m.firstDate ? "undated" : m.firstDate === m.lastDate ? m.firstDate : `${m.firstDate}…${m.lastDate}`;
    const n = `${m.sections} section${m.sections === 1 ? " " : "s"}`;
    console.log(`  ${m.path}  ${n.padStart(12)} in document order  ${String(m.bytes).padStart(7)} bytes  dated ${dates}`);
  }

  const v = verifySplit(original, out.status, out.history);
  console.log(`verify          ${v.ok ? "ok — every section preserved byte-for-byte" : "FAILED"}`);
  for (const m of v.missing) console.log(`  MISSING     ${m}`);
  for (const d of v.duplicated) console.log(`  DUPLICATED  ${d}`);
  if (!v.ok) return 1;

  if (out.report.statusBytes > maxStatusBytes) {
    console.error(`\nREFUSED: the status page is ${out.report.statusBytes - maxStatusBytes} bytes over the cap.`);
    console.error("Drop a heading from --keep, or raise --max-status-bytes. Kept sections, largest first:");
    const hits = parsed.sections.filter((_, i) => keptAt.has(i));
    for (const s of [...hits].sort((a, b) => b.body.length - a.body.length)) {
      console.error(`  ${String(Buffer.byteLength(s.body, "utf8")).padStart(7)}  ## ${s.heading}`);
    }
    return 1;
  }

  if (!write) {
    console.log("\ndry run — nothing written. Add --write to apply.");
    return 0;
  }

  // A CLEAN WORKTREE, OR NOTHING. This rewrites a page and creates a directory of new notes; the
  // undo is `git checkout`, and that undo only exists if there was nothing else uncommitted in
  // those paths to lose. Refusing here costs a commit; not refusing costs whatever the operator
  // had in flight.
  const dirty = gitStatus(brain, [page, "history/"]);
  if (dirty === null) {
    console.error(`\nREFUSED: cannot read git status in ${brain} — no clean state to fall back to.`);
    return 1;
  }
  if (dirty.length) {
    console.error(`\nREFUSED: uncommitted changes under ${page} or history/ — commit or stash them first:`);
    for (const line of dirty) console.error(`  ${line}`);
    return 1;
  }

  // Refuses on any history destination that already exists, and writes nothing when it does —
  // see writeSplit. The throw is caught at the CLI boundary and printed as a message.
  const written = writeSplit(brain, page, out);
  const fromDisk = new Map<string, string>();
  for (const p of out.history.keys()) fromDisk.set(p, readFileSync(join(brain, p), "utf8"));
  const after = verifySplit(original, readFileSync(abs, "utf8"), fromDisk);
  console.log(`\nwrote ${written.length} files; re-verified from disk: ${after.ok ? "ok" : "FAILED"}`);
  for (const m of after.missing) console.error(`  MISSING     ${m}`);
  for (const d of after.duplicated) console.error(`  DUPLICATED  ${d}`);
  return after.ok ? 0 : 1;
}

// Importing this module must not run it: the test suite imports splitPage directly.
if (/split-project-page\.[cm]?ts$/.test(process.argv[1] ?? "")) {
  // Bad input is a message, not a stack trace. A refusal the operator cannot read is a refusal
  // they will work around.
  let code: number;
  try {
    code = main(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    code = 2;
  }
  process.exit(code);
}
