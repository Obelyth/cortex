/**
 * inbox — the three mechanical watch checks (learning-layer spec 2026-08-11, layer 2,
 * "Inbox watch items, mechanical only").
 *
 * Everything here is deterministic and model-free: an item is a templated one-liner naming a
 * mechanical fact about the corpus, with the evidence that proves it. Nothing writes to a note,
 * nothing pushes — these items ride the existing pull-only attention queue and obey its one law:
 * they are re-derived on every render and leave ONLY because the corpus (or the derived edge
 * they cite) stopped saying the thing. There is no dismiss, no ignore-list, no state.
 *
 * THE ONE OPT-OUT, and why it is not a dismiss (2026-08-17). A note carrying `decays: false` is
 * out of every check here. That flag already meant "this note records something that happened
 * rather than something that is true now" and already excused it from the stale-stamp check;
 * it now excuses it from these three as well, because the same reasoning covers them. A retired
 * project page does not need its dead links repointed, its co-read pairs written down, or its
 * correction chains collapsed — it is a record of a thing that is over. Live 2026-08-17: three
 * projects were retired in one evening and their pages went on generating watch items about
 * work nobody will ever do.
 *
 * It is still not a dismiss, and the difference is the whole point. A dismiss clears a row and
 * changes nothing; `decays: false` is a claim the operator writes INTO the corpus, in the note,
 * as a commit, portable to a fresh clone — and it is falsifiable, because anyone reading the
 * note can see the note asserting it and disagree. What it does NOT touch is the two findings
 * that are about danger rather than freshness: a credential-shaped line and an unmarked
 * retired-tool claim keep firing on a settled page, because "this is history" does not make a
 * stored secret safe or an unmarked claim safe to quote.
 *
 * PRECISION OVER RECALL, measured before shipping. This queue's history is 23 checker-noise
 * items burying the 1 real one (log/2026-08-03, PR #34) — an alert that fires on healthy text
 * stops being read. So every rule here was run against the live corpus first and tightened until
 * the queue held a handful of true items, and each exclusion below names the real passage that
 * demanded it. All three checks are `watch` severity, a tier below warn: structure worth a
 * glance, never an alarm.
 *
 * WHO RUNS: the superseded-link and correction-chain checks are pure corpus derivations and
 * always run. The co-read check alone needs the store, because coaccess is the one edge kind
 * whose raw material (note_access) never leaves Postgres — with the store off, missing, or
 * unwell, that check goes silently absent rather than inventing an answer.
 */
import { loadCorpus } from "./corpus";
import { splitBlocks, retraction } from "./verify";
import { parseFrontmatter, byName } from "./frontmatter";
import { DATED_ENTRY, DATED_HEADING, type TriageItem } from "./health";
import { COACCESS_FLOOR, effectiveLearning, type EffectiveLearning } from "./learning";
import {
  WIKILINK,
  resolveRef,
  linkEdges,
  correctionEdges,
  coaccessEdges,
  scrubEvidence,
  type EdgeRow,
} from "./edges";

// The floor's measured rationale and its value live with the knob registry now (lib/learning.ts,
// where the console's stepper gets its default) — re-exported here because this module's callers
// and tests rightly think of it as the co-read check's own constant.
export { COACCESS_FLOOR };

/**
 * A note is "superseded" when its own frontmatter description LEADS with the word — the house
 * norm since the description backfill (brain d39d7a2), which deliberately put SUPERSEDED first
 * so a reader is warned before opening a dead page; two live notes carry it today. Leading, not
 * merely containing: prose descriptions mention the word mid-sentence about OTHER things
 * ("…stamps quotes VERIFIED/SUPERSEDED…"), and a check that flagged links to those would fire
 * on healthy text.
 */
const SUPERSEDED_DESC = /^\s*\**SUPERSEDED\b/;

/** Which notes carry the marker, in one pass — both checks below key on this set. */
export function supersededNotes(files: Map<string, string>): Set<string> {
  const out = new Set<string>();
  for (const [path, text] of files) {
    if (SUPERSEDED_DESC.test(parseFrontmatter(text).description)) out.add(path);
  }
  return out;
}

