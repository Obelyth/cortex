/**
 * frontmatter — the router's raw material.
 *
 * The router is one line per note: path, a one-sentence description, tags, last-updated. The
 * description lives in the note's own YAML frontmatter rather than in a database, because the
 * brain has to stay self-describing — a bare `git clone` must carry its own routing layer with no
 * dependency on this server or on any store. Notes that already use this shape keep it
 * (`notes/feedback-*.md`); the rest are backfilled.
 *
 * WHY A HAND-ROLLED PARSER. The frontmatter this reads is three scalar keys and a tag list, on
 * files this server already trusts. A YAML dependency would add a parser with its own alias,
 * anchor and merge-key semantics to the load path of every write — surface area bought for
 * nothing. What is here reads the keys it knows and ignores everything else, including the nested
 * `metadata:` blocks the existing feedback notes carry.
 *
 * ABSENCE IS A NON-EVENT, and that is the load-bearing rule. On day one most notes have no
 * frontmatter at all. A parser that threw, or a router that skipped what it could not describe,
 * would make those notes invisible in the one surface that is supposed to list everything — the
 * silent-loss failure the rest of this system is built to prevent. So every path here degrades to
 * "no description", never to "no note".
 */

import { isLogPath, logDigest, dateFromLogPath } from "./digest";

/**
 * The one string comparator this module sorts with.
 *
 * A bare `.sort()` orders by UTF-16 code unit, which is deterministic but reads as an accident;
 * a bare `localeCompare()` follows the HOST locale, which is the opposite problem — the router is
 * regenerated on every write, so a comparator that varies by machine would commit a spurious diff
 * every time a different box wrote a note. Pinning the locale gives a defined order that is the
 * same everywhere.
 */
export const byName = (a: string, b: string): number =>
  // The tiebreak is not decoration. localeCompare can return 0 for strings that are not
  // equal — different Unicode normalisations of the same text, most obviously — and a
  // comparator that calls two distinct paths equal is not a total order. Anything paging on
  // it then has to guess which of the two it already returned.
  a.localeCompare(b, "en") || (a < b ? -1 : a > b ? 1 : 0);

export interface Frontmatter {
  /** One sentence describing the note. "" when the note has none yet. */
  description: string;
  /** Lowercased, de-duplicated, order-preserved. Empty when absent. */
  tags: string[];
  /**
   * The note minus its frontmatter block, byte-for-byte — including any blank line that followed
   * the closing fence. Never trimmed: note text is what citations are proven against, so this
   * function does not get to rewrite it.
   */
  body: string;
}

const EMPTY = (text: string): Frontmatter => ({ description: "", tags: [], body: text });

/**
 * Strip one layer of matching quotes.
 *
 * Only when BOTH ends match, so `a brain's notes` keeps its apostrophe and `'it: works'` loses its
 * wrapper. A naive strip of any leading or trailing quote mangles the median description in this
 * corpus, which is prose with punctuation in it.
 */
function unquote(s: string): string {
  const t = s.trim();
  if (t.length >= 2 && ((t[0] === '"' && t.endsWith('"')) || (t[0] === "'" && t.endsWith("'")))) {
    return t.slice(1, -1);
  }
  return t;
}

/**
 * Join the indented lines under a block-scalar key into one line.
 *
 * Folded (`>`) and literal (`|`) are both flattened to spaces: a router row is one line by
 * construction, so preserving literal newlines here would only hand safeText something to strip.
 */
function foldBlockScalar(lines: string[], keyIndex: number): string {
  const out: string[] = [];
  for (let j = keyIndex + 1; j < lines.length; j++) {
    if (!/^\s+\S/.test(lines[j])) break;
    out.push(lines[j].trim());
  }
  return out.join(" ");
}

function normaliseTags(raw: string[]): string[] {
  const out: string[] = [];
  for (const t of raw) {
    const v = unquote(t).toLowerCase().trim();
    if (v && !out.includes(v)) out.push(v);
  }
  return out;
}

/**
 * Parse a note's YAML frontmatter.
 *
 * The fence must open on line 1 — a `---` anywhere else is a horizontal rule or, in this corpus,
 * a `--- log/2026-08-04.md ---` banner inside a context dump. Treating those as frontmatter would
 * silently truncate the note body at an arbitrary point.
 */
