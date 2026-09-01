/**
 * health — what the brain looks like right now, computed from the live corpus.
 *
 * Deliberately reuses splitBlocks() and retracted() from verify.ts rather than reimplementing
 * them. A console that computed its own idea of "retracted" would be a third opinion on the
 * corpus, and two opinions disagreeing is the exact drift Stage 5 spent a day deleting. If the
 * page and the answer ever disagree about a passage, that is a bug in one file, not two.
 */
import { loadCorpus } from "./corpus";
import { splitBlocks, retracted, normalise } from "./verify";
import { hasSecret, redact } from "./redact";
import { parseFrontmatter } from "./frontmatter";

/**
 * A note's own claim about its freshness. Cold stamps are how a brain rots quietly.
 *
 * Global, and read from the END, because a brain page is an append-only build log: each dated
 * section carries the stamp it was verified under, and the page's CURRENT claim is the last one.
 * Reading the first match asked "when was the OLDEST section of this page checked?" and answered
 * a question nobody had. Measured 2026-08-17: two long project pages sat in the inbox reading 16
 * days stale off an early section stamp while each carried a stamp five days old at its foot, and
 * both had been reported that way every night for a fortnight. Every page that keeps per-section
 * stamps was permanently flagged — the failure mode where a real finding hides among rows you
 * have learned mean nothing.
 *
 * Positional-last, deliberately NOT max-by-date: the newest stamp anywhere on a page would let
 * one freshly-checked section vouch for the whole page, and a wrong answer here has to land on
 * "watched" — the same failure direction `decays` is parsed with. It is also the groundskeeper's
 * own written convention read back: its rule is that a page ENDS with `_Facts last verified
 * <today>._`, so the last stamp in document order IS the page's claim by construction.
 */
const STAMP = /(_Facts last verified\s+)(\d{4}-\d{2}-\d{2})/gi;

/**
 * The page's current freshness claim: its LAST stamp, or null if it makes none.
 *
 * Exported so the console's "I re-checked it" button rewrites the same stamp this check reads.
 * Two definitions of "the page's stamp" is how the console would come to disagree with its own
 * inbox — the console stamping the first one while the queue read the last would clear nothing
 * and look broken.
 */
export function lastVerified(text: string): string | null {
  let out: string | null = null;
  for (const m of text.matchAll(STAMP)) out = m[2];
  return out;
}

/**
 * Move the page's current stamp to `date`, or null when the page makes no claim to move.
 *
 * ONE regex for the read and the write, which is the fix as much as "last, not first" is. The
 * console's write path used to carry its own narrower pattern requiring the stamp to END right
 * after the date (`_Facts last verified 2026-07-16._`) — and almost no real stamp does. The house
 * shape is `_Facts last verified <date> — what was checked, what was skipped._`, so the button
 * answered "has no _Facts last verified_ stamp to refresh" on the very pages the queue was
 * flagging. It replaces the DATE and nothing else, so whatever prose the stamp carries survives
 * verbatim — that text is what citations are proven against.
 */
export function stampVerified(text: string, date: string): string | null {
  const all = [...text.matchAll(STAMP)];
  if (all.length === 0) return null;
  const m = all[all.length - 1];
  return text.slice(0, m.index) + `${m[1]}${date}` + text.slice(m.index + m[0].length);
}
/** Tools retired in Stage 5. A live note describing them answers about a system that is gone. */
const RETIRED = ["brain_recall", "brain_search", "brain-index.md", "build_index", "recall.py"];
/**
 * A note whose filename is a date is a record OF that date, not a standing claim.
 * `log/2026-07-26.md` saying brain_recall is live was true the night it was written; flagging it
 * would ask the operator to falsify his own diary.
 *
 * Exported (with DATED_HEADING) because lib/inbox.ts applies the identical doctrine to its
 * superseded-link check — a diary entry naming a now-superseded page was true the night it was
 * written. Two definitions of "this text is a dated record" would drift exactly the way two
 * definitions of "retracted" did.
 */
