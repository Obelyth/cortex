/**
 * hard-verify — adversarial tests for lib/verify.ts, the trust anchor.
 *
 * Judged against one asymmetry: a FALSE VERIFIED launders a fabrication into a fact and is
 * catastrophic; a FALSE UNVERIFIED is only annoying. Every `BUG:` below is a case where the
 * verifier stamps VERIFIED on something that is not what the file says, where it cannot tell
 * a live claim from a retracted one, or where the TypeScript serving path and the Python eval
 * disagree about what "the same text" means. `OK:` marks behaviour that is correct today —
 * either a hunt that came up empty, or a bug that has since been closed and is pinned here so
 * it cannot come back.
 *
 * Three classes of false VERIFIED have been fixed since this file was written, and the tests
 * that used to prove them now prove they fail:
 *
 *   1. Whole-file whitespace collapse, which let a quote be spliced out of two paragraphs.
 *      Matching is now scoped to one BLOCK.
 *   2. A blanket `[*_`>#]+` strip, which made `brain_ask` == `brainask` and — worst —
 *      `top-1 > 58.4%` == `top-1 58.4%`. Stripping is now POSITIONAL.
 *   3. Supersession being invisible. The verdict now carries `superseded`.
 *
 * Each of those tests keeps its original measurement against the live brain, rewritten as
 * "was: … — now: …", because the measurement is the reason the guard exists.
 *
 * These tests assert CURRENT behaviour. A `BUG:` test passing means the bug is still live.
 * Fixes land elsewhere; when they do, the `BUG:` expectations are what must flip.
 *
 * Not duplicated here: tests/verify-parity.test.ts pins the normalise() golden and the basic
 * block-scoping contract. This file is the adversarial half — real strings from the corpus,
 * asserted at the citation level.
 *
 * The quoted strings are synthetic notes that mirror, shape-for-shape, the structures
 * measured on a real operator brain as of 2026-07-27 — supersession banners, corrections,
 * (was: "...") markers, tables, hard wraps. They are embedded rather than read from disk so
 * the file is self-contained; the `live brain corpus` block at the end re-checks the generic
 * properties against a real clone when one is present, and skips when it is not.
 */
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { normalise, verifyQuote, checkCitation, splitBlocks, MIN_QUOTE } from "../lib/verify";

// Resolved the same way every other suite here resolves it. An absolute path to one
// developer's home directory is not a location; CI checks out cortex alone and crashed.
/**
 * Whole-corpus scans need more than vitest's 5s default.
 *
 * Four tests here walk every block of every note -- some also citing across each block join --
 * thousands of verifyQuote calls. They take ~4-5s on a developer laptop and time out on a CI
 * runner, which is how the first two behaved: passing locally, failing in CI, looking like flake.
 * The work is bounded by corpus size and machine speed, not by anything the code under test does,
 * so the honest fix is a budget that fits the slowest machine that runs them rather than a retry
 * or a skip. The other two joined this budget on 2026-08-24, once the growing brain pushed them
 * over the 5s line too -- the same failure, one corpus-size later.
 *
 * Deliberately per-test rather than a global testTimeout: every other suite here should still
 * fail fast, and raising the default would hide a genuine hang in an ordinary unit test.
 */
const WHOLE_CORPUS_TIMEOUT_MS = 60_000;

const BRAIN = process.env.BRAIN_DIR ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../brain");
const haveBrain = fs.existsSync(path.join(BRAIN, "projects/cortex.md"));

/** Invisible characters, written as escapes so a reader can see what is being tested. */
const ZWSP = "​";
const SHY = "­";
const WJ = "⁠";
const MVS = "᠎";
const BOM = "﻿";

// --------------------------------------------------------------------------------------
// Real brain excerpts. Copied byte-for-byte; the em dashes and backticks are load-bearing.
// --------------------------------------------------------------------------------------

/** notes/beacon-beacon.md:20-22 — the brain's own supersession banner, and the line it disowns. */
const BEACON_BEACON = [
  "- **Daily Beacon Check game (built 2026-07-14; spec+plan in docs/superpowers/)**: 9-task subagent-driven build on `dev`, all reviewed.",
  "> **SUPERSEDED 2026-07-25 — production is dark. See `projects/beacon.md`.** The URL below returned 404 when re-checked on 2026-07-25; it was genuinely live on 2026-07-14, so the entry is kept as history. Do not answer \"is Beacon shipped?\" from this line.",
  "",
  "- **SHIPPED 2026-07-14**: Daily Beacon Check live in production at https://beacon-demo.example.com/play. Env pushed to Vercel (prod+preview, service-role key server-only, verified not baked into any bundle).",
].join("\n");

/** projects/admin-board.md:3-9 — a CORRECTION blockquote over the stale claim it corrects. */
const BOARD = [
  "## Status",
  "",
  "> **CORRECTION 2026-07-26 — the hourly auto-pull described below is DEAD, and has been since 2026-06-24 02:20** (0 successes in 240 runs). These 5 tabs have been stale for a month. The \"Live since\" framing and the \"maintenance mode, nothing pending\" line further down are both wrong.",
  "",
  "Live since 2026-06-16: Python pipeline (`board-sync`) pulling ad-hoc SQL off the reporting warehouse → pandas → Sheets API, 5 own tabs (Overview/By lane/Trend/Task detail/Gaps).",
].join("\n");

/** projects/cortex.md:59-63 — a heading that refutes the quoted claim directly under it. */
const CORTEX_RERANK = [
  "## Groundskeeper note — re-ranker is ON in production (2026-07-27)",
  "",
  "The 2026-07-26 22:22 log says the Haiku re-ranker is \"deliberately OFF\". **That is no longer true of production.** `RECALL_RERANK` was set in Vercel Production ~9 hours before this check.",
].join("\n");

/** projects/cortex.md:12 — the live retrieval metrics. */
const CORTEX_METRICS =
  "Measured retrieval quality over 166 independently-labelled questions: arithmetic top-1 **58.4%**, MRR 0.727, right note in the top ten 74.7%.";

/** projects/cortex.md:8 + :18 — tool and env-var names, all snake_case in backticks. */
const CORTEX_NAMES = [
  "**Six tools now, not five** — `brain_recall` shipped 2026-07-27 (PRs #4 `1a2b3c4`, #5 `d94641c`).",
  "Env on Vercel prod: `GITHUB_TOKEN` (fine-grained PAT, brain repo only), `MCP_TOKEN`, `CONNECTOR_PATH_SECRET`, `BRAIN_REPO`.",
  "cap the surface around 7-8 tools — **6 registered as of 2026-07-27**, so there is room for one or two more.",
].join("\n");

/** projects/beacon.md:20-22 — a superseded fact kept verbatim inside a `(was: "...")` note. */
const BEACON_WAS =
  "Branches `main`/`dev` plus **three** open PRs: #1 \"Bootstrap beacon-next\" (opened 2026-07-19), #2 (07-20), #3 (07-21). (was: \"two open PRs (#2, #3)\" — updated 2026-07-25: #1 was never merged and is still open.)";