/**
 * The spans of `(was: …)` parentheticals inside one block, by character offset.
 *
 * verify.ts's WAS_RE keys on `was:` followed by a QUOTE, because that is what the retraction
 * classifier needs — but the corpus also writes the loose form: `(was: this page used to cover
 * <the retired product> here instead — …; see <its retired page>.)`, live today in the design
 * brand note. A reference inside either form is the note explaining what it USED to say; flagging it asks
 * the operator to falsify his own correction. This finds the span so the reference scan can
 * skip it — a positional test, not a retraction opinion, so it does not touch verify.ts's
 * machinery. An unclosed parenthetical runs to the end of the block: the safe direction here is
 * exclusion, because a missed item costs a glance and a false one costs the queue its credibility.
 */
export function wasSpans(text: string): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  const opener = /\(\s*was:/gi;
  for (const m of text.matchAll(opener)) {
    let depth = 1;
    let i = m.index + m[0].length;
    while (i < text.length && depth > 0) {
      if (text[i] === "(") depth++;
      else if (text[i] === ")") depth--;
      i++;
    }
    out.push([m.index, i]);
  }
  return out;
}

const inSpan = (spans: Array<[number, number]>, at: number) =>
  spans.some(([a, b]) => at >= a && at < b);

/** Evidence is note-derived text on its way to the console — same egress rule as every other
 *  surface: redacted, control-stripped and bounded before it leaves this module, by the same
 *  one scrubber the graph uses. */
const ev = scrubEvidence;

/**
 * Check 1 — a note's LIVE text still points a reader at a superseded page.
 *
 * Fires when text that verify.ts would stamp VERIFIED carries a [[link]] or a path reference to
 * a note whose description marks it SUPERSEDED. Leaves when the reference is removed or marked,
 * or the target stops being superseded.
 *
 * What does NOT fire, each exclusion carrying the live passage that demanded it:
 *   - banner-retired blocks, per verify.ts's retraction() — reused, not reimplemented — the
 *     main project page's backfill record names both superseded pages while recording the
 *     backfill that marked them; the passage is history about the marking, not a live pointer.
 *     "banner" specifically, NOT "correction": a block carrying `<current claim> (was: "<old>")`
 *     is the freshest text in the note, and a live reference standing beside its own correction
 *     marker is exactly the kind of pointer this check exists to catch.
 *   - `(was: …)` parentheticals, quoted or loose — the design brand note explains which retired
 *     page it used to cover and points there: the note explaining its own past.
 *   - dated log entries and dated headings (health.ts's doctrine, same constants) — a log entry
 *     pointed at a retired project page the night it closed an item there; a diary was true
 *     when written.
 *   - notes that are themselves superseded: history pointing at history misleads nobody who
 *     got past the description.
 *
 * Measured on the live corpus 2026-08-11: three raw candidates, all three excluded by the rules
 * above, zero items surfaced. Quiet is the correct state for a well-kept corpus, and the check
 * stands guard for the next unmarked pointer rather than manufacturing work today.
 */