export const DATED_ENTRY = /(^|\/)\d{4}-\d{2}-\d{2}\.md$/;
/**
 * The same rule for headings: a section titled "… found on the Linux box 2026-07-31" is a
 * record OF that date. A cleanup story that names the tool it deleted is not a live claim,
 * and flagging it asks the operator to falsify his own history.
 */
export const DATED_HEADING = /\b\d{4}-\d{2}-\d{2}\b/;


export interface NoteRow {
  path: string;
  dir: string;
  tokens: number;
  blocks: number;
  retracted: number;
  /** One character per block: "." live, "x" retracted. Rendered as the corpus strip. */
  strip: string;
  age: number | null;
  /**
   * What the note would say about itself if asked: its first heading, its first sentence of
   * prose, and its outline. The ledger showed only sizes for weeks and read as a parts list —
   * a row you cannot interrogate is furniture. All three fields pass through redact() before
   * leaving, same as retractedList: the console is an egress too.
   */
  title: string;
  desc: string;
  headings: Array<{ h: string; line: number }>;
}

export interface Retracted {
  path: string;
  line: number;
  heading: string;
  text: string;
}

export interface Health {
  sha: string;
  notes: NoteRow[];
  retractedList: Retracted[];
  stale: Array<{
    path: string;
    verified: string;
    age: number;
    /** ISO date the operator queued this note for the groundskeeper, when they have. */
    queued?: string;
  }>;
  secrets: Array<{ path: string; line: number; kind: string }>;
  triage: Array<{
    /**
     * `watch` is the third tier, below warn: the mechanical inbox checks (lib/inbox.ts) —
     * structure worth a glance, never a problem demanding a decision now. It exists so those
     * items can ride this queue without inflating warn, whose meaning ("something is wrong")
     * the 23-noise-items lesson made expensive to dilute.
     */
    sev: "crit" | "warn" | "watch";
    /**
     * What KIND of finding this is, so the console can offer the actions that fit it without
     * matching on display text. A title is copy; changing it should not silently remove a button.
     */
    kind?: "stale-stamp" | "superseded-link" | "coaccess-gap" | "correction-chain";
    title: string;
    loc: string;
    evidence: string;
    why: string;
    action: string;
    /**
     * stale-stamp only: the note carries a `reverify:` request the groundskeeper has not yet
     * consumed. The item stays in the queue — queued is a promise, not a fix — but the console
     * renders it as waiting on the nightly run rather than on the operator.
     */
    queued?: string;
  }>;
  retiredRefs: Array<{
    path: string;
    terms: string[];
    /** Blocks naming a retired tool that carry no marker — the ones that verify clean. */
    unmarked: number;
    /** Blocks the brain has already retracted. Shown as credit, never as a problem. */
    marked: number;
    lines: number[];
  }>;
  totals: {
    notes: number;
    tokens: number;
    blocks: number;
    retractedBlocks: number;
    notesWithRetracted: number;
  };
  byDir: Array<{ dir: string; notes: number; tokens: number }>;
}

/** One item of the queue, whoever derived it — health() here, or the inbox checks in
 *  lib/inbox.ts. One shape, so the attention screen cannot tell the two producers apart. */
export type TriageItem = Health["triage"][number];

