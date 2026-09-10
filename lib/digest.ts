/**
 * digest — the router line for a day-log, derived rather than written.
 *
 * Notes get a description authored into their frontmatter. Day-logs must not: there can be one
 * per day forever, so any convention that asks a human or a nightly
 * job to write a description for each one is a convention that rots. `brain_capture` already
 * stamps every entry `## HH:MM · tag, tag`. That is routing signal already sitting in the
 * corpus, unread.
 *
 * So a log's description is computed from its own headings on every render. It cannot drift from
 * the file, it needs no backfill, and a day written by any surface gets one for free.
 *
 * Derived, not summarised: this counts and lists, it never paraphrases. A model-written summary of
 * a day would be a second, weaker account of it sitting in the always-loaded context — and the
 * whole design says summaries make things findable, never readable in place of the real text.
 */

/** `log/YYYY-MM-DD.md`, and nothing else. */
const LOG_PATH = /^log\/(\d{4}-\d{2}-\d{2})\.md$/;

/**
 * A timestamped entry heading, with its optional tag list.
 *
 * The `\d{2}:\d{2}` is load-bearing. Real day-logs carry prose H2s that are not entries —
 * `## <a topic heading>` is a section inside a day, not a new entry —
 * and counting those inflates the entry count on exactly the busiest days.
 */
const ENTRY = /^##[ \t]+(\d{2}:\d{2})(?:[ \t]*·[ \t]*(.*))?$/;
// `[ \t]+` immediately followed by an optional `[ \t]*` lets the engine split a run of spaces
// between the two quantifiers many ways before failing — super-linear on a line of nothing but
// spaces, which a note can contain. Anchoring the separator to a single class removes the split.

/** Enough tags to identify a day; beyond this the line stops being a signpost and starts being a
 *  wall. The overflow is counted out loud rather than silently dropped. */
const MAX_TAGS = 8;

/**
 * And a ceiling on each tag's LENGTH, not only on how many there are.
 *
 * Capping the count alone left the digest unbounded: a tag is whatever text follows the `·` on an
 * entry heading, and nothing constrains its size. A single oversized tag can make the boot call
 * exceed a budget that declined to expand the day. The count was bounded; the bytes were not.
 */
const MAX_TAG_CHARS = 40;

/**
 * `history/<name>-YYYY-MM.md` — a dated slice of a page that grew too large to stay one file.
 *
 * These are NOT day logs. A history page is one month of one project's record, written once and
 * afterwards reached by name, so it keeps its own authored description and its own router row.
 * The prefix is what lets the router tell "one month of harbor, findable" apart from "one day,
 * derived": both are dated, only one is worth a row of the always-loaded budget.
 *
 * THE OPTIONAL `-<n>` IS A PART, NOT A DAY. A month is a filing rule, not a size: one month of a
 * project running flat out is a quarter of a megabyte, and a history note that big brings back
 * the very pack size the split was performed to cure. Such a month is written as ordered parts —
 * `-1`, `-2`, … — which are ordinary notes in every other respect: each has its own description,
 * its own router row, and is reached by name. Only `monthKey` folds them back together.
 */
/**
 * The size at which a page has outgrown the boot call and should be split.
 *
 * ONE DEFINITION, imported by both users. scripts/split-project-page.ts cuts history notes to
 * this bound, and lib/inbox.ts raises a page that has crossed it — a threshold written twice is
 * a threshold that drifts, which is the failure this repo has now found in its export gate, its
 * brain-gate suite list and its router budget in the same week.
 *
 * A month is a filing rule, not a size. A large history note can crowd everything else out of a
 * pack, so the generic threshold remains independent of any one corpus snapshot.
 */
export const MAX_PAGE_BYTES = 64000;

export const HISTORY_PATH = /^history\/([a-z0-9-]+)-(\d{4})-(\d{2})(?:-(\d+))?\.md$/;

export function isLogPath(path: string): boolean {
  return LOG_PATH.test(path);
}

export function isHistoryPath(path: string): boolean {
  return HISTORY_PATH.test(path);
}

/**
 * The source page a history part belongs to — `history/harbor-2026-08-2.md` → `harbor`. Null
 * for a non-history path. Distinct from `monthKey`: two months of the same page share a page
 * name but not a month key. narrow()'s per-pack part cap groups by page, not by month, because
 * an oversized project's history floods a pack across MONTHS, not just within one — capping
 * per month would still let every month of the same page compete for its own slots.
 */
export function historyPageName(path: string): string | null {
  return path.match(HISTORY_PATH)?.[1] ?? null;
}

export function dateFromLogPath(path: string): string {
  return path.match(LOG_PATH)?.[1] ?? "";
}