export function parseFrontmatter(text: string): Frontmatter {
  // One match decides both halves, so the fence can never be measured two different ways. The
  // body is sliced from the ORIGINAL text, so a CRLF note round-trips byte-for-byte: the verifier
  // proves quotes against file bytes, and a parser that quietly rewrote line endings would break
  // citations on exactly those files. The inner group is optional so an empty frontmatter block
  // is still recognised as one rather than left in the body.
  // An unterminated fence simply does not match — guessing where it ends would eat the note.
  const m = /^---\r?\n(?:([\s\S]*?)\r?\n)?---[ \t]*(?:\r?\n|$)/.exec(text);
  if (!m) return EMPTY(text);

  const block = m[1] ?? "";
  const after = text.slice(m[0].length);

  let description = "";
  let tags: string[] = [];
  const lines = block.split(/\r?\n/);

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // Top-level keys only. Indented lines belong to a nested block — `metadata:` in the existing
    // a nested block — and a `description:` inside one is not this note's description.
    if (/^\s/.test(line)) continue;

    const m = /^([A-Za-z0-9_-]+)[ \t]*:[ \t]*(.*)$/.exec(line);
    if (!m) continue;
    const [, key, rest] = m;

    if (key === "description" && !description) {
      // A block scalar (`>`, `>-`, `|`, `|+`) puts the value on the lines BELOW the key. Reading
      // `rest` here yielded the indicator itself, so the router rendered a row whose description
      // was the literal text ">-" — and worse, counted the note as described and made
      // applyDescription refuse to fix it, since ">-" is truthy. Not a hypothetical: a YAML
      // serialiser folds any one-line description past its line width into exactly this shape.
      description = /^[|>][-+]?\d*$/.test(rest.trim())
        ? foldBlockScalar(lines, i)
        : unquote(rest);
    } else if (key === "tags" && tags.length === 0) {
      const inline = rest.trim();
      if (inline.startsWith("[")) {
        tags = normaliseTags(inline.replace(/^\[|\]$/g, "").split(","));
      } else if (inline) {
        tags = normaliseTags(inline.split(","));
      } else {
        // Block sequence: consume the following `  - value` lines.
        const seq: string[] = [];
        for (let j = i + 1; j < lines.length; j++) {
          const item = /^[ \t]+-[ \t]+(.*)$/.exec(lines[j]);
          if (!item) break;
          seq.push(item[1]);
        }
        tags = normaliseTags(seq);
      }
    }
  }

  return { description, tags, body: after };
}

/**
 * Add a description to a note that lacks one, without disturbing anything else.
 *
 * This is the one function here that WRITES note text, so it is the one that can do damage. Three
 * rules keep it safe:
 *
 *   1. It never overwrites an existing description. Notes that already carry one were
 *      written deliberately; a backfill that clobbered them would be a backfill that destroys the
 *      very thing it exists to create. Re-running over a described note is a no-op.
 *   2. It refuses input it cannot represent rather than emitting YAML it cannot read back. A
 *      description containing a double quote or a newline parses as something shorter than what
 *      was written — a silent truncation, in a file nobody will re-read.
 *   3. The body is concatenated, never rewritten, so a CRLF note keeps its line endings and every
 *      byte a citation might be proven against survives untouched.
 */
export function applyDescription(text: string, description: string, tags: string[]): string {
  const d = description.trim();
  if (!d) throw new Error("applyDescription: description is empty");
  if (d.includes('"') || /[\r\n]/.test(d)) {
    throw new Error(`applyDescription: description contains a quote or newline: ${JSON.stringify(d)}`);
  }
  for (const t of tags) {
    if (!/^[a-z0-9][a-z0-9._-]*$/.test(t)) {
      throw new Error(`applyDescription: unusable tag ${JSON.stringify(t)}`);
    }
  }

  const tagLine = tags.length ? `\ntags: [${tags.join(", ")}]` : "";
  const existing = parseFrontmatter(text);

  // No frontmatter at all: prepend a fresh block. `text` is appended verbatim.
  if (existing.body === text) {
    return `---\ndescription: "${d}"${tagLine}\n---\n\n${text}`;
  }
  // Has a block and already describes itself: leave it exactly as it is.
  if (existing.description) return text;

  // Has a block with no description: splice the key in after the opening fence, so the keys
  // already there — including nested `metadata:` — keep their order and indentation.
  const open = text.indexOf("\n") + 1;
  return `${text.slice(0, open)}description: "${d}"${tagLine}\n${text.slice(open)}`;
}

export interface RouterEntry {
  path: string;
  description: string;
  tags: string[];
  /** ISO date the note was last modified, or "" when unknown. */
  updated: string;
  /** The note moved after its description was written, so the description is unproven. */
  stale: boolean;
}

/**
 * One router line.
 *
 * A note with no description STILL GETS A LINE. It is marked, not omitted: the router is the
 * complete list of what exists, and a note missing from it is a note the reader has no way to
 * discover. Same rule for a stale description — marked, never hidden, because a description that
 * has fallen behind its note is worth less than a fresh one but far more than nothing.
 */
/** Longest description a row will render. Comfortably above the ~21-word house style. */
export const MAX_DESCRIPTION = 200;
/** Most tags a row will show; the remainder is counted rather than dropped in silence. */
export const MAX_ROW_TAGS = 6;

