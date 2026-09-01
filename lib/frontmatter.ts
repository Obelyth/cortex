/**
 * frontmatter — the router's raw material.
 *
 * The router is one line per note: path, a one-sentence description, tags, last-updated. The
 * description lives in the note's own YAML frontmatter rather than in a database, because the
 * brain has to stay self-describing — a bare `git clone` must carry its own routing layer with no
 * dependency on this server or on any store. Nine notes already use this shape
 * (`notes/feedback-*.md`); the rest are backfilled.
 *
 * WHY A HAND-ROLLED PARSER. The frontmatter this reads is three scalar keys and a tag list, on
 * files this server already trusts. A YAML dependency would add a parser with its own alias,
 * anchor and merge-key semantics to the load path of every write — surface area bought for
 * nothing. What is here reads the keys it knows and ignores everything else, including the nested
 * `metadata:` blocks the existing feedback notes carry.
 *
 * ABSENCE IS A NON-EVENT, and that is the load-bearing rule. On day one, 74 of 83 notes have no
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
  /**
   * The note's declared name, when it carries one — the feedback notes write
   * `name: team-review-checklist` at the top level. Nothing routes on it; it exists so the
   * inbox's mention scan (lib/inbox.ts) can recognise a note by the name its own frontmatter
   * declares, not only by its path. Absent means absent — no fallback to the filename here,
   * because a parser that invented a name would make "the note declares X" unfalsifiable.
   */
  name?: string;
  /** Lowercased, de-duplicated, order-preserved. Empty when absent. */
  tags: string[];
  /**
   * Whether this note's facts can go stale. `false` opts it out of the verification-stamp check.
   *
   * The check treats every stamped note alike, and the notes are not alike. "The old sync client
   * was removed on 2026-07-26" cannot stop being true; "backups run nightly and here is the recovery path"
   * decays the moment the machine changes. Nagging about the first teaches you to skim past the
   * second, which is the one that matters.
   *
   * Undefined means "assume it decays" — the safe default. A note only stops being watched when
   * someone says so deliberately, never by omission.
   */
  decays?: boolean;
  /**
   * ISO date the operator queued this note for the groundskeeper's re-verification, or
   * undefined when nobody has. Set by the inbox's "queue for re-verify" button; consumed —
   * removed — by the nightly run whether or not the page then checks out clean.
   *
   * The failure direction is the OPPOSITE of `decays`. A `decays` misparse silently stops a
   * note being checked, so ambiguity must land on "watched". A `reverify` misparse merely
   * fails to expedite one check — the stale-stamp finding stays in the inbox either way — so
   * anything that is not a plain date is simply not a request.
   */
  reverify?: string;
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
 * Only when BOTH ends match, so `the operator's brain` keeps its apostrophe and `'it: works'` loses its
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
  let name: string | undefined;
  let tags: string[] = [];
  let decays: boolean | undefined;
  let reverify: string | undefined;
  const lines = block.split(/\r?\n/);

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // Top-level keys only. Indented lines belong to a nested block — `metadata:` in the existing
    // feedback notes — and a `description:` nested under one is not this note's description.
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
    } else if (key === "name" && name === undefined) {
      // A plain scalar or nothing. Block scalars are not honoured here: a folded multi-line
      // "name" is not a name anyone types in prose, so treating the indicator as the value
      // (the description bug above) cannot recur — an indicator-shaped value is simply skipped.
      const v = unquote(rest);
      if (v && !/^[|>][-+]?\d*$/.test(v)) name = v;
    } else if (key === "decays" && decays === undefined) {
      // Only an explicit, unambiguous false opts a note out. Anything else -- "maybe", a typo, a
      // stray comment -- leaves it undefined and therefore watched, because the failure of a
      // loose parse here is a note that silently stops being checked.
      const v = rest.trim().toLowerCase().replace(/\s+#.*$/, "");
      if (v === "false" || v === "no" || v === "never") decays = false;
      else if (v === "true" || v === "yes") decays = true;
    } else if (key === "reverify" && reverify === undefined) {
      // A plain date or nothing. Any other value is not a request (see the interface note on
      // why this fails the opposite way from `decays`).
      const v = unquote(rest).trim();
      if (/^\d{4}-\d{2}-\d{2}$/.test(v)) reverify = v;
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

  return {
    description,
    tags,
    ...(name === undefined ? {} : { name }),
    ...(decays === undefined ? {} : { decays }),
    ...(reverify === undefined ? {} : { reverify }),
    body: after,
  };
}

/**
 * Add a description to a note that lacks one, without disturbing anything else.
 *
 * This is the one function here that WRITES note text, so it is the one that can do damage. Three
 * rules keep it safe:
 *
 *   1. It never overwrites an existing description. The nine notes that already carry one were
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

export type Temperature = "hot" | "warm" | "cold";

export interface RouterEntry {
  path: string;
  description: string;
  tags: string[];
  /** Decides how — and whether — this row renders. Absent means hot: with no scores the router
   *  behaves exactly as it did before temperatures existed. */
  temperature?: Temperature;
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
/**
 * The one byte a note may never carry: U+0000. PostgreSQL `text` cannot hold NUL and jsonb
 * refuses the \u0000 escape outright (22P05) — so a single NUL in ONE note 400s the entire
 * sync_apply batch, and because the poisoned file rides in every subsequent diff, the mirror
 * freezes at the last clean commit until a human notices. That is not hypothetical: it froze
 * the mirror AND the connections graph riding it for three hours on 2026-08-12, silently,
 * because every layer above the 400 degraded politely.
 *
 * Applied at write ingress (lib/brain.ts) so the byte never reaches git, and again at the sync
 * seam (lib/mirror.ts) so history already carrying it cannot brick the mirror. Exactly NUL and
 * nothing wider, deliberately: the verifier proves quotes against note bytes, so every byte the
 * store CAN hold must survive the trip untouched — this is not safeText, which is a one-line
 * SURFACE discipline and would flatten the note's newlines.
 */
export function storableText(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\u0000/g, "");
}