/**
 * The month a path belongs to, or null when the path is not dated.
 *
 * `log/2026-08-04.md` → `log/2026-08`. Many days collapse onto one key, which is the point: the
 * router spends one row on the month instead of one per day, forever.
 *
 * `history/harbor-2026-08.md` → `history/harbor-2026-08` — itself, minus the extension. A history
 * page is already exactly one month and collapses with nothing. It answers anyway so that callers
 * asking "is this path routed, or is its month?" have ONE rule to apply rather than a rule and an
 * exception; the router's coverage guarantee is stated in those terms.
 *
 * `history/harbor-2026-08-2.md` → `history/harbor-2026-08` as well. The parts of an oversized
 * month are siblings, not three different months, so the key is composed from the match rather
 * than sliced off the filename — the difference matters only here, and only for parts.
 */
export function monthKey(path: string): string | null {
  const log = path.match(LOG_PATH);
  if (log) return `log/${log[1].slice(0, 7)}`;
  const history = path.match(HISTORY_PATH);
  if (history) return `history/${history[1]}-${history[2]}-${history[3]}`;
  return null;
}

export interface Digest {
  entries: number;
  /** Union of every entry's tags, first-seen order, de-duplicated. */
  tags: string[];
  /**
   * How many ENTRIES carried each tag, keyed in first-seen order.
   *
   * The router's month row names a month's loudest tags, and "loudest" has to be countable:
   * `tags` is a set, so on it a tag that appeared once in one day ranks equal with one that
   * appeared in forty. Counted per entry rather than per day, so a busy day speaks in
   * proportion to how busy it was.
   */
  tagEntries: Map<string, number>;
  /** The router-line description. */
  description: string;
}

export function logDigest(text: string): Digest {
  const tags: string[] = [];
  const tagEntries = new Map<string, number>();
  let entries = 0;

  for (const raw of text.split(/\r?\n/)) {
    const m = raw.trimEnd().match(ENTRY);
    if (!m) continue;
    entries++;
    // De-duplicated WITHIN the entry as well as across the file: `## 09:00 · kiln, kiln` is one
    // entry that mentions kiln, not two, and a count that says otherwise is a count of commas.
    const seen = new Set<string>();
    for (const t of (m[2] ?? "").split(",")) {
      const v = t.trim().toLowerCase().slice(0, MAX_TAG_CHARS);
      if (!v || seen.has(v)) continue;
      seen.add(v);
      if (!tags.includes(v)) tags.push(v);
      tagEntries.set(v, (tagEntries.get(v) ?? 0) + 1);
    }
  }

  return { entries, tags, tagEntries, description: describe(entries, tags) };
}

/** One timestamped entry of a day-log: its heading parts and its verbatim text. */
export interface LogSection {
  /** "HH:MM" from the entry heading. */
  time: string;
  /** The raw text after the `·`, exactly as authored ("" when untagged). Callers that render
   *  it are responsible for safeText — this is the same untrusted note text as everything else. */
  tags: string;
  /** The section verbatim: its heading line through the line before the next entry heading. */
  text: string;
}

/**
 * Split a day-log into its `## HH:MM · tags` sections. The ENTRY shape has one home (this
 * file); brain_handoff needs the sections themselves — which entries mention a project — where
 * logDigest only needs their count. Prose H2s inside an entry stay inside it, same as the
 * digest: `## <topic>` is a section of a day, not a new entry. Text before the first entry
 * heading (the `# Log YYYY-MM-DD` title line) belongs to no section and is not returned.
 */
export function logSections(text: string): LogSection[] {
  const out: LogSection[] = [];
  let current: { time: string; tags: string; lines: string[] } | null = null;
  const close = () => {
    if (current) out.push({ time: current.time, tags: current.tags, text: current.lines.join("\n").trimEnd() });
  };
  for (const raw of text.split(/\r?\n/)) {
    const m = raw.trimEnd().match(ENTRY);
    if (m) {
      close();
      current = { time: m[1], tags: (m[2] ?? "").trim(), lines: [raw] };
    } else if (current) {
      current.lines.push(raw);
    }
  }
  close();
  return out;
}

function describe(entries: number, tags: string[]): string {
  if (entries === 0) return "no entries";
  const count = entries === 1 ? "1 entry" : `${entries} entries`;
  if (tags.length === 0) return `${count}, untagged`;
  const shown = tags.slice(0, MAX_TAGS).join(", ");
  const rest = tags.length - MAX_TAGS;
  return rest > 0 ? `${count}: ${shown}, +${rest} more` : `${count}: ${shown}`;
}