/**
 * Make note-authored text safe to render into the always-loaded router.
 *
 * WHY THIS EXISTS AT RENDER TIME rather than at write time. `applyDescription` already refuses
 * hostile input on the way in — but it is not the only way text reaches a description. Notes are
 * hand-edited, restored from backups, written by earlier versions of this code, and on the guest
 * door *proposed by a model this server does not control*. The read path has to hold by itself.
 *
 * Doing it here also keeps the note's own bytes untouched, which is load-bearing: the verifier
 * proves quotes against file bytes, so a sanitiser that rewrote notes would break citations on
 * exactly the files it touched.
 *
 * Three properties, each earning its place:
 *
 *   1. NO CONTROL CHARACTERS. Line-based parsing already blocks a literal newline, but a lone CR
 *      is not a line break to the parser and *is* a cursor-return to a terminal — enough to redraw
 *      one row over another. U+2028/2029 are line breaks to some renderers and not to others.
 *   2. NO FIELD SEPARATOR. A row is `- path · description · tags · date`. A description carrying
 *      `·` can make a reader see fields, and a path, that no note ever declared. This is the same
 *      boundary-forgery problem `lib/ask.ts` solves with per-request nonces; here the row is short
 *      and structural, so neutralising the separator is the proportionate fix.
 *   3. A LENGTH BOUND. The router is the one tier loaded on every call, and without this a single
 *      note decides what every session costs — a 100 KB description is a 100 KB boot call. The
 *      budget this whole design rests on cannot be one note away from meaningless.
 */
export function safeText(s: string, max: number): string {
  const clean = s
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001F\u007F\u2028\u2029]/g, " ")
    .replace(/·/g, "-")
    .replace(/\s+/g, " ")
    .trim();
  return clean.length <= max ? clean : `${clean.slice(0, max - 1)}…`;
}

export function routerLine(e: RouterEntry): string {
  const description = safeText(e.description, MAX_DESCRIPTION);
  if (!description) return `- ${e.path} · (no description yet)`;
  const parts = [e.path, description];
  if (e.tags.length) {
    const shown = e.tags.slice(0, MAX_ROW_TAGS).map((t) => safeText(t, 40));
    const rest = e.tags.length - MAX_ROW_TAGS;
    parts.push(rest > 0 ? `${shown.join(", ")}, +${rest} more` : shown.join(", "));
  }
  if (e.updated) parts.push(safeText(e.updated, 20));
  const line = `- ${parts.join(" · ")}`;
  return e.stale ? `${line} · STALE` : line;
}

/** Directory order, matching the listing INDEX.md has always used. */
const ORDER = ["Root", "projects", "notes", "log", "archive"];

/**
 * A router row for one file.
 *
 * Day-logs are derived, never authored (see `lib/digest.ts`): there is one per day forever, so a
 * convention requiring someone to describe each of them is a convention that rots. Everything else
 * reads its description from its own frontmatter. A derived row is never stale by construction —
 * it is recomputed from the file on every render — so the staleness flag does not apply to it.
 */
export function entryFor(path: string, text: string, updated = "", stale = false): RouterEntry {
  if (isLogPath(path)) {
    const d = logDigest(text);
    return { path, description: d.description, tags: [], updated: dateFromLogPath(path), stale: false };
  }
  const fm = parseFrontmatter(text);
  return { path, description: fm.description, tags: fm.tags, updated, stale };
}

/**
 * The router table, rendered.
 *
 * Every live note gets a row. What varies with scale is how much of this table is rendered into
 * context — all of it while the corpus is small; past a few hundred notes the hot/warm
 * split governs. That split is not implemented here: this function is the complete table, and
 * bounding it is a separate decision made where the budget lives.
 *
 * Coverage is reported out loud. A router that quietly described some notes and shrugged at the rest would
 * read as complete, and the gap is the single most useful thing to know while the backfill is in
 * progress.
 */
export function buildRouter(
  files: Map<string, string>,
  meta: Map<string, { updated?: string; stale?: boolean }> = new Map()
): string {
  const groups = new Map<string, RouterEntry[]>();
  let described = 0;

  for (const [path, text] of files) {
    const m = meta.get(path);
    const entry = entryFor(path, text, m?.updated ?? "", m?.stale ?? false);
    if (entry.description) described++;
    const dir = path.includes("/") ? path.split("/")[0] : "Root";
    if (!groups.has(dir)) groups.set(dir, []);
    groups.get(dir)!.push(entry);
  }

  // Deterministic: known directories first in their canonical order, anything else alphabetically
  // after. Two calls on the same corpus must produce byte-identical output or every write commits
  // a spurious diff.
  const dirs = [
    ...ORDER.filter((d) => groups.has(d)),
    ...[...groups.keys()].filter((d) => !ORDER.includes(d)).sort(byName),
  ];

  const body = dirs
    .map((d) => {
      const rows = groups
        .get(d)!
        .slice()
        .sort((a, b) => byName(a.path, b.path))
        .map(routerLine)
        .join("\n");
      return `## ${d}\n${rows}`;
    })
    .join("\n\n");

  const coverage = `_${described} of ${files.size} notes carry a description._`;
  return `# ROUTER\n\n_Auto-generated by cortex on every write — do not edit by hand._\n${coverage}\n\n${body}`;
}