export function safeText(s: string, max: number): string {
  const clean = s
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001F\u007F\u2028\u2029]/g, " ")
    .replace(/·/g, "-")
    .replace(/\s+/g, " ")
    .trim();
  return clean.length <= max ? clean : `${clean.slice(0, max - 1)}…`;
}

/** Warm rows carry a shortened description and drop their tags — presence at a fraction of the
 *  cost. The full description is one brain_read away, and cold rows are not rendered at all. */
const WARM_DESCRIPTION = 90;

export function routerLine(e: RouterEntry): string {
  const warm = e.temperature === "warm";
  const description = safeText(e.description, warm ? WARM_DESCRIPTION : MAX_DESCRIPTION);
  if (!description) return `- ${e.path} · (no description yet)`;
  const parts = [e.path, description];
  if (!warm && e.tags.length) {
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
 * The seat, decided: which rows render into the always-loaded router, which the budget refused,
 * and which never entered because they are cold.
 *
 * Extracted from buildRouter so the heat view can mark "in the seat" from the SAME walk the boot
 * call pays — a second derivation of seat membership would drift from the router the day either
 * changed, and a console whose "in the seat" disagrees with what boot actually loads is the
 * silent-loss failure wearing a visualisation.
 */
export interface RouterCut {
  /** Rows that render — hot before warm before unscored, byName within each band. */
  rendered: RouterEntry[];
  /** Hot/warm rows the byte budget refused. Reachable, counted, not rendered. */
  dropped: RouterEntry[];
  /** Rows not rendered because their temperature is cold. Reachable by search or exact path. */
  cold: RouterEntry[];
  described: number;
  /** Bytes the rendered rows cost — one routerLine plus its newline each. */
  bytes: number;
  /** How many files the walk saw — renderRouterDoc's coverage line needs the denominator. */
  total: number;
}

export function routerCut(
  files: Map<string, string>,
  meta: Map<string, { updated?: string; stale?: boolean; temperature?: Temperature }> = new Map(),
  budgetBytes = Infinity
): RouterCut {
  const kept: RouterEntry[] = [];
  const cold: RouterEntry[] = [];
  let described = 0;

  for (const [path, text] of files) {
    const m = meta.get(path);
    const entry = entryFor(path, text, m?.updated ?? "", m?.stale ?? false);
    entry.temperature = m?.temperature;
    if (entry.description) described++;
    // COLD IS NOT GONE — it is not RENDERED. Every live note keeps a router row; the
    // always-loaded slice is hot + warm, and cold is reachable by search, tag, prefix or exact
    // path. Rendering everything is what fails at a thousand notes.
    if (entry.temperature === "cold") {
      cold.push(entry);
      continue;
    }
    kept.push(entry);
  }

  // Hot before warm before unscored, and byName inside each band so two calls on one corpus
  // still produce byte-identical output. The walk CONTINUES past an oversized row rather than
  // breaking, so one enormous description cannot hide every shorter row behind it.
  const rank = (t?: Temperature) => (t === "hot" ? 0 : t === "warm" ? 1 : 2);
  const sorted = kept
    .slice()
    .sort((a, b) => rank(a.temperature) - rank(b.temperature) || byName(a.path, b.path));

  const walk = (rowBudget: number) => {
    const rendered: RouterEntry[] = [];
    const dropped: RouterEntry[] = [];
    let bytes = 0;
    for (const entry of sorted) {
      const len = routerLine(entry).length + 1;
      if (bytes > 0 && bytes + len > rowBudget) {
        dropped.push(entry);
        continue;
      }
      bytes += len;
      rendered.push(entry);
    }
    return { rendered, dropped, bytes };
  };

  let rowBudget = budgetBytes;
  let cut = walk(rowBudget);
  // THE BUDGET IS THE DOCUMENT'S, NOT THE ROWS'. The walk above counts row bytes only, but what
  // the boot call actually spends is renderRouterDoc's output — rows PLUS the header, the
  // coverage line, the cold/dropped notes and one `## <dir>` heading per group. That wrapper was
  // unaccounted for, so the "budget" quietly ran ~121 bytes over on the live corpus (measured
  // 2026-08-17) and drifted with the shape of the corpus rather than staying where it was
  // written. So: render the candidate, and if the document overshoots, tighten the row budget by
  // exactly the overshoot and re-walk. Convergence is fast — dropping rows shrinks the document
  // faster than the dropped-note line grows — and the loop is bounded anyway. Measuring by
  // rendering, rather than by a parallel arithmetic model of the wrapper, means the two cannot
  // disagree: buildRouter returns the very string this loop measured.
  if (Number.isFinite(budgetBytes)) {
    // Every pass either fits, drops at least one row, or hits the one-row floor — so the walk
    // count bounds the iterations and the loop cannot spin.
    for (let i = 0; i <= sorted.length; i++) {
      const doc = renderRouterDoc({ ...cut, cold, described, total: files.size });
      if (doc.length <= budgetBytes) break;
      rowBudget -= doc.length - budgetBytes;
      let next = walk(rowBudget);
      if (next.rendered.length === cut.rendered.length) {
        // Tightening by the overshoot did not force a drop — the overshoot was smaller than the
        // next row, so the same rows still fit the tighter row budget and the document is still
        // over. Force progress by cutting below what the current rows cost, unless we are already
        // at the floor: when even ONE row plus the wrapper exceeds the budget, that row renders
        // anyway — an empty router hides everything — and the overshoot is the sanctioned kind.
        if (cut.rendered.length <= 1) break;
        rowBudget = cut.bytes - 1;
        next = walk(rowBudget);
        if (next.rendered.length === cut.rendered.length) break;
      }
      cut = next;
    }
  }

  return { ...cut, cold, described, total: files.size };
}

/**
 * The router table, rendered.
 *
 * Every live note gets a row. What varies with scale is how much of this table is rendered into
 * context — today all of it, since 83 notes is ~2.5k tokens; past a few hundred the hot/warm
 * split governs. The split itself lives in routerCut above; this function is the render.
 *
 * Coverage is reported out loud. A router that quietly described 9 notes and shrugged at 74 would
 * read as complete, and the gap is the single most useful thing to know while the backfill is in
 * progress.
 */
export function buildRouter(
  files: Map<string, string>,
  meta: Map<string, { updated?: string; stale?: boolean; temperature?: Temperature }> = new Map(),
  /**
   * Bytes of router the caller will spend. Unbounded by default so non-boot callers and tests
   * keep their old behaviour.
   *
   * THE ROUTER WAS THE ONE UNBOUNDED TIER on the boot path — profile has none, RECENT has 8k,
   * the bubble 6k, brain_corpus 100k, and this had nothing. Temperature was doing the bounding
   * implicitly, which is fine until it is not: mirror.ts degrades a scores() failure to "treat
   * every note as hot", so a Supabase hiccup made every row render and the reply's own
   * "N notes routed" line reported it as normal. A budget that only exists when a telemetry
   * table answers is not a budget.
   */
  budgetBytes = Infinity
): string {
  // buildRouter IS renderRouterDoc(routerCut(...)) — nothing more. routerCut fits the DOCUMENT
  // to the budget by rendering candidates through the same function, so the string returned here
  // is the exact string the budget was enforced against. A separate assembly in this function is
  // how the wrapper bytes went unaccounted for in the first place.
  return renderRouterDoc(routerCut(files, meta, budgetBytes));
}

/**
 * The router document for a decided cut. The ONLY assembly of the router — routerCut measures
 * candidates through this exact function, so what the budget admits and what the caller receives
 * cannot disagree.
 */
export function renderRouterDoc(cut: RouterCut): string {
  const { described, total } = cut;
  const cold = cut.cold.length;
  const dropped = cut.dropped.length;

  const groups = new Map<string, RouterEntry[]>();
  for (const entry of cut.rendered) {
    const dir = entry.path.includes("/") ? entry.path.split("/")[0] : "Root";
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

  const coverage = `_${described} of ${total} notes carry a description._`;
  // A count with no way to act on it is an anxiety, not information.
  const coldNote = cold
    ? `\n_${cold} colder note${cold === 1 ? "" : "s"} not listed here — reach them with brain_corpus (question or paths) or brain_ask._`
    : "";
  // Stated, not silent. A truncated router that said nothing would let a reader conclude the
  // brain holds only what it can see — the same silent-loss shape select.ts's cursor prevents.
  const droppedNote = dropped
    ? `\n_${dropped} further note${dropped === 1 ? "" : "s"} did not fit this router's budget — reach them with brain_corpus (question or paths) or brain_ask._`
    : "";
  return `# ROUTER\n\n_Auto-generated by cortex on every write — do not edit by hand._\n${coverage}${coldNote}${droppedNote}\n\n${body}`;
}

/**
 * Write `decays: false` into a note's frontmatter — the operator saying "this records something
 * that happened, not something that is true right now."
 *
 * Idempotent, and it never touches the body. A note's text is what citations are proven against,
 * so a function that stops the inbox nagging does not get to alter the thing being cited.
 */
export function applyDecays(text: string, decays: boolean): string {
  const existing = parseFrontmatter(text);
  if (existing.decays === decays) return text;

  const line = `decays: ${decays}`;

  // No frontmatter at all: open a block. The body follows verbatim.
  if (existing.body === text) return `---\n${line}\n---\n\n${text}`;

  // Present but set the other way: rewrite that key in place rather than adding a second one,
  // because a block carrying both `decays: true` and `decays: false` is read by the parser as the
  // first one and by a human as the last.
  if (existing.decays !== undefined) {
    return text.replace(/^decays[ \t]*:[ \t]*.*$/m, line);
  }

  // Splice after the opening fence, leaving every existing key's order and indentation alone.
  const open = text.indexOf("\n") + 1;
  return `${text.slice(0, open)}${line}\n${text.slice(open)}`;
}

/**
 * Write `reverify: <date>` into a note's frontmatter — the operator asking the groundskeeper to
 * put this page at the front of tonight's fact-check queue.
 *
 * Same discipline as applyDecays: idempotent, never touches the body. A note already carrying a
 * valid request keeps its ORIGINAL date — the marker records when the operator first asked, and
 * a second click must not quietly reset a request the nightly run may already be overdue on.
 * A malformed value (which the parser reads as "no request") is rewritten in place, because a
 * block carrying both a broken `reverify:` and a fresh one would be read two different ways.
 */
export function applyReverify(text: string, date: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    throw new Error(`applyReverify: not a plain date: ${JSON.stringify(date)}`);
  }
  const existing = parseFrontmatter(text);
  if (existing.reverify !== undefined) return text;

  const line = `reverify: ${date}`;

  // No frontmatter at all: open a block. The body follows verbatim.
  if (existing.body === text) return `---\n${line}\n---\n\n${text}`;

  // A key the parser rejected is still a key on the page: rewrite it rather than adding a twin.
  if (/^reverify[ \t]*:/m.test(text)) {
    return text.replace(/^reverify[ \t]*:[ \t]*.*$/m, line);
  }

  // Splice after the opening fence, leaving every existing key's order and indentation alone.
  const open = text.indexOf("\n") + 1;
  return `${text.slice(0, open)}${line}\n${text.slice(open)}`;
}