/** projects/cortex.md:27-32 — the seam between the Next bullets and the next H2. */
const CORTEX_SEAM = [
  "## Next",
  "- Rotate the sample-app API token found hardcoded in `apps/beacon`'s `config.yml` — still unrotated and still in the file as of 2026-07-25 (see projects/beacon.md).",
  "",
  "",
  "## Standing defects (logged 2026-07-25 — two closed 2026-07-27, the rest still open)",
].join("\n");

/** notes/pr-targets.md:22-25 — the deviating-branch table. */
const BRANCH_TABLE = [
  "| Project | PRs target | Notes |",
  "|---|---|---|",
  "| Aurora | **`Dev-Staging`** | `Dev-Staging → main` lands in a separate later promote. |",
  "| Meridian v2 | **ask every time** | Never settled. Check with the operator instead of assuming a target. |",
  "| Harbor | see project page | 07-25 review turned up **no `staging` branch** — recent PRs land on `main` straight from feature branches. |",
].join("\n");

/**
 * notes/escalation-ladder.md:14-16 — a `>` precedence chain, hard-wrapped.
 * The bullet line is included because it is the other half of the block: lines 14-15 are one
 * list item joined by a soft wrap, and line 16 is where the wrap happens to start with `>`.
 */
const PRECEDENCE = [
  "- **PLAYBOOK.md** — the escalation ladder: route every incident to the",
  "  narrowest tier that can own it (runbook > pager > channel > standup > wiki",
  "  > backlog); \"someone will notice\" is tier-0 and always fails.",
].join("\n");

const SHA = "d94641c0aaaa1111";

// ======================================================================================
// 1. The corpus's own supersession markers — invisible before, carried on the verdict now
// ======================================================================================
describe("supersession is visible to verifyQuote", () => {
  it("OK: a line the brain explicitly disowns verifies, and comes back flagged superseded", () => {
    // notes/beacon-beacon.md:20 says, in as many words, `Do not answer "is Beacon shipped?"
    // from this line.` The line it is pointing at is one blank line below it.
    //
    // was: ask cortex "is Beacon shipped?" and a reader that obeys the corpus and cites the
    // SHIPPED bullet got a plain green VERIFIED on a URL that projects/beacon.md records as
    // 404ing — nothing in the verdict said which of the two lines was current.
    // now: it still verifies, because the text really is on the page, but the banner sits in
    // the block immediately above it and the verdict says `superseded`. ask.ts renders that
    // as a `SUPERSEDED — ...` stamp instead of a clean proof.
    const quote =
      "SHIPPED 2026-07-14**: Daily Beacon Check live in production at https://beacon-demo.example.com/play";
    const v = verifyQuote(BEACON_BEACON, quote);
    expect(v.verified).toBe(true);
    expect(v.superseded).toBe(true);
    expect(v.line).toBe(4);
    // The evidence shown is the FILE's own bullet, not the model's rendering of it.
    expect(v.matched).toContain("**SHIPPED 2026-07-14**");

    // ...and the disclaimer that would have saved it is right there in the same file, equally
    // verifiable — and equally flagged, since it is itself the retraction.
    const d = verifyQuote(BEACON_BEACON, "Do not answer \"is Beacon shipped?\" from this line");
    expect(d.verified).toBe(true);
    expect(d.superseded).toBe(true);
    expect(d.line).toBe(2);
  });

  it("OK: the CORRECTION blockquote and the text it corrects are separate blocks, both flagged", () => {
    // was: `>` was in STRIP, so a blockquote was not a structure the verifier could see. After
    // normalise() the CORRECTION banner was ordinary prose sitting next to the claim it kills,
    // and both verified with the same reason string and nothing else to tell them apart.
    // now: `>` starts a block, so the banner is the matched block's neighbour, and both sides
    // come back `superseded`. `reason` still cannot separate them — the separation moved to
    // `superseded`, `line` and `heading`, which is where it belongs.
    const stale = verifyQuote(BOARD, "Live since 2026-06-16: Python pipeline");
    const correction = verifyQuote(BOARD, "the hourly auto-pull described below is DEAD");
    expect(stale.verified).toBe(true);
    expect(correction.verified).toBe(true);
    expect(stale.reason).toBe(correction.reason);
    expect(stale.superseded).toBe(true);
    expect(correction.superseded).toBe(true);
    expect(stale.line).toBe(5);
    expect(correction.line).toBe(3);
    expect(stale.heading).toBe("Status");

    // The `>` is still gone from the WHOLE-FILE normal form — line-leading markers are
    // stripped, by design, so a reader may quote a blockquote without its marker. That is
    // exactly why matching is scoped to blocks rather than to this string.
    expect(normalise(BOARD)).not.toContain(">");
    expect(splitBlocks(BOARD).map((b) => b.line)).toEqual([1, 3, 5]);
  });

  it("BUG: a quoted-and-refuted claim still verifies as 'exact' and is NOT flagged", () => {
    // projects/cortex.md quotes an old log line *in order to refute it in the next clause*.
    // The refutation is invisible to a substring check, and it uses none of the corpus's
    // retraction words, so SUPERSEDED_RE does not fire. This one is a third-party-egress
    // claim: a VERIFIED "the re-ranker is deliberately OFF" tells the operator their questions are
    // not leaving the box, when cortex.md's own heading says they are.
    //
    // Unchanged by the block/supersession work, and deliberately so: the fix flags the three
    // written conventions the brain actually uses (SUPERSEDED / CORRECTION / DEPRECATED,
    // `(was: "…")`, `Do not answer`), not free-form refutation. Widening it to "any nearby
    // negation" would flag healthy text, and a warning that fires on healthy text stops being
    // read. The partial mitigation is provenance: the verdict now carries the refuting
    // heading, so what is displayed next to the quote contradicts it in the reader's face.
    const v = verifyQuote(CORTEX_RERANK, "the Haiku re-ranker is \"deliberately OFF\"");
    expect(v.verified).toBe(true);
    expect(v.reason).toBe("exact");
    expect(v.superseded).toBe(false);
    expect(v.heading).toBe("Groundskeeper note — re-ranker is ON in production (2026-07-27)");
  });

  it("OK: text preserved inside a (was: \"...\") supersession note verifies AND is flagged", () => {
    // The brain's house style keeps the old wording verbatim so the correction is auditable.
    //
    // was: that made every correction a landmine — the superseded string is a genuine
    // substring, so `two open PRs (#2, #3)` verified with nothing to mark it as history.
    // now: `was: "` is one of the retraction markers, so the whole block is flagged.
    const dead = verifyQuote(BEACON_WAS, "two open PRs (#2, #3)");
    expect(dead.verified).toBe(true);
    expect(dead.superseded).toBe(true);

    // The live half of the same sentence is flagged too. Over-flagging, and accepted: the
    // radius is one block and the correction lives INSIDE the block it corrects, so there is
    // no sub-block signal to separate `three` from `was: "two"`. A spurious "check this"
    // costs a glance; a missed retraction costs a wrong answer with a green stamp.
    const liveFact = verifyQuote(BEACON_WAS, "three** open PRs");
    expect(liveFact.verified).toBe(true);
    expect(liveFact.superseded).toBe(true);
  });
});

