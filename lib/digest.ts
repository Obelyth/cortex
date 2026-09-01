/**
 * digest — the router line for a day-log, derived rather than written.
 *
 * Notes get a description authored into their frontmatter. Day-logs must not: there are nine of
 * them now and there will be one per day forever, so any convention that asks a human or a nightly
 * job to write a description for each one is a convention that rots. `brain_capture` already
 * stamps every entry `## HH:MM · tag, tag`, and 42 distinct tags are in use across the existing
 * logs. That is routing signal already sitting in the corpus, unread.
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
 * entry heading, and nothing constrains its size. One 200 KB tag on a single heading turned an
 * 8,000-byte boot budget into a 200,686-byte boot call — from a day the budget had explicitly
 * declined to expand. The count was bounded; the bytes were not.
 */
const MAX_TAG_CHARS = 40;

export function isLogPath(path: string): boolean {
  return LOG_PATH.test(path);
}

export function dateFromLogPath(path: string): string {
  return path.match(LOG_PATH)?.[1] ?? "";
}

export interface Digest {
  entries: number;
  /** Union of every entry's tags, first-seen order, de-duplicated. */
  tags: string[];
  /** The router-line description. */
  description: string;
}

export function logDigest(text: string): Digest {
  const tags: string[] = [];
  let entries = 0;

  for (const raw of text.split(/\r?\n/)) {
    const m = raw.trimEnd().match(ENTRY);
    if (!m) continue;
    entries++;
    for (const t of (m[2] ?? "").split(",")) {
      const v = t.trim().toLowerCase().slice(0, MAX_TAG_CHARS);
      if (v && !tags.includes(v)) tags.push(v);
    }
  }

  return { entries, tags, description: describe(entries, tags) };
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
