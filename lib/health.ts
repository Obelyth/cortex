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

/** A note's own claim about its freshness. Cold stamps are how a brain rots quietly. */
const STAMP = /_Facts last verified\s+(\d{4}-\d{2}-\d{2})/i;
/** Tools retired in Stage 5. A live note describing them answers about a system that is gone. */
const RETIRED = ["brain_recall", "brain_search", "brain-index.md", "build_index", "recall.py"];
/**
 * A note whose filename is a date is a record OF that date, not a standing claim.
 * `log/2026-07-26.md` saying brain_recall is live was true the night it was written; flagging it
 * would ask the operator to falsify their own diary.
 */
const DATED_ENTRY = /(^|\/)\d{4}-\d{2}-\d{2}\.md$/;


export interface NoteRow {
  path: string;
  dir: string;
  tokens: number;
  blocks: number;
  retracted: number;
  /** One character per block: "." live, "x" retracted. Rendered as the corpus strip. */
  strip: string;
  age: number | null;
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
  stale: Array<{ path: string; verified: string; age: number }>;
  secrets: Array<{ path: string; line: number; kind: string }>;
  triage: Array<{
    sev: "crit" | "warn";
    title: string;
    loc: string;
    evidence: string;
    why: string;
    action: string;
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
    ceiling: number;
    blocks: number;
    retractedBlocks: number;
    notesWithRetracted: number;
  };
  byDir: Array<{ dir: string; notes: number; tokens: number }>;
}

const CEILING = 150_000;

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
      if (!dated) {
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
      secrets.push({ path, line: ln + 1, kind });
      found++;
    }

    let age: number | null = null;
    const stamp = STAMP.exec(text);
    if (stamp) {
      const d = new Date(`${stamp[1]}T00:00:00Z`);
      if (!Number.isNaN(d.getTime())) {
        age = Math.round((now.getTime() - d.getTime()) / 86_400_000);
        if (age > 2) stale.push({ path, verified: stamp[1], age });
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

    notes.push({
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
    ...stale.map((s) => ({
      sev: "warn" as const,
      title: "Cold verification stamp",
      loc: s.path,
      evidence: `Its own "_Facts last verified_" stamp is ${s.age} days old (${s.verified}).`,
      why: "Stale facts are the main way this brain rots; the stamp is the note's own freshness claim.",
      action: "Re-verify the page's live-state claims and refresh the stamp.",
    })),
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
      ceiling: CEILING,
      blocks: notes.reduce((a, n) => a + n.blocks, 0),
      retractedBlocks: notes.reduce((a, n) => a + n.retracted, 0),
      notesWithRetracted: notes.filter((n) => n.retracted > 0).length,
    },
    byDir: [...dirs.entries()]
      .map(([dir, v]) => ({ dir, ...v }))
      .sort((a, b) => b.tokens - a.tokens),
  };
}