// ======================================================================================
// 2. Markdown stripping is positional — line-leading markers and emphasis, not everywhere
// ======================================================================================
describe("markdown stripping is positional, not a blanket [*_`>#] strip", () => {
  it("OK: brain_ask and brainask are different strings", () => {
    // was: `[*_`>#]+` ran over the whole string, so an underscore inside an identifier was
    // markdown. Every tool name and env var in the brain could be silently renamed.
    // now: `_` is only dropped where it opens or closes emphasis — after a space or bracket,
    // or before space/punctuation — which is never the case mid-identifier.
    expect(normalise("brain_ask")).toBe("brain_ask");
    expect(normalise("`brain_recall`")).toBe("brain_recall");
    expect(normalise("`brain_recall`")).not.toBe(normalise("brainrecall"));
    expect(normalise("ADMIN_PASSWORD")).toBe("ADMIN_PASSWORD");
    expect(normalise("ADMIN_PASSWORD")).not.toBe(normalise("ADMINPASSWORD"));
  });

  it("OK: injecting `>` no longer turns an exact measurement into an inequality", () => {
    // cortex.md states top-1 is 58.4%.
    //
    // was: a reader that wanted to say "better than 58.4%" could cite a quote containing `>`
    // and be told the quote was verbatim; the rendered proof showed the RAW quote, so the operator
    // read "top-1 > 58.4%" over the word VERIFIED. The single worst instance of the blanket
    // strip — it turned a measurement into a different, stronger claim.
    // now: `>` is only markdown at the start of a line, so the inequality is simply not in
    // the file, and the citation carries no evidence at all.
    const lie = "arithmetic top-1 > 58.4%, MRR 0.727";
    expect(CORTEX_METRICS.includes(lie)).toBe(false);
    expect(verifyQuote(CORTEX_METRICS, lie)).toMatchObject({
      verified: false,
      reason: "NOT FOUND in the cited file",
    });
    expect(verifyQuote(CORTEX_METRICS, "right note in the top ten > 74.7%").verified).toBe(false);

    const c = checkCitation(new Map([["projects/cortex.md", CORTEX_METRICS]]), SHA, "projects/cortex.md", lie);
    expect(c.verified).toBe(false);
    expect(c.evidence).toBeUndefined();
    // The model's quote is still echoed back on the Citation, but there is now a separate
    // `evidence` field carrying the FILE's text, and it stays empty when nothing was proven.
    expect(c.quote).toBe(lie);

    // The honest quote of the same line still verifies.
    expect(verifyQuote(CORTEX_METRICS, "arithmetic top-1 **58.4%**, MRR 0.727").verified).toBe(true);
    expect(verifyQuote(CORTEX_METRICS, "right note in the top ten 74.7%").verified).toBe(true);
  });

  it("OK: a closing `**` after `.`, `:` or `%` folds, so dropping the markdown still verifies", () => {
    // was: the CLOSE rule named its ALLOWED predecessors as [A-Za-z0-9)\]}"'], which excluded
    // `.`, `:`, `%` and every accented letter — that is, the brain's dominant bold style, bold
    // that swallows its own trailing punctuation, including the flagship metrics line of
    // projects/cortex.md. Measured then: 267 of 1162 blocks kept a stray marker after
    // normalise(), and 259 of 727 markdown-bearing blocks stopped verifying when the reader
    // dropped the markdown — the exact fold normalise() exists to permit. It failed closed and
    // Python agreed, so it was a shared design gap rather than a divergence, but it was the
    // largest single source of honest quotes being refused.
    //
    // Now the class is stated as an EXCLUSION — anything but space, a marker, or `/` — and
    // backticks are removed outright, since a backtick is only ever a code delimiter while `*`
    // is also a glob and `_` is also an identifier separator. `/` stays excluded on both sides
    // so `notes/*.md` keeps its glob. After: 194 of 1162 blocks keep a marker (all globs and
    // lone asterisks) and 724 of 731 bolded blocks verify with the markdown dropped. The 7
    // that do not are asterisk-globs, where dropping the marker really does change the path.
    expect(normalise("**58.4%**, MRR 0.727")).toBe("58.4%, MRR 0.727");
    expect(normalise("**Sentence ends here.** next")).toBe("Sentence ends here. next");
    expect(normalise("**Label:** value")).toBe("Label: value");
    expect(normalise("`main`/`dev` plus")).toBe("main/dev plus");
    expect(normalise("**café** text")).toBe("café text");

    // The glob must NOT fold, which is why the predecessor class excludes `/` rather than
    // simply allowing everything.
    expect(normalise("agents/*.md")).not.toBe(normalise("agents/.md"));
    expect(normalise("2 * 3 = 6")).toBe("2 * 3 = 6");

    // On the live metrics line, both spellings now verify.
    expect(verifyQuote(CORTEX_METRICS, "arithmetic top-1 **58.4%**, MRR 0.727").verified).toBe(true);
    expect(verifyQuote(CORTEX_METRICS, "arithmetic top-1 58.4%, MRR 0.727").verified).toBe(true);
    // Where the closing marker follows a letter, the fold works as documented.
    expect(normalise("**bold** text here")).toBe("bold text here");
    expect(verifyQuote("the **Dev-Staging** branch is the target", "the Dev-Staging branch").verified).toBe(true);
  });

  it("OK: `>` survives, so a precedence chain cannot flatten into a list", () => {
    // `runbook > pager > channel > standup > wiki > backlog` is an ordering — each beats the
    // next.
    //
    // was: normalised it was six nouns in a row, and a quote asserting they are peers verified
    // against the line that says they are ranked.
    // now: the `>` characters are mid-line, so they stay, and the flattened version matches
    // nothing in the file.
    expect(verifyQuote(PRECEDENCE, "(runbook pager channel standup wiki backlog)")).toMatchObject({
      verified: false,
      reason: "NOT FOUND in the cited file",
    });
    // The real chain, quoted as written, still verifies.
    expect(verifyQuote(PRECEDENCE, "(runbook > pager > channel > standup > wiki").verified).toBe(true);
  });

  it("OK: `#` is not interchangeable — a count and an issue reference stay distinct", () => {
    // was: `#6 registered` == `6 registered` and `PRs #4` == `PRs 4`, so an issue number and
    // a count were the same text and either could be presented as the other.
    expect(verifyQuote(CORTEX_NAMES, "#6 registered as of 2026-07-27").verified).toBe(false);
    expect(verifyQuote(CORTEX_NAMES, "PRs 4 1a2b3c4, 5 d94641c").verified).toBe(false);
    // ...while the honest spellings of both still verify.
    expect(verifyQuote(CORTEX_NAMES, "6 registered as of 2026-07-27").verified).toBe(true);
    expect(verifyQuote(CORTEX_NAMES, "PRs #4 1a2b3c4, #5 d94641c").verified).toBe(true);
  });

  it("OK: identifiers cannot be silently renamed in the quote and still verify", () => {
    // Every one of these is a wrong name for a real thing, presented as verbatim. All of them
    // verified under the blanket strip.
    expect(verifyQuote(CORTEX_NAMES, "brainrecall shipped 2026-07-27").verified).toBe(false);
    expect(
      verifyQuote(CORTEX_NAMES, "GITHUBTOKEN (fine-grained PAT, brain repo only), MCPTOKEN, CONNECTORPATHSECRET").verified
    ).toBe(false);
    // The real names, with or without their backticks, still verify.
    expect(verifyQuote(CORTEX_NAMES, "brain_recall shipped 2026-07-27").verified).toBe(true);
    expect(
      verifyQuote(CORTEX_NAMES, "GITHUB_TOKEN (fine-grained PAT, brain repo only), MCP_TOKEN, CONNECTOR_PATH_SECRET").verified
    ).toBe(true);
  });

  it("OK: a glob and a literal path are different text", () => {
    // was: `*` was stripped everywhere, so `notes/*.md` and `notes/.md` were one string —
    // "the run touched every note" and "the run touched one oddly-named file" were the same
    // claim. A `*` mid-path is neither an opener (not after a space or bracket) nor a closer
    // (not after a word character), so it is left alone.
    expect(normalise("notes/*.md")).toBe("notes/*.md");
    expect(normalise("notes/*.md")).not.toBe(normalise("notes/.md"));
    expect(verifyQuote("the run touched notes/.md and nothing else", "the run touched notes/*.md").verified).toBe(false);
    expect(verifyQuote("the run touched notes/*.md and nothing else", "the run touched notes/.md").verified).toBe(false);
  });

  it("OK: case is preserved — By Lane is not By lane", () => {
    // The one identifier distinction the function deliberately keeps, and it holds.
    expect(normalise("By Lane")).not.toBe(normalise("By lane"));
    expect(verifyQuote("5 own tabs (Overview/By lane/Trend)", "Overview/By Lane/Trend").verified).toBe(false);
  });
});

