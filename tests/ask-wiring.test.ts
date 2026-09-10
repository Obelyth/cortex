/**
 * What `ask()` actually REQUESTS — the wiring, not the library.
 *
 * tests/narrow.test.ts proves `narrow()` honours `maxLogs`, `budgetBytes` and `maxPartsPerPage`
 * when it is handed them. Nothing proved the production caller hands them over. Measured by
 * mutation against the full suite (2026-09-03, BRAIN_DIR=brain-work, 1111 tests):
 *
 *   lib/ask.ts — delete both caps from the narrow() call   1111/1111 still passed
 *   lib/ask.ts — DEFAULT_K 15 → 10                          1111/1111 still passed
 *
 * So the two headline behaviours of this branch, and the k change measured beside them, were
 * unguarded: a refactor that dropped the opts object would have left every test green and every
 * number in the README wrong. The log cap (task 3) was the one properly pinned, and this file is
 * that shape applied to the other two.
 *
 * These assertions are deliberately on the OUTPUT of `ask()` — the candidate pack a reader is
 * actually handed — not on narrow() called with explicit parameters, because "narrow honours what
 * it is given" is exactly the claim that stayed true while the wiring was gone.
 *
 * Synthetic corpus only: `harbor` is the house placeholder, and the export gate forbids naming a
 * real note here.
 */
import { describe, expect, it } from "vitest";
import { ask, DEFAULT_K, NARROW_BUDGET_BYTES, DEFAULT_MAX_PARTS_PER_PAGE } from "../lib/ask";
import type { Corpus } from "../lib/corpus";

/** The reply is irrelevant here: every assertion is about the pack that went IN. */
const silent = async () => JSON.stringify({ answer: "", tag: "", quote: "" });

function corpusOf(entries: Array<[string, string]>): Corpus {
  const files = new Map(entries);
  let bytes = 0;
  for (const [, t] of files) bytes += Buffer.byteLength(t, "utf8");
  return { files, sha: "abc0123456789def", bytes, fetchedAt: Date.now() };
}

/** `n` bytes of ASCII that all score on "harbor", so ranking never decides the outcome. */
function note(seed: string, bytes: number): string {
  return `harbor ${seed} `.padEnd(bytes, "x").slice(0, bytes);
}

/**
 * Ten notes of 30,000 three-byte characters — 90,000 real bytes each, 30,000 code units each.
 * Under a 400,000-byte budget the fourth note is the last that fits; a code-unit count sees
 * 150,000 for the whole corpus and packs all ten. Used by both budgets, which is the point: they
 * are the same defect one function apart.
 */
function wideCorpus(): Corpus {
  const wide = "…".repeat(30_000);
  return corpusOf(Array.from({ length: 10 }, (_, i) => [`notes/harbor-${i}.md`, `harbor n${i} ${wide}`] as [string, string]));
}

describe("the constants ask() ships with", () => {
  // Pinned as literals on purpose. Each of these is a MEASURED choice quoted in README.md's
  // Retrieval section, so changing one means re-running scripts/eval-retrieval.ts and re-quoting
  // that section — this test is the reminder, and a green suite after a silent edit is the
  // failure it exists to prevent.
  it("is k=15, a 400 KB narrow budget and 2 history parts per source page", () => {
    expect(DEFAULT_K).toBe(15);
    expect(NARROW_BUDGET_BYTES).toBe(400_000);
    expect(DEFAULT_MAX_PARTS_PER_PAGE).toBe(2);
  });
});

describe("ask() asks for what production measured", () => {
  it("requests DEFAULT_K candidates when the caller names no k", async () => {
    // 20 small notes, all scoring, none large enough for the budget to reach: the only thing
    // that can decide the pack size is the k the caller passed.
    const corpus = corpusOf(Array.from({ length: 20 }, (_, i) => [`notes/harbor-${i}.md`, note(`n${i}`, 200)] as [string, string]));
    const res = await ask("harbor", silent, { corpus });
    expect(res.candidates).toHaveLength(15);
    expect(res.candidates).toHaveLength(DEFAULT_K);
  });

  it("passes maxPartsPerPage, so one page's history parts cannot flood the pack", async () => {
    // Four parts of ONE source page plus one part of another and four ordinary notes — nine
    // scoring notes against k=15, so nothing but the cap can keep a part out.
    const corpus = corpusOf([
      ["history/harbor-2026-06.md", note("june", 200)],
      ["history/harbor-2026-07.md", note("july", 200)],
      ["history/harbor-2026-08.md", note("august", 200)],
      ["history/harbor-2026-08-2.md", note("august two", 200)],
      ["history/dock-2026-08.md", note("dock", 200)],
      ...Array.from({ length: 4 }, (_, i) => [`notes/harbor-${i}.md`, note(`n${i}`, 200)] as [string, string]),
    ]);
    const res = await ask("harbor", silent, { corpus });
    expect(res.candidates.filter((p) => p.startsWith("history/harbor-"))).toHaveLength(DEFAULT_MAX_PARTS_PER_PAGE);
    // The cap, not a coincidence of ranking: every other scoring note is still there, and the
    // freed slots were filled from them rather than left empty or padded.
    expect(res.candidates).toContain("history/dock-2026-08.md");
    expect(res.candidates).toHaveLength(7);
  });

  it("passes budgetBytes, so a pack of large notes stops short of k", async () => {
    // Twenty 60,000-byte notes, all scoring. Under the 400,000-byte budget the pack stops after
    // six (the seventh would take the running total to 420,000); with no budget wired it would be
    // all fifteen k asked for.
    const corpus = corpusOf(Array.from({ length: 20 }, (_, i) => [`notes/harbor-${i}.md`, note(`n${i}`, 60_000)] as [string, string]));
    const res = await ask("harbor", silent, { corpus });
    expect(res.candidates).toHaveLength(6);
    expect(res.candidates.length).toBeLessThan(DEFAULT_K);
    let packed = 0;
    for (const p of res.candidates) packed += Buffer.byteLength(corpus.files.get(p) ?? "", "utf8");
    expect(packed).toBeLessThanOrEqual(NARROW_BUDGET_BYTES);
  });

  it("counts the budget in real bytes, not UTF-16 code units", async () => {
    // Every note is 3-byte characters, so `.length` reads a third of the truth. Ten notes of
    // 30,000 characters = 90,000 bytes each: the budget must stop at four (five would be
    // 450,000 B), where a code-unit count would see 150,000 and pack all ten.
    const res = await ask("harbor", silent, { corpus: wideCorpus() });
    expect(res.candidates).toHaveLength(4);
  });
});

describe("the full-read path budgets in the same units", () => {
  // FULL_BUDGET_BYTES is the narrow budget's twin one function away, and it had the identical
  // defect: `String.length` accumulated against a ceiling whose entire justification is a token
  // count. It happens not to overshoot on today's corpora — the live brain's full pack was
  // 396,647 code units of 399,274 real bytes, inside the 400,000 ceiling by 726 bytes — which is
  // precisely why it needs a test rather than a measurement: nothing about the corpus guarantees
  // that margin tomorrow, and a budget that is right by luck is not a budget.
  it("stops the full pack on real bytes", async () => {
    const res = await ask("harbor", silent, { corpus: wideCorpus(), full: true });
    expect(res.candidates).toHaveLength(4);
  });

  it("omits a first note that alone exceeds the budget", async () => {
    const corpus = corpusOf([["notes/harbor-0.md", "…".repeat(200_000)]]);
    const res = await ask("harbor", silent, { corpus, full: true });
    expect(res.candidates).toHaveLength(0);
  });
});