const SECRETISH_KEY = /(TOKEN|SECRET|KEY|PASS|PWD|CREDENTIAL|AUTH)/i;
const PLACEHOLDER_VALUE =
  /^(<[^>]*>?|\[[^\]]*\]?|\$\{?[A-Za-z_(][^\s]*|your[-_]\S*|changeme|xxx+|\.{3,}|\*+|•+)$/i;

/**
 * Does a generic key=value line plausibly hold a REAL secret? See the alert-precision note.
 *
 * BOTH separators, and EVERY pair on the line — matching redact()'s classifier. redact keys the
 * kind="key=value" verdict on `…["']?\s*[:=]\s*\S+` (colon accepted for JSON/YAML provider
 * bodies), so a `api_key: <opaque>` line is flagged secret AND classified key=value there; a gate
 * here that read only `=` let that colon form fall through — masked at egress, yet never surfaced
 * in the crit queue while its `=` twin was. And iterated, not first-match-only: a single `.exec`
 * stopped at a benign leading `word:` (a "Fix:" or "Note:" prefix) and returned before it ever
 * reached the real `KEY=<secret>` later on the same line. Alert if ANY pair is secret-shaped.
 */
export function plausibleSecret(line: string): boolean {
  const re = /([A-Za-z_][A-Za-z0-9_]*)["']?\s*[:=]\s*("[^"]*"|'[^']*'|`[^`]*`|\S+)/g;
  for (const m of line.matchAll(re)) {
    if (!SECRETISH_KEY.test(m[1])) continue;
    const value = m[2].replace(/^[`"']|[`"',.;]+$/g, "");
    if (value.length < 16) continue;
    // $(…) and ${…} are indirection, not secrets — a note documenting `TOKEN="$(security
    // find-generic-password …)"` is describing Keychain hygiene, the exact practice the
    // alert exists to encourage. Quoted substitutions carry spaces, so this is a prefix
    // test rather than part of the single-token placeholder regex.
    if (/^\$[({]/.test(value)) continue;
    if (PLACEHOLDER_VALUE.test(value)) continue;
    return true;
  }
  return false;
}


export async function health(now = new Date()): Promise<Health> {
  const corpus = await loadCorpus();
  const notes: NoteRow[] = [];
  const retractedList: Retracted[] = [];
  const stale: Health["stale"] = [];
  const secrets: Health["secrets"] = [];
  const retiredRefs: Health["retiredRefs"] = [];

  for (const [path, text] of corpus.files) {
    const blocks = splitBlocks(text);
    const dated = DATED_ENTRY.test(path);
    const retiredTerms = new Set<string>();
    const retiredLines: number[] = [];
    let retiredMarked = 0;
    let n = 0;
    const strip: string[] = [];
    for (let i = 0; i < blocks.length; i++) {
      const hit = retracted(blocks, i);
      strip.push(hit ? "x" : ".");

      // Scored per BLOCK, not per mention, because a block is the unit a quote is proven inside —
      // so this counts the passages brain_ask could actually answer from. Counting raw mentions
      // ranked the changelog of the retirement above the note that still believed in it: the
      // page that documents killing a tool necessarily names it most.
      if (!dated && !DATED_HEADING.test(blocks[i].heading)) {
        const found = RETIRED.filter((t) => blocks[i].text.includes(t));
        if (found.length) {
          // `hit` is verify.ts's verdict, reused rather than re-derived. A mention already under a
          // SUPERSEDED / CORRECTION / (was: "…") marker is caught on the read path, so it is
          // counted as handled. Two opinions about what "retracted" means is the drift Stage 5
          // spent a day deleting.
          if (hit) retiredMarked++;
          else {
            for (const t of found) retiredTerms.add(t);
            retiredLines.push(blocks[i].line);
          }
        }
      }

      if (!hit) continue;
      n++;
      if (retractedList.length < 200) {
        retractedList.push({
          path,
          line: blocks[i].line,
          heading: redact(blocks[i].heading).slice(0, 80),
          // Redacted with the same scrubber the read path uses — a console is an egress too.
          text: redact(normalise(blocks[i].text)).slice(0, 240),
        });
      }
    }

    // The scan is redact()'s own opinion, per line — a second shape list here drifted from
    // redact.ts's (it missed ghs_, xox*, JWTs, URLs) and reported at most one hit per note.
    // Lines are truncated before matching so a pathological unbroken run cannot make the
    // generic key=value pattern backtrack for seconds (measured: 21s on one 100K-char line).
    const lines = text.split("\n");
    let found = 0;
    for (let ln = 0; ln < lines.length && found < 5; ln++) {
      const probe = lines[ln].slice(0, 2000);
      if (!hasSecret(probe)) continue;
      const out = redact(probe);
      const kind = out.includes("<redacted-token>") ? "vendor token"
        : out.includes("<redacted-jwt>") ? "jwt"
        : out.includes("<redacted-url>") ? "url secret" : "key=value";
      // Egress redaction is recall; this alert is precision. The generic key=value shape
      // matched sudoers lines (NOPASSWD: ALL=...), documented placeholders, and 10-char
      // shell examples — none a credential. It only alerts when the key NAME is secret-ish
      // and the value is long enough to be one and not a placeholder. Vendor tokens, JWTs
      // and URL secrets keep alerting unconditionally — those shapes don't false-positive.
      if (kind === "key=value" && !plausibleSecret(probe)) continue;
      secrets.push({ path, line: ln + 1, kind });
      found++;
    }

    let age: number | null = null;
    const stamp = lastVerified(text);
    if (stamp) {
      const d = new Date(`${stamp}T00:00:00Z`);
      if (!Number.isNaN(d.getTime())) {
        age = Math.round((now.getTime() - d.getTime()) / 86_400_000);
        // Two weeks, not two days: at >2 the queue flagged pages re-verified three days
        // earlier, and an alert that fires on freshly checked work teaches you to ignore it.
        //
        // `decays: false` opts a note out entirely, because the same reasoning goes further than
        // the threshold does. The check treated every stamped note alike and the notes are not
        // alike: a note recording that a package was uninstalled on a date cannot stop being
        // true, while a runbook describing how a machine is configured decays the moment the
        // machine changes. Measured before this: 7 findings, 6 of them settled history, all of
        // them arriving within two days of each other because the threshold is a clock. An inbox
        // that is mostly noise is one you stop reading, and the item it buried here was the
        // recovery runbook with an unmitigated risk in it.
        const fm = parseFrontmatter(text);
        // `!dated`: a note whose filename is a date is a record OF that date, not a standing
        // claim (the DATED_ENTRY doctrine above, already applied to the retired-tool check).
        // Its stamp cannot go stale, so it never rides the re-verify queue — otherwise a day
        // log that happens to quote a "_Facts last verified_" line asks the operator to
        // re-verify his own diary, burning a groundskeeper slot on a page that can never resolve.
        if (age > 14 && !dated && fm.decays !== false) {
          stale.push({
            path,
            verified: stamp,
            age,
            ...(fm.reverify === undefined ? {} : { queued: fm.reverify }),
          });
        }
      }
    }

    if (retiredLines.length) {
      retiredRefs.push({
        path,
        terms: [...retiredTerms].sort(),
        unmarked: retiredLines.length,
        marked: retiredMarked,
        lines: retiredLines.slice(0, 12),
      });
    }

    // The note's self-description, straight from its own first lines. Parsed off the raw text
    // rather than the block list so heading LINES (not "the heading a block sits under") come
    // out with exact line numbers the operator can jump to.
    const headings: NoteRow["headings"] = [];
    let title = "";
    let desc = "";
    let inFence = false;
    const rawLines = text.split("\n");
    for (let li = 0; li < rawLines.length; li++) {
      const line = rawLines[li];
      // Fence state first: a "# comment" inside a code block is not a heading, and the first
      // line of a fenced example is not the note's description.
      if (line.trimStart().startsWith("```")) {
        inFence = !inFence;
        continue;
      }
      if (inFence) continue;
      const h = /^#{1,4}\s+(.+)/.exec(line);
      if (h) {
        if (!title) title = h[1].trim();
        if (headings.length < 14) headings.push({ h: redact(h[1].trim()).slice(0, 90), line: li + 1 });
        continue;
      }
      if (!desc) {
        const t = line.trim();
        // First real prose: skip blanks and quotes; a list item counts — plenty of notes open
        // with one, and "no description" must mean the note has none, not that the parser was
        // picky.
        if (t && !t.startsWith(">")) {
          desc = redact(t.replace(/^[-*]\s+/, "")).slice(0, 150);
        }
      }
    }
    title = redact(title || path.split("/").pop()!.replace(/\.md$/, "")).slice(0, 90);

    notes.push({
      title,
      desc,
      headings,
      path,
      dir: path.includes("/") ? path.split("/")[0] : "root",
      tokens: Math.round(text.length / 4),
      blocks: blocks.length,
      retracted: n,
      strip: strip.join(""),
      age,
    });
  }

  notes.sort((a, b) => b.tokens - a.tokens);
  stale.sort((a, b) => b.age - a.age);
  // Most unmarked passages first; ties break toward the note that has never been corrected,
  // because a page already carrying markers is a page someone is maintaining.
  retiredRefs.sort(
    (a, b) => b.unmarked - a.unmarked || a.marked - b.marked || a.path.localeCompare(b.path),
  );

  const dirs = new Map<string, { notes: number; tokens: number }>();
  for (const n of notes) {
    const d = dirs.get(n.dir) ?? { notes: 0, tokens: 0 };
    d.notes++;
    d.tokens += n.tokens;
    dirs.set(n.dir, d);
  }

  // The triage queue: every finding the console already computes, as one prioritised list.
  // Assembled here so the page and any future surface share one opinion of "needs attention".
  const triage: Health["triage"] = [
    ...secrets.map((s) => ({
      sev: "crit" as const,
      title: "Credential-shaped line",
      loc: `${s.path}:${s.line}`,
      evidence: `A ${s.kind} pattern sits in the note text.`,
      why: "Redaction catches it at egress, but storing it is the underlying mistake — an exfiltration channel waiting on a redaction gap.",
      action: "Move the secret to a manager and replace the line with a pointer.",
    })),
    ...retiredRefs.map((r) => ({
      sev: "warn" as const,
      title: `Unmarked retired-tool claim${r.unmarked > 1 ? "s" : ""}`,
      loc: `${r.path} · L${r.lines.join(", L")}`,
      evidence: `${r.unmarked} block(s) name ${r.terms.join(", ")} with no retraction marker.`,
      why: "A quote from an unmarked block verifies clean and reads as current fact about a system that is gone.",
      action: "Mark the passage SUPERSEDED in place — never delete it.",
    })),
    ...stale.map((s) => {
      // A consumed request is a removed key, so "queued" here always means "not yet done". Two
      // days is two missed nightly runs: past that, the promise itself is the finding — say so,
      // because a queued badge that can sit for a week teaches the same skimming the dismiss
      // button was refused for.
      const requested = s.queued ? new Date(`${s.queued}T00:00:00Z`) : null;
      // floor, not round: "two missed runs" means two FULL days have passed since the request,
      // and rounding a day and a half up would raise the alarm while the first night's run is
      // still the only one that has had its chance.
      const overdue =
        requested && !Number.isNaN(requested.getTime())
          ? Math.floor((now.getTime() - requested.getTime()) / 86_400_000) >= 2
          : false;
      return {
        sev: "warn" as const,
        kind: "stale-stamp" as const,
        // Not "cold": this product already uses hot/warm/cold for how often a note is READ, and a
        // finding that borrows the word to mean "the stamp is old" makes both senses ambiguous.
        title: "Verification stamp is stale",
        loc: s.path,
        evidence:
          `Its own "_Facts last verified_" stamp is ${s.age} days old (${s.verified}).` +
          (overdue
            ? ` Queued for re-verify since ${s.queued} and still unconsumed — check that the groundskeeper is running.`
            : ""),
        why: "Stale facts are the main way this brain rots; the stamp is the note's own freshness claim.",
        action: "Re-verify the page's live-state claims and refresh the stamp — or mark it as recording settled history, which stops the check.",
        ...(s.queued === undefined ? {} : { queued: s.queued }),
      };
    }),
  ];

  return {
    sha: corpus.sha.slice(0, 12),
    notes,
    retractedList,
    stale,
    triage,
    secrets,
    retiredRefs,
    totals: {
      notes: notes.length,
      // Sum of the per-note figures, so the gauge and the rows can never disagree. bytes/4
      // counted UTF-8 while every row counts UTF-16 length/4 — close, but visibly different.
      tokens: notes.reduce((a, n) => a + n.tokens, 0),
      blocks: notes.reduce((a, n) => a + n.blocks, 0),
      retractedBlocks: notes.reduce((a, n) => a + n.retracted, 0),
      notesWithRetracted: notes.filter((n) => n.retracted > 0).length,
    },
    byDir: [...dirs.entries()]
      .map(([dir, v]) => ({ dir, ...v }))
      .sort((a, b) => b.tokens - a.tokens),
  };
}