// ======================================================================================
// 3. Matching is scoped to one block — whitespace no longer splices across structure
// ======================================================================================
describe("matching is scoped to one block", () => {
  it("OK: a quote welded from two different sections is refused, with the boundary named", () => {
    // The fixture's last "Next" bullet says the sample token is STILL UNROTATED. The next H2
    // is "Standing defects (logged 2026-07-25 — two closed 2026-07-27...)". Two blank lines and
    // an `##` separate them.
    //
    // was: normalise() deleted all three, and the result was a single fluent passage in which
    // "two fixed 2026-07-27" attached to the unrotated token — a security item reported as
    // half-closed.
    // now: refused, and the reason says why, so the reader is not left thinking the text is
    // absent when it is the JOIN that is fabricated.
    const spliced =
      "still unrotated and still in the file as of 2026-07-25 (see projects/beacon.md). Standing defects (logged 2026-07-25 — two closed 2026-07-27, the rest still open)";
    expect(CORTEX_SEAM.includes(spliced)).toBe(false);
    for (const line of CORTEX_SEAM.split("\n")) expect(normalise(line)).not.toContain(normalise(spliced));
    expect(verifyQuote(CORTEX_SEAM, spliced)).toMatchObject({
      verified: false,
      reason: "spans a paragraph, list or section boundary — not a contiguous quote",
    });
    // The bullet on its own is still perfectly quotable.
    expect(verifyQuote(CORTEX_SEAM, "still unrotated and still in the file as of 2026-07-25").verified).toBe(true);
  });

  it("OK: a heading no longer merges into the paragraph below it", () => {
    // was: the only marker separating a heading from its body was `#`, which STRIP ate. Both
    // halves are real; together they are a sentence that appears nowhere. 192 such spans
    // existed in the live brain (re-measured below).
    const spliced =
      "re-ranker is ON in production (2026-07-27) The 2026-07-26 22:22 log says the Haiku re-ranker is \"deliberately OFF\"";
    expect(CORTEX_RERANK.includes(spliced)).toBe(false);
    expect(verifyQuote(CORTEX_RERANK, spliced)).toMatchObject({
      verified: false,
      reason: "spans a paragraph, list or section boundary — not a contiguous quote",
    });
    // A heading is its own block, and the paragraph under it reports the heading as context
    // rather than swallowing it.
    expect(splitBlocks(CORTEX_RERANK)).toHaveLength(2);
    expect(verifyQuote(CORTEX_RERANK, "RECALL_RERANK` was set in Vercel Production").heading).toBe(
      "Groundskeeper note — re-ranker is ON in production (2026-07-27)"
    );
  });

  it("OK: table rows do not weld, so a fact cannot move from one project onto another", () => {
    // was: spliced across the row break, "no staging branch" trailed Meridian v2 — a different
    // project with a different answer — and the verifier called the whole thing verbatim, in
    // a note whose entire purpose is not getting that wrong.
    const spliced =
      "Meridian v2 | ask every time | Never settled. Check with the operator instead of assuming a target. | | Harbor | see project page | 07-25 review turned up no staging branch";
    expect(verifyQuote(BRANCH_TABLE, spliced)).toMatchObject({
      verified: false,
      reason: "spans a paragraph, list or section boundary — not a contiguous quote",
    });
    for (const line of BRANCH_TABLE.split("\n")) expect(normalise(line)).not.toContain(normalise(spliced));
    // One row is one block, and still quotable on its own.
    const row = verifyQuote(BRANCH_TABLE, "Meridian v2 | ask every time | Never settled. Check with the operator instead of assuming a target.");
    expect(row.verified).toBe(true);
    expect(row.line).toBe(4);
  });

  it("OK: a splice across a blank line is caught by structure, since it leaves no artefact", () => {
    // Paragraph boundaries normalise to a single space — identical to the space between two
    // sentences of the same paragraph. There is nothing IN the string to notice, which is why
    // the check has to be structural rather than textual; the reason string is now the only
    // artefact there is.
    const text = "The token was revoked and confirmed dead.\n\nThe deploy pipeline is unchanged.";
    const spliced = "confirmed dead. The deploy pipeline is unchanged.";
    expect(text.includes(spliced)).toBe(false);
    expect(verifyQuote(text, spliced)).toMatchObject({
      verified: false,
      reason: "spans a paragraph, list or section boundary — not a contiguous quote",
    });
  });

  it("OK: a quote cannot start inside a supersession banner and end inside the claim it guards", () => {
    // notes/beacon-beacon.md again, this time as one string.
    //
    // was: the banner and the disowned bullet were adjacent in the normal form, so a quote
    // could start inside the warning and end inside the claim, carrying the warning's
    // authority onto it — the most dangerous shape in the whole file.
    // now: `>` and `-` each start a block, so the two cannot be joined at all. Note the two
    // reasons: keep the bullet's `- ` and the string is nowhere in the file even flattened;
    // drop it and the flattened file still contains it, so the boundary reason fires.
    const withMarker = "kept as history. Do not answer \"is Beacon shipped?\" from this line. - SHIPPED 2026-07-14";
    const withoutMarker = "kept as history. Do not answer \"is Beacon shipped?\" from this line. SHIPPED 2026-07-14";
    expect(verifyQuote(BEACON_BEACON, withMarker)).toMatchObject({
      verified: false,
      reason: "NOT FOUND in the cited file",
    });
    expect(verifyQuote(BEACON_BEACON, withoutMarker)).toMatchObject({
      verified: false,
      reason: "spans a paragraph, list or section boundary — not a contiguous quote",
    });
  });

  it("OK: hard-wrapped prose still verifies — the join is load-bearing, not removable", () => {
    // Why block scoping could not simply forbid newlines: every note in the brain is
    // hard-wrapped, so an honest quote of one sentence routinely spans a line break. Lines 14
    // and 15 of the real file are one list item; the quote below crosses that wrap.
    expect(splitBlocks(PRECEDENCE)[0].text.split("\n")).toHaveLength(2);
    expect(
      verifyQuote(PRECEDENCE, "the escalation ladder: route every incident to the narrowest tier that can own it").verified
    ).toBe(true);
  });

  it("BUG: a soft-wrapped line that happens to begin with `>` is split off as a blockquote", () => {
    // notes/escalation-ladder.md:15-16 wraps the precedence chain so that
    // the continuation line starts `  > backlog);`. That `>` is content — the last link of the
    // chain — but it is at the start of a line, so splitBlocks() opens a new block AND
    // LINE_LEAD strips it. Two consequences, both wrong for this line:
    //
    //   1. The full chain is not quotable at all: it now spans two blocks.
    //   2. The whole-file normal form silently reads `... > wiki backlog)`, turning the last
    //      ranked pair into a juxtaposition — the same class of damage the positional strip
    //      was introduced to prevent, just relocated to line-leading position.
    //
    // Fails CLOSED, and the cost of the alternative is higher: measured on the 2026-07-27
    // corpus there are exactly 2 line-leading `>` whose previous line is ordinary prose, and
    // the OTHER one is notes/beacon-beacon.md:20 — the `> **SUPERSEDED ...**` banner that has
    // to start its own block or the retraction check cannot see it. One false negative on a
    // wrapped chain against one missed retraction on a dead production URL is not a close
    // call. Recorded so the trade is deliberate rather than forgotten.
    expect(splitBlocks(PRECEDENCE)).toHaveLength(2);
    expect(verifyQuote(PRECEDENCE, "runbook > pager > channel > standup > wiki > backlog")).toMatchObject({
      verified: false,
      reason: "NOT FOUND in the cited file",
    });
    expect(normalise(PRECEDENCE)).toContain("> wiki backlog)");
  });
});