export function supersededLinkItems(files: Map<string, string>): TriageItem[] {
  const dead = supersededNotes(files);
  if (dead.size === 0) return [];
  // One boundary-guarded pattern per superseded path, so "archive/<the same path>" (a
  // different, non-live path) can never count as a reference to the live note.
  const pathRes = [...dead].map((p) => ({
    path: p,
    re: new RegExp(`(?<![\\w/-])${p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\w])`, "g"),
  }));

  const items: TriageItem[] = [];
  for (const [src, text] of [...files.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    if (dead.has(src) || DATED_ENTRY.test(src)) continue;
    const blocks = splitBlocks(text);
    // First live site per target, plus a count — one item per (src, target), because five rows
    // for five mentions of the same dead page is how a queue turns into noise.
    const sites = new Map<string, { line: number; text: string; n: number }>();
    for (let i = 0; i < blocks.length; i++) {
      const b = blocks[i];
      if (retraction(blocks, i) === "banner" || DATED_HEADING.test(b.heading)) continue;
      const spans = wasSpans(b.text);
      const found: Array<{ dst: string; at: number }> = [];
      // The [[link]] spans, recorded as they are scanned so the bare-path pass below cannot
      // double-count a reference written as a FULL-path wiki-link: `[[notes/dead.md]]` is one
      // reference, caught here by resolveRef, and the literal path inside the brackets is
      // boundary-clean (`[` before, `]` after), so the pathRes scan would otherwise match it a
      // second time and print "(+1 more)" for a single mention.
      const wiki: Array<[number, number]> = [];
      for (const m of b.text.matchAll(WIKILINK)) {
        wiki.push([m.index, m.index + m[0].length]);
        const dst = resolveRef(m[1], files);
        if (dst && dst !== src && dead.has(dst)) found.push({ dst, at: m.index });
      }
      for (const { path, re } of pathRes) {
        if (path === src) continue;
        for (const m of b.text.matchAll(re)) {
          if (inSpan(wiki, m.index)) continue;
          found.push({ dst: path, at: m.index });
        }
      }
      // Earliest occurrence first, whichever pass found it — the per-target dedup below keeps the
      // FIRST site (header line 155), and "first" must mean first in the text, not first by match
      // KIND. Left as match order, a bare path on line 3 lost its slot to a [[link]] on line 4 in
      // the same merged block, and the item pointed a reader at the wrong line.
      found.sort((x, y) => x.at - y.at);
      for (const { dst, at } of found) {
        if (inSpan(spans, at)) continue;
        const offset = b.text.slice(0, at).split("\n").length - 1;
        const line = b.line + offset;
        const s = sites.get(dst);
        if (s) s.n++;
        else sites.set(dst, { line, text: b.text.split("\n")[offset].trim(), n: 1 });
      }
    }
    for (const [dst, s] of [...sites.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
      items.push({
        sev: "watch",
        kind: "superseded-link",
        title: "Live link to a superseded note",
        loc: `${src}:${s.line}`,
        evidence: ev(
          `L${s.line}: ${s.text}` +
            (s.n > 1 ? ` (+${s.n - 1} more)` : "") +
            ` — ${dst}'s own description opens with SUPERSEDED.`
        ),
        why: "A reader following this reference lands on a page whose first line tells them not to trust it.",
        action: `Point the reference at the current page, or mark the passage. The item leaves when this note stops referencing ${dst} live, or when ${dst} stops being superseded.`,
      });
    }
  }
  return items;
}

/** How many of a note's co-access partners count as "prominent" for the coaccess-gap check —
 *  the mutual-top-K gate below. Not a console knob: the floor is the volume dial and one dial
 *  is enough; this constant is the check's definition of specificity, asserted by tests. */
export const COACCESS_TOP_K = 3;

/**
 * Check 2 — two notes that sessions keep reading together, and neither names the other.
 *
 * The coaccess weight comes from the store (windows counted in Postgres); whether the pair is
 * NAMED is answered by the live corpus, so adding the link — or the mention — clears the item on
 * the next render rather than after the nightly rebuild. "Named" means either note carries the
 * other in any house form: a [[wiki-link]], the bare path in prose, or the other note's plain
 * name in live prose — because the item's whole ask is "write the connection down", and every
 * one of those forms is it written down.
 *
 * RAW WEIGHT CANNOT TELL AFFINITY FROM POPULARITY, and here is the measurement that taught it
 * (live note_edges, 2026-08-11): sixteen unlinked pairs stood at the floor, and every single one
 * involved a hub — the main project page with 48 co-access partners after one marathon session,
 * a workstation page with 38, day-logs co-read in bulk by groundskeeper absorb runs, the
 * boot profile polluted by reconcile-trigger reads. Three mechanical filters follow, each doing
 * one job:
 *
 *   1. DIARY ENDPOINTS ARE OUT. Day-logs and profile.md cannot be endpoints of this item — the
 *      same diary doctrine check 1 applies via the same DATED_ENTRY constant: a dated record
 *      does not need forward links, and the boot file rides every seat, so a link in or out of
 *      either adds no discoverability. They are outside the check's universe entirely — dropped
 *      BEFORE the rankings below, because an edge that can never surface must not crowd a real
 *      candidate out of a note's top-K either (bulk absorb runs co-read every day-log; letting
 *      those edges rank would re-import the popularity noise this filter exists to remove).
 *   2. A PROSE MENTION COUNTS AS NAMING. The item's premise is "no reader can follow it" — and
 *      that premise was FALSE for pairs like a setup page ↔ the server's own page, where the
 *      prose names the other note without brackets. So before a pair surfaces, each side's LIVE
 *      text (check 1's machinery, reused: banner-retracted blocks dropped, `(was: …)` spans
 *      blanked) is scanned for the other's name — its slug, its filename base, or its
 *      frontmatter `name:`. Dated sections stay IN this scan, unlike check 1's: the mention
 *      filter asks "is there a trail on the page", not "is the claim current", and a dated
 *      section still sits on the page where a reader can follow it.
 *   3. MUTUAL TOP-K, K=3. The pair surfaces only when each note is among the other's top-3
 *      co-access partners by weight — the same hub-gating instinct the correction-chain check
 *      below already earned the hard way (its loose shape fired 14×, 13 of them hub noise).
 *      A hub is top-of-list for many notes; almost none of them are top-of-list for the hub,
 *      so requiring the prominence to be MUTUAL is what separates a genuine working pair from
 *      one page that happens to touch everything. Rank ties at the boundary cut alphabetically —
 *      arbitrary but deterministic, and the cost of the cut is a missed glance, not a false
 *      alarm: the same safe direction wasSpans() chose for its unclosed parenthetical.
 *
 * `floor` defaults to the measured value and is a console knob (lib/learning.ts). Its meaning
 * is untouched by the filters: the minimum shared windows before a pair is even a candidate,
 * applied BEFORE the mutual-top-K ranking — raising it still quiets the check, lowering it
 * still admits the 2-window coincidences the default exists to hold back.
 *
 * Leaves when either note gains the link or the mention, or when the pair stops being mutually
 * prominent on a rebuild — the edge decays below the floor, or either side falls out of the
 * other's top-K.
 */
export function coaccessGapItems(
  files: Map<string, string>,
  coaccess: EdgeRow[],
  floor = COACCESS_FLOOR
): TriageItem[] {
  // NUL-joined pair keys, same as edges.ts's own maps: the one byte no path can contain.
  const linked = new Set(linkEdges(files).map((l) => `${l.src}\0${l.dst}`));
  const references = (a: string, b: string) =>
    linked.has(`${a}\0${b}`) ||
    // The bare-path form, boundary-guarded like check 1 so an archive/ path cannot count.
    new RegExp(`(?<![\\w/-])${b.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\w])`).test(files.get(a) ?? "");

  // Filter 1 — the diary doctrine, on both columns (see the header). DATED_ENTRY is health.ts's
  // constant, the same one check 1 keys on: one definition of "a dated record".
  const diary = (p: string) => DATED_ENTRY.test(p) || p === "profile.md";

  // Filter 2's raw material — each note's live text, computed once per note per render: a note
  // on a hub's partner list is scanned against many partners, and re-splitting it per pair
  // would pay the block walk quadratically for no new answer.
  const liveCache = new Map<string, string>();
  const liveText = (path: string): string => {
    const hit = liveCache.get(path);
    if (hit !== undefined) return hit;
    const blocks = splitBlocks(files.get(path) ?? "");
    const kept: string[] = [];
    for (let i = 0; i < blocks.length; i++) {
      if (retraction(blocks, i) === "banner") continue;
      let t = blocks[i].text;
      // Blanked, not spliced: cutting a span out would fuse its two shores into a token no
      // reader ever saw, and a manufactured match here silently buries a real item.
      for (const [a, b] of wasSpans(t)) t = t.slice(0, a) + " ".repeat(b - a) + t.slice(b);
      kept.push(t);
    }
    const joined = kept.join("\n");
    liveCache.set(path, joined);
    return joined;
  };

  // The names a note answers to in prose: its slug (path minus .md), its filename base, and its
  // declared frontmatter name when it carries one. Boundary-guarded like the path form — a name
  // inside a longer hyphenated token ("cortex" in "cortex-lite-tools") is a different
  // identifier, not a mention — and case-insensitive, because prose capitalises.
  const nameCache = new Map<string, RegExp[]>();
  const namesOf = (path: string): RegExp[] => {
    const hit = nameCache.get(path);
    if (hit) return hit;
    const slug = path.replace(/\.md$/, "");
    const base = slug.split("/").pop()!;
    const declared = parseFrontmatter(files.get(path) ?? "").name?.trim();
    const res = [...new Set([slug, base, ...(declared ? [declared] : [])])].map(
      (n) => new RegExp(`(?<![\\w/-])${n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\w-])`, "i")
    );
    nameCache.set(path, res);
    return res;
  };
  const mentions = (a: string, b: string) => {
    const text = liveText(a);
    return namesOf(b).some((re) => re.test(text));
  };

  // The check's universe: floor-passing coaccess rows between live, non-diary notes. The floor
  // applies HERE, before the rankings — its knob means "minimum shared windows", and it must
  // keep meaning that whether or not a pair later survives the specificity gate. (Access
  // history outlives deletions; an item about a note the corpus no longer holds would 404 from
  // its own "open the note" link.)
  const rows = coaccess.filter(
    (e) =>
      e.kind === "coaccess" &&
      e.weight >= floor &&
      files.has(e.src) &&
      files.has(e.dst) &&
      !diary(e.src) &&
      !diary(e.dst)
  );

  // Filter 3's rankings — every surviving note's partners, heaviest first, byName as the
  // deterministic tiebreak. coaccess is stored once per pair (src < dst), so both directions
  // are added here or half the graph would rank against an empty list.
  const partners = new Map<string, Array<{ other: string; weight: number }>>();
  const add = (note: string, other: string, weight: number) => {
    if (!partners.has(note)) partners.set(note, []);
    partners.get(note)!.push({ other, weight });
  };
  for (const e of rows) {
    add(e.src, e.dst, e.weight);
    add(e.dst, e.src, e.weight);
  }
  const prominent = new Map<string, Set<string>>();
  for (const [note, list] of partners) {
    list.sort((a, b) => b.weight - a.weight || byName(a.other, b.other));
    prominent.set(note, new Set(list.slice(0, COACCESS_TOP_K).map((p) => p.other)));
  }

  const items: TriageItem[] = [];
  for (const e of rows) {
    if (!prominent.get(e.src)!.has(e.dst) || !prominent.get(e.dst)!.has(e.src)) continue;
    if (references(e.src, e.dst) || references(e.dst, e.src)) continue;
    if (mentions(e.src, e.dst) || mentions(e.dst, e.src)) continue;
    items.push({
      sev: "watch",
      kind: "coaccess-gap",
      title: "Co-read pair with no link",
      loc: `${e.src} ↔ ${e.dst}`,
      evidence: ev(e.evidence),
      why: "Sessions keep reading these two together — each sits among the other's closest co-read partners — yet neither page names the other: no [[link]], no path, no mention of the other's name in live prose. The connection exists only in the access log, where no reader can follow it.",
      action: `If the connection is real, add a [[link]] — or name the page in prose — in either note. The item leaves when either page names the other, or when the pair stops being mutually prominent: the edge decays below ${floor} shared windows on rebuild, or either note falls out of the other's top-${COACCESS_TOP_K} co-read partners.`,
    });
  }
  // The fetch is weight-ordered already, but this module promises determinism on its own.
  return items.sort(
    (a, b) => (a.loc < b.loc ? -1 : a.loc > b.loc ? 1 : 0)
  );
}

/**
 * Check 3 — a correction chain that CLOSES across two notes: A's correcting block names B, and
 * B's correcting block names A, so a reader of either page gets a correction the other page has
 * since re-corrected. Both line references ride as evidence. Leaves when the chain is collapsed
 * in place — when either side stops carrying a correction that names the other.
 *
 * DELIBERATELY GATED to mutual pairs, and here is the measurement that gated it: the loose
 * shape from the spec — any correction edge whose source is itself the target of another —
 * fired 14 times on the live corpus (2026-08-11), and 13 were hub-page noise: the main project
 * page's housekeeping blocks name a dozen pages, so every correction ANYWHERE that mentioned
 * that page chained through it. The one chain a reader could actually be misled by was the
 * mutual pair — a query-label story corrected twice, recorded on two pages, each page deferring
 * to the other. Requiring the chain to close keeps that item and drops the thirteen.
 * Corrections are derived live via correctionEdges() — the same single opinion the graph
 * rebuild stores — so this check runs without the store and the item leaves the moment the
 * note changes, not a rebuild later.
 *
 * DIARY ENDPOINTS ARE OUT, the same doctrine checks 1 and 2 already apply (via DATED_ENTRY).
 * correctionEdges scans every file, day-logs included, and PATH_IN_TEXT matches `log/*.md`
 * targets — so a mutual chain between a day-log and a live page would surface. It cannot be
 * acted on: 'log/' sorts before 'notes/' and 'projects/', so the day-log is always the pair's
 * first path, which is the only end the console's lone "settled" button targets — and the verify
 * route refuses every dated path (there is nothing on a diary to check, settle or queue). An item
 * whose sole action always 400s is exactly the "one opinion of the diary doctrine" this queue
 * promises, so the dated endpoint is dropped before it can pair, here rather than at the surface.
 */
export function correctionChainItems(files: Map<string, string>): TriageItem[] {
  const edges = correctionEdges(files).filter(
    (e) => !DATED_ENTRY.test(e.src) && !DATED_ENTRY.test(e.dst)
  );
  // NUL-joined pair keys, same as edges.ts's own maps: the one byte no path can contain.
  const byPair = new Map<string, EdgeRow>();
  for (const e of edges) byPair.set(`${e.src}\0${e.dst}`, e);

  // Each side's evidence arrives as "L<n>: <the correcting text>" from correctionEdges. Capped
  // per SIDE, not just in total, because both line references are the check's contract — one
  // long first block must not push the second reference past the evidence bound.
  const side = (path: string, evidence: string) => {
    const s = `${path} ${evidence}`;
    return s.length > 97 ? `${s.slice(0, 96)}…` : s;
  };

  const items: TriageItem[] = [];
  for (const e of edges) {
    // Once per pair: the (a, b) ordering with a < b is the canonical row, its mirror is skipped.
    if (e.src > e.dst) continue;
    const back = byPair.get(`${e.dst}\0${e.src}`);
    if (!back) continue;
    items.push({
      sev: "watch",
      kind: "correction-chain",
      title: "Correction chain crossing notes",
      loc: `${e.src} ↔ ${e.dst}`,
      evidence: ev(`${side(e.src, e.evidence)} · ${side(e.dst, back.evidence)}`),
      why: "Each page's correction names the other, so a reader of either one is reading a correction the other page has since re-corrected — the current truth lives in neither place alone.",
      action: "Collapse the chain in place: fold the story into one page and leave the other's marker pointing at it. The item leaves when the two pages stop correcting each other.",
    });
  }
  return items.sort((a, b) => (a.loc < b.loc ? -1 : a.loc > b.loc ? 1 : 0));
}

/**
 * The assembled watch list, in spec order. Pure corpus first; the store-backed check joins only
 * when the store answers. Callers on the console path wrap this in cache() and a catch — a
 * derived watch list must never be the reason a console screen fails to render.
 *
 * Each check runs only while its Learning switch is on (default: all on, today's behaviour).
 * An OFF check contributes zero items, so the inbox count and the badge reflect the switch on
 * the very next render — there is no cache of the queue to go stale. The coaccess store read is
 * skipped entirely when its check is off: no reason to pay a Postgres round-trip for items that
 * would be discarded.
 */
export async function watchItems(
  corpus?: { files: Map<string, string> },
  learning?: EffectiveLearning
): Promise<TriageItem[]> {
  const eff = learning ?? (await effectiveLearning());
  const { files } = corpus ?? (await loadCorpus());
  const items: TriageItem[] = [];
  if (eff.watchSupersededLink) items.push(...supersededLinkItems(files));
  if (eff.watchCoaccessGap) {
    const co = await coaccessEdges();
    if (co) items.push(...coaccessGapItems(files, co, eff.coaccessFloor));
  }
  if (eff.watchCorrectionChain) items.push(...correctionChainItems(files));
  return items.filter((i) => !onSettledNote(i.loc, files));
}

/**
 * Is this item's subject a note the operator has marked settled history?
 *
 * Filtered HERE rather than inside the three checks so the opt-out has exactly one definition —
 * three copies of "is this note settled" is the drift this module's header spends a paragraph
 * refusing. The checks stay pure functions of the corpus, which is also what keeps their tests
 * able to state a rule without knowing about frontmatter.
 *
 * EITHER side settles a pair. The co-read and correction-chain items are about two notes, and
 * their ask is "write the connection down" — an ask that is moot the moment one end is a record
 * of something finished. Requiring both would leave a retired page tethered to every live note
 * it was ever read beside.
 */
function onSettledNote(loc: string, files: Map<string, string>): boolean {
  const pair = loc.indexOf(" ↔ ");
  const paths =
    pair > 0
      ? [loc.slice(0, pair), loc.slice(pair + 3)]
      : [loc.replace(/:\d+$/, "")];
  return paths.some((p) => {
    const text = files.get(p);
    return text !== undefined && parseFrontmatter(text).decays === false;
  });
}