// ======================================================================================
// 4. Unicode
// ======================================================================================
describe("NFKC and invisible characters", () => {
  it("BUG: NFKC folds superscripts, so an exponent and a three-digit number are one string", () => {
    // Unchanged, and not addressed by the positional/block work: NFKC is applied to unify
    // genuinely-equivalent spellings, and it takes this with it. `10⁶` and `106` differ by
    // four orders of magnitude and normalise to the same twelve characters.
    expect(normalise("10⁶ files")).toBe("106 files");
    expect(verifyQuote("the corpus is 10⁶ files today", "the corpus is 106 files today").verified).toBe(true);
  });

  it("BUG: NFKC folds fullwidth, ligatures, № and vulgar fractions", () => {
    // Same root cause, lower stakes: none of these shapes appear in the brain, so this is a
    // recorded property of the fold rather than a live exposure.
    expect(normalise("ＮＯＴ ＩＮ ＢＲＡＩＮ")).toBe("NOT IN BRAIN");
    expect(normalise("conﬁrmed")).toBe("confirmed");
    expect(normalise("№7")).toBe("No7");
    expect(normalise("½")).toBe(normalise("1⁄2"));
  });

  it("OK: U+FEFF is deleted, not folded to a space, and no longer widens a match", () => {
    // was: U+FEFF was whitespace to JS but not to Python, so it collapsed to a space here and
    // production accepted a quote with a BOM welded into the middle of a word — displaying to
    // the operator as an ordinary word, and rejected by the eval, so the eval never measured it. The
    // one invisible character that WIDENED what verifies.
    // now: deleted outright on both sides. Deletion can only join text, never split it, so a
    // BOM cannot manufacture a word boundary that the file does not have.
    expect(normalise("produc" + BOM + "tion")).toBe("production");
    expect(verifyQuote("Production is still dark", "Production is" + BOM + "still dark").verified).toBe(false);
    // Deleted rather than trimmed: it disappears mid-string as well as at the edges.
    expect(normalise(BOM + "Production is still dark")).toBe("Production is still dark");
    expect(normalise("Production " + BOM + "is still dark")).toBe("Production is still dark");
    // And a BOM inside a word still matches the word without it — the safe direction, since
    // the file's own text is what gets displayed as evidence.
    expect(verifyQuote("Production is still dark", "Produc" + BOM + "tion is still dark").verified).toBe(true);
  });

  it("OK: ZWSP, soft hyphen, word joiner and Mongolian vowel separator all fail CLOSED", () => {
    // Tested because the opposite would be a P0: an invisible character that inserts a word
    // break would let a quote fabricate one.
    //
    // was: they survived NFKC and JS `\s` did not match them, so they broke the match.
    // now: the first three are deleted and the fourth is left literal — different mechanism,
    // same safe outcome. `is<ZWSP>still` becomes `isstill`, which is not `is still`.
    for (const cp of [ZWSP, SHY, WJ, MVS]) {
      expect(verifyQuote("Production is still dark", `Production is${cp}still dark`).verified).toBe(false);
    }
    expect(normalise(`is${ZWSP}still`)).toBe("isstill");
    expect(normalise(`is${MVS}still`)).toBe(`is${MVS}still`);
  });

  it("OK: NFKC does not fold homoglyphs — Cyrillic с stays distinct from Latin c", () => {
    expect(verifyQuote("Production is still dark", "Produсtion is still dark").verified).toBe(false);
  });

  it("OK: real whitespace variants fold as intended (NBSP, ideographic, line separator)", () => {
    for (const cp of [" ", "　", " ", " ", " "]) {
      expect(verifyQuote("Production is still dark", `Production is${cp}still dark`).verified).toBe(true);
    }
  });
});

// ======================================================================================
// 5. MIN_QUOTE = 12
// ======================================================================================
describe("MIN_QUOTE = 12 normalised characters", () => {
  it("BUG: 12 characters of English is boilerplate, not evidence", () => {
    // `on 2026-07-2` is 12 normalised chars and occurs in 33 of the 77 live brain files
    // (measured; see the live-corpus block, where it is re-counted). As proof it narrows the
    // corpus by nothing, yet it clears the guard and renders as VERIFIED next to any answer
    // at all. Untouched by the block/positional work — block scoping stops a quote being
    // fabricated, it does not make a true fragment informative.
    const q = "on 2026-07-2";
    expect(normalise(q).length).toBe(MIN_QUOTE);
    expect(verifyQuote(BEACON_BEACON, q).verified).toBe(true);
    expect(verifyQuote("a note last touched on 2026-07-25, about something else entirely", q).verified).toBe(true);
    // The two matches are indistinguishable as proof; only the provenance differs.
    expect(verifyQuote(BEACON_BEACON, q).line).toBe(2);
  });

  it("BUG: the guard counts characters and never checks the quote supports the answer", () => {
    // `Live since 2` is 12 characters, true, verbatim — and perfectly compatible with the
    // opposite of what the file says, since admin-board.md's own CORRECTION banner
    // records the pipeline as dead since 2026-06-24. verifyQuote has no view on what is
    // being asserted, so a true fragment is a valid proof of a false sentence.
    //
    // Partially mitigated, not fixed: the verdict now says `superseded`, so this particular
    // fragment arrives stamped. A 12-char fragment from a block with no retraction banner
    // near it still arrives clean.
    expect(normalise("Live since 2").length).toBe(MIN_QUOTE);
    const v = verifyQuote(BOARD, "Live since 2");
    expect(v.verified).toBe(true);
    expect(v.superseded).toBe(true);
  });

  it("BUG: trailing/leading space is trimmed AFTER the count, so 12 raw chars can still be rejected", () => {
    // Not dangerous, but it means the documented threshold is not the effective one.
    expect(normalise(" 2026-07-25.").length).toBe(11);
    expect(verifyQuote("shipped on 2026-07-25. and more", " 2026-07-25.")).toMatchObject({
      verified: false,
      reason: "quote too short to prove (<12 chars of actual text)",
    });
  });

  it("OK: a quote made only of markdown wrappers is still rejected", () => {
    // Measuring the RAW length let a citation of pure wrappers clear the guard, normalise to
    // "", and then match every file. Under positional stripping the wrappers no longer even
    // collapse to nothing — `>>##` survives, since `>` and `#` only mean markdown at the
    // start of a line — but four characters is still under the threshold, so it fails on
    // length either way.
    expect(normalise("**__**``>>##**__**")).toBe(">>##");
    expect(verifyQuote("anything at all", "**__**``>>##**__**").verified).toBe(false);
    expect(verifyQuote("anything at all", "").verified).toBe(false);
  });

  it("OK: for CJK the guard is stricter than for English, which is the safe direction", () => {
    // 12 Japanese characters is roughly a full sentence, so the guard demands far more
    // information from a CJK quote than from an English one. False-UNVERIFIED, not false-
    // VERIFIED. Irrelevant to this corpus (no CJK in the brain) but recorded.
    expect(verifyQuote("本番環境はまだ暗いままです", "本番環境はまだ暗い").verified).toBe(false);
    expect(verifyQuote("本番環境はまだ暗いままです。確認済み", "本番環境はまだ暗いままです。確").verified).toBe(true);
  });
});

// ======================================================================================
// 6. checkCitation path handling and provenance
// ======================================================================================
describe("checkCitation path handling", () => {
  const files = new Map([["projects/beacon.md", "**Production is still dark** (re-checked 2026-07-25)."]]);
  const Q = "Production is still dark";

  it("OK: files.get() is exact, so every path variant fails CLOSED", () => {
    // The safe direction, but it is a hard edge: there is no ./-stripping, no case folding,
    // no percent-decoding. An honest reader that types the path from memory instead of
    // copying the FILE: header gets UNVERIFIED on text that is genuinely there.
    for (const p of [
      "./projects/beacon.md",
      "/projects/beacon.md",
      "projects//beacon.md",
      "projects/./beacon.md",
      "Projects/Beacon.md",
      "projects%2Fbeacon.md",
      "projects\\beacon.md",
      "brain/projects/beacon.md",
      "../../../etc/passwd",
    ]) {
      const c = checkCitation(files, SHA, p, Q);
      expect(c.verified).toBe(false);
      expect(c.reason).toBe("cited file is not in the corpus");
    }
    expect(checkCitation(files, SHA, "projects/beacon.md", Q).verified).toBe(true);
  });

  it("BUG: a bad path plus a short quote is reported as a short quote, hiding the bad path", () => {
    // The length guard runs before the corpus lookup, so the reason string blames the wrong
    // thing. Safe (still unverified) but it sends the reader debugging the quote when the
    // real fault is a path that does not exist. Unchanged — the ordering in verifyQuote() is
    // the same, and the Python twin orders them the same way, so at least they agree.
    const c = checkCitation(files, SHA, "notes/does-not-exist.md", "too short");
    expect(c.verified).toBe(false);
    expect(c.reason).toMatch(/quote too short/);
    expect(c.reason).not.toMatch(/not in the corpus/);
  });

  it("OK: the commit is pinned and truncated to 12", () => {
    expect(checkCitation(files, SHA, "projects/beacon.md", Q).commit).toBe("d94641c0aaaa");
  });

  it("OK: evidence is the FILE's own text, so displayed and verified cannot diverge", () => {
    // The rendered proof used to be the model's raw `quote`, which is how "top-1 > 58.4%"
    // could be printed under the word VERIFIED. `evidence` now carries the block the match
    // was found in, straight out of the file — so any residual unicode game in the quote is
    // invisible in what the operator reads, because the quote is not what they read.
    const mangled = `Produc${ZWSP}tion is still dark`;
    const c = checkCitation(files, SHA, "projects/beacon.md", mangled);
    expect(c.verified).toBe(true);
    expect(c.quote).toBe(mangled);
    expect(c.evidence).toBe("**Production is still dark** (re-checked 2026-07-25).");
    expect(c.evidence).not.toContain(ZWSP);
    expect(c.line).toBe(1);
  });
});

// ======================================================================================
// 7. ReDoS
// ======================================================================================
describe("regex safety", () => {
  it("OK: no catastrophic backtracking — every regex is linear on adversarial input", () => {
    // The blanket `[*_`>#]+` was trivially safe: one class, one quantifier. The positional
    // rules are bigger, so this is re-measured rather than re-argued. OPEN and CLOSE each
    // have a bounded `{1,3}` on a character class plus a lookahead, LINE_LEAD is anchored per
    // line, SPACE and ZERO_WIDTH are single classes — no nested quantifier, no backreference,
    // nothing to backtrack into. Confirmed by measurement on 1 MB of the shapes that would
    // expose it: marker runs, marker-then-word, and unclosed openers.
    const cases = [
      "*".repeat(1_000_000),
      "*_`>#".repeat(200_000),
      " \t\n".repeat(333_333),
      " *".repeat(300_000), // every position an opener with no closer
      "a* ".repeat(300_000), // every position a closer with no opener
      "a**b`c_d ".repeat(100_000), // mixed markers, all three characters
      "> ".repeat(200_000), // line-lead alternation
      "- x\n".repeat(200_000),
    ];
    for (const s of cases) {
      const t = Date.now();
      normalise(s);
      expect(Date.now() - t).toBeLessThan(2000);
    }
    // A citation of nothing but markers still normalises to nothing, so it can never clear
    // MIN_QUOTE: OPEN/CLOSE leave the run alone, and the edge strip removes it.
    expect(normalise("*".repeat(100_000))).toBe("");
  });
});

// ======================================================================================
// 8. TS/PY parity — the serving path and the eval must be the same function
// ======================================================================================
describe("parity with brain/tools/eval/verify_citation.py", () => {
  // was: measured with the harness in scratchpad/{gen_cases,ts_side,py_side,diff}.mjs|py,
  // 9 of 56 shared inputs got a different verdict. Python's `\s` matches U+001C-U+001F and
  // U+0085; JS's does not. JS's `\s` matches U+FEFF; Python's does not. The eval therefore
  // did not measure the function cortex ships.
  // now: both sides pin the same explicit SPACE class and delete the same ZERO_WIDTH set, so
  // the divergences below are asserted as CLOSED. tests/verify-parity.test.ts runs the live
  // differential against the Python module when the clone is present; these are the specific
  // characters the audit found, kept here so they cannot regress silently.

  it("OK: U+FEFF — both sides delete it, so neither verifies a BOM-split word", () => {
    // The dangerous direction, now closed: production was MORE permissive than the thing that
    // scores it. python3 -c 'from verify_citation import normalise; print(normalise("a﻿b"))'
    // -> "ab", and JS agrees.
    expect(verifyQuote("Production is still dark", "Production is" + BOM + "still dark").verified).toBe(false);
    expect(normalise("a" + BOM + "b")).toBe("ab");
  });

  it("OK: U+001C-U+001F stay literal and U+0085 folds — the same way in both languages", () => {
    // Python's `\s` matches all five; JS's matches none. Neither side uses `\s` any more: the
    // pinned class contains U+0085 and not U+001C-U+001F, so the eval and the server now
    // agree on every one of them.
    for (const cp of ["", "", "", ""]) {
      expect(verifyQuote("Production is still dark", `Production is${cp}still dark`).verified).toBe(false);
      expect(normalise(`Production is${cp}still dark`)).toContain(cp);
    }
    expect(verifyQuote("Production is still dark", "Production isstill dark").verified).toBe(true);
    expect(normalise("Production isstill dark")).toBe("Production is still dark");
  });

  it("OK: a leading BOM is deleted before trimming, so both sides produce the same normal form", () => {
    // was: JS `\s` included U+FEFF so `.trim()` removed it, while Python's `str.strip()` did
    // not, because "﻿".isspace() is False — same file, two different normal forms.
    // now: ZERO_WIDTH deletion runs first on both sides, so `.trim()`/`.strip()` never sees
    // it and the mechanism no longer matters.
    expect(normalise(BOM + "Production is still dark")).toBe("Production is still dark");
    expect(normalise("Production is still dark" + BOM)).toBe("Production is still dark");
  });

  it("BUG: the two implementations still do not agree on what the corpus IS", () => {
    // lib/corpus.ts excludes .git/, tools/, archive/, brain-v2/, .github/, README.md,
    // INDEX.md and brain-index.md — 77 live .md files. verify_citation.py has no filter at
    // all: it resolves (root / path) and verifies against anything under the brain root that
    // reads as UTF-8, including archived (superseded) notes and its own source file.
    //
    // Unchanged by the normalisation work, and re-measured on 2026-07-27: `./projects/beacon.md`
    // and `Projects/Beacon.md` (APFS is case-insensitive) both VERIFY in Python and fail here,
    // and so does `tools/eval/verify_citation.py` quoting its own docstring. The eval can
    // therefore score a citation to a file cortex would never have served.
    const files = new Map([["projects/beacon.md", "Production is still dark"]]);
    expect(checkCitation(files, SHA, "archive/memory-2026-07/dir5--beacon-slop-check-poc.md", "Production is still dark").verified)
      .toBe(false);
    expect(checkCitation(files, SHA, "./projects/beacon.md", "Production is still dark").verified).toBe(false);
    expect(checkCitation(files, SHA, "tools/eval/verify_citation.py", "deterministic proof that a cited quote").verified)
      .toBe(false);
  });

  it("BUG: the two implementations report a superseded match with different reason strings", () => {
    // Python returns (True, "superseded (the passage is marked retracted or corrected)") —
    // one string that replaces "exact"/"normalised". TypeScript keeps the match quality in
    // `reason` and puts the retraction in a separate `superseded` flag. The BOOLEAN agrees,
    // which is what the differential harness compares, so this is invisible to it; but the
    // eval cannot tell an exact match from a normalised one on any retracted passage, and it
    // has no field corresponding to `superseded` on a non-retracted one.
    const v = verifyQuote(BEACON_BEACON, "Daily Beacon Check live in production at https://beacon-demo");
    expect(v.verified).toBe(true);
    expect(v.reason).toBe("exact");
    expect(v.superseded).toBe(true);
    expect(v.reason).not.toMatch(/superseded/i);
  });

  it("OK: the shared folds agree — dashes, curly quotes, NBSP, markdown wrappers, case", () => {
    expect(verifyQuote("still open — confirmed 2026-07-25", "still open -- confirmed 2026-07-25").verified).toBe(true);
    expect(verifyQuote("Obelyth/beacon’s config.yml is dirty", "Obelyth/beacon's config.yml is dirty").verified).toBe(true);
    expect(verifyQuote("it said “still to be created” now", 'it said "still to be created" now').verified).toBe(true);
    expect(verifyQuote("**Production is still dark**", "Production is still dark").verified).toBe(true);
    expect(verifyQuote("the tab is named By Lane today", "named By lane today").verified).toBe(false);
  });
});

// ======================================================================================
// 9. The same findings against the real clone, when one is present
// ======================================================================================
// Guarded declaration, NOT describe.skipIf — skipIf skips the tests but still runs this
// callback, so the corpus walk below fires on a machine with no clone and throws ENOENT
// before a single test is collected. tests/recall-parity.test.ts documents the same trap.
// The else-branch keeps the absence visible instead of shrinking the total silently.
if (!haveBrain) {
  describe.skip("live brain corpus", () => {
    it(`SKIPPED: needs a brain clone at ${BRAIN} — set BRAIN_DIR to override`, () => {});
  });
}

if (haveBrain) describe("live brain corpus", () => {
  const SKIP_PREFIX = [".git/", "tools/", "archive/", "brain-v2/", ".github/"];
  const SKIP_NAME = ["brain-index.md", "INDEX.md", "README.md"];
  const isLive = (p: string) =>
    p.endsWith(".md") && !SKIP_PREFIX.some((s) => p.startsWith(s)) && !SKIP_NAME.includes(p.split("/").pop() ?? "");

  function walk(dir: string, base = ""): string[] {
    return fs.readdirSync(path.join(dir, base), { withFileTypes: true }).flatMap((e) => {
      const rel = base ? `${base}/${e.name}` : e.name;
      return e.isDirectory() ? walk(dir, rel) : [rel];
    });
  }
  const files = new Map<string, string>();
  for (const rel of walk(BRAIN)) if (isLive(rel)) files.set(rel, fs.readFileSync(path.join(BRAIN, rel), "utf8"));


  it("OK: honest whole-block quotes all still verify — the tightening is not over-tight", () => {
    // The counterweight to everything above. Block scoping and positional stripping only earn
    // their keep if the quotes a truthful reader actually produces still pass. Every block of
    // every live note, quoted verbatim, must verify against its own file.
    const failures: string[] = [];
    let checked = 0;
    for (const [p, text] of files) {
      for (const b of splitBlocks(text)) {
        if (normalise(b.text).length < MIN_QUOTE) continue;
        checked++;
        const v = verifyQuote(text, b.text.trim());
        if (!v.verified) failures.push(`${p}:${b.line} — ${v.reason}`);
      }
    }
    expect(checked).toBeGreaterThan(1000); // 1098 on the 2026-07-27 corpus
    expect(failures).toEqual([]);
  }, WHOLE_CORPUS_TIMEOUT_MS);

  it("OK: dropping the markdown still verifies for all but the asterisk-globs", () => {
    // The fold that matters, measured on the real corpus. For every block containing a
    // `**...**` or backtick span, render it the way a reader quoting the prose would — markers
    // dropped — and check it still verifies.
    const plainOf = (s: string) => s.replace(/\*\*([^*\n]+?)\*\*/g, "$1").replace(/`([^`\n]+?)`/g, "$1");
    let withMarkdown = 0;
    let refused = 0;
    for (const [, text] of files) {
      for (const b of splitBlocks(text)) {
        const plain = plainOf(b.text).trim();
        if (plain === b.text.trim()) continue;
        if (normalise(plain).length < MIN_QUOTE) continue;
        withMarkdown++;
        if (!verifyQuote(text, plain).verified) refused++;
      }
    }
    expect(withMarkdown).toBeGreaterThan(500); // 731
    // was: 259 of 727 refused. Now single digits, and every remaining one is an asterisk-glob
    // where dropping the marker genuinely changes the path (`agents/*.md` -> `agents/.md`).
    expect(refused).toBeLessThan(20);
    // A whole-corpus walk like its siblings at line 942 and 1022, so it carries their timeout.
    // Left on the 5s default it crossed the line as the brain grew — 5067ms in CI on 2026-08-24,
    // reddening every PR on a check that was slow, not broken.
  }, WHOLE_CORPUS_TIMEOUT_MS);

  it("BUG: 12 normalised characters do not identify a file", () => {
    // How weak the guard is, on the real corpus: a 12-char quote that verifies in a third
    // of the brain is not evidence about any one note. Unchanged — 33 of 77 before and after.
    const hits = [...files.values()].filter((t) => verifyQuote(t, "on 2026-07-2").verified).length;
    expect(files.size).toBeGreaterThan(50);
    expect(hits).toBeGreaterThan(files.size / 4);
  });

  it("OK: no markdown heading merges into the text below it — all 192 are refused", () => {
    // was: measured at 192 on the 2026-07-27 corpus. Each one is a sentence that exists on no
    // line of any file and that the verifier called verbatim.
    // now: zero verify, and the same 192 spans come back with the boundary reason rather than
    // "NOT FOUND", so the refusal explains itself instead of looking like a missing file.
    let merges = 0;
    let refusedAtBoundary = 0;
    for (const [, text] of files) {
      const lines = text.split("\n");
      // A `# comment` inside a fenced code block is shell, not a markdown heading — and the
      // fence interior is deliberately ONE verifier block, so such a span verifying is the
      // verifier working, not a merge. Live: the mac-lockout note's rescue script turned this
      // gate red on three bash comments.
      let inFence = false;
      for (let i = 0; i < lines.length - 1; i++) {
        if (/^(```|~~~)/.test(lines[i])) inFence = !inFence;
        if (inFence) continue;
        if (!/^#{1,6}\s/.test(lines[i])) continue;
        let j = i + 1;
        while (j < lines.length && lines[j].trim() === "") j++;
        if (j >= lines.length) continue;
        // The next line has to contribute WORDS, or there is no "text below it" to merge with.
        // A heading followed by a code fence normalises to the heading alone, and a heading that
        // verifies against its own line is the verifier working, not a merge — the case this
        // test exists to catch is a span that exists on NO line and comes back verbatim anyway.
        // Live: a `## Architecture` heading opening straight onto a fenced diagram turned the
        // whole gate red while nothing had merged.
        if (normalise(lines[j]) === "") continue;
        const span = `${normalise(lines[i])} ${normalise(lines[j]).split(" ").slice(0, 6).join(" ")}`;
        if (normalise(span).length < MIN_QUOTE) continue;
        const v = verifyQuote(text, span);
        if (v.verified) merges++;
        else if (v.reason.startsWith("spans a paragraph")) refusedAtBoundary++;
      }
    }
    expect(merges).toBe(0);
    expect(refusedAtBoundary).toBeGreaterThan(100); // 192
    // Whole-corpus walk — same timeout as its siblings, so it is not the next 5s casualty the
    // way the markdown-drop test above became (4246ms and climbing on 2026-08-24).
  }, WHOLE_CORPUS_TIMEOUT_MS);

  it("OK: no quote can be welded across a block boundary anywhere in the brain", () => {
    // The general form of the ~80,000-span measurement that motivated block scoping: take the
    // tail of every block and the head of the next, and try to cite the join. 1085 such spans
    // are long enough to test on the 2026-07-27 corpus; none of them verifies, and 1003 name
    // the boundary as the reason (the remaining 82 no longer match the file at all, because
    // a heading or list marker was involved).
    let attempted = 0;
    let verified = 0;
    for (const [, text] of files) {
      const blocks = splitBlocks(text);
      for (let i = 0; i < blocks.length - 1; i++) {
        const a = normalise(blocks[i].text).split(" ");
        const b = normalise(blocks[i + 1].text).split(" ");
        const span = `${a.slice(-6).join(" ")} ${b.slice(0, 6).join(" ")}`;
        if (normalise(span).length < MIN_QUOTE) continue;
        attempted++;
        if (verifyQuote(text, span).verified) verified++;
      }
    }
    expect(attempted).toBeGreaterThan(500); // 1085
    expect(verified).toBe(0);
  }, WHOLE_CORPUS_TIMEOUT_MS);

  it("OK: the brain keeps superseded wording verbatim, and all of it comes back flagged", () => {
    // was: 15 `(was: "…")` landmines on the 2026-07-27 corpus, every one a genuine substring
    // that verified clean, because the house style keeps the old wording so the correction is
    // auditable.
    // now: still verified — the text is really there — and all 15 carry `superseded`.
    let landmines = 0;
    for (const [p, text] of files) {
      for (const m of text.matchAll(/\(was:\s*"([^"]{12,200})"/g)) {
        // The verifier's own floor: quotes under MIN_QUOTE normalized chars are refused as
        // "too short to prove" BY DESIGN, so the house style can't demand proof of them.
        // (Found live: `(was: "**40 all-time**")` normalizes to 11 chars and verifies false.)
        if (normalise(m[1]).length < MIN_QUOTE) continue;
        expect(verifyQuote(text, m[1]), `${p} :: ${m[1]}`).toMatchObject({ verified: true, superseded: true });
        landmines++;
      }
    }
    expect(landmines).toBeGreaterThan(10); // 15 on the 2026-07-27 corpus
  });
});
