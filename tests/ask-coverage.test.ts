import { describe, expect, it } from "vitest";
import { ask, render, NARROW_BUDGET_BYTES } from "../lib/ask";
import type { ReaderPrompt } from "../lib/ask";
import type { Corpus } from "../lib/corpus";

/**
 * What an abstention is worth depends on what was searched, and the default path never reads
 * the whole brain. These pin the rule that decides NOT IN BRAIN on a narrowed pack — complete
 * FOR THE QUESTION: every note that carries a word of it was read — and the two honest
 * neighbours of that verdict: a partial search that names what it left unread, and a pack
 * that held nothing, which never reaches a model at all.
 */

const corpusOf = (entries: Array<[string, string]>): Corpus =>
  ({ files: new Map(entries), sha: "b".repeat(40), bytes: 0, fetchedAt: 0 });
const abstain = async () => JSON.stringify({ answer: "NOT IN BRAIN", tag: "", quote: "" });
const dark = "Beacon production is still dark.";

describe("NOT IN BRAIN on a narrowed search", () => {
  it("is the verdict when every unread note scored nothing for the question", async () => {
    const corpus = corpusOf([
      ["projects/beacon.md", dark],
      ["notes/beacon-rollout.md", "Beacon rollout notes: nothing on pricing."],
      ["projects/harbor.md", "The plates backlog went into a deleted database."],
    ]);
    let prompt = "";
    const r = await ask("what does beacon cost", async (p: ReaderPrompt) => { prompt = p.stable; return abstain(); }, { corpus, k: 2 });
    expect([...r.candidates].sort()).toEqual(["notes/beacon-rollout.md", "projects/beacon.md"]);
    expect(r).toMatchObject({
      protocol: "abstention", notInBrain: true,
      coverage: { selectedNotes: 2, totalNotes: 3, omittedNotes: 1, unreadMatched: 0, complete: true, reason: "retrieval" },
    });
    // The reader and the operator are told the same thing about what was left out.
    expect(prompt).toContain("1 omitted by retrieval");
    expect(prompt).toContain("No unread note contains any word of the question");
    const out = render(r);
    expect(out).toMatch(/^NOT IN BRAIN/);
    expect(out).toContain("Coverage: 2 of 3 scoped notes searched; 1 omitted by retrieval; no unread note contains any word of the question.");
  });

  it("stays a partial search while an unread note still contains a word of the question", async () => {
    const corpus = corpusOf([["projects/beacon.md", dark], ["notes/beacon-rollout.md", "Beacon rollout, part two."]]);
    let prompt = "";
    const r = await ask("beacon", async (p: ReaderPrompt) => { prompt = p.stable; return abstain(); }, { corpus, k: 1 });
    expect(r).toMatchObject({ protocol: "abstention", notInBrain: false, coverage: { omittedNotes: 1, unreadMatched: 1, complete: false, reason: "retrieval" } });
    expect(prompt).toContain("This is a partial search: 1 unread note contains words of the question.");
    expect(render(r)).toMatch(/^UNVERIFIED — partial search: not found in the searched material; 1 unread note contains words of the question/);
    expect(render(r)).toContain("1 omitted by retrieval; 1 unread note contains words of the question.");
  });

  it("names the budget, not retrieval, when a note carrying the question's words was refused for its size", async () => {
    const oversized = "beacon ".repeat(Math.ceil(NARROW_BUDGET_BYTES / 7) + 10);
    const corpus = corpusOf([["projects/beacon.md", dark], ["history/beacon-2026-08.md", oversized]]);
    const r = await ask("beacon", abstain, { corpus });
    expect(r.candidates).toEqual(["projects/beacon.md"]);
    expect(r.cut).toEqual([{ path: "history/beacon-2026-08.md", score: expect.any(Number), by: "budget" }]);
    expect(r.coverage).toMatchObject({ omittedNotes: 1, unreadMatched: 1, complete: false, reason: "budget" });
    expect(render(r)).toContain("1 omitted by budget; 1 unread note contains words of the question.");
  });

  it("a question whose words occur in no note is complete once its fallback pack abstains", async () => {
    // Fallback packs the largest notes; nothing scored, so nothing unread scored either.
    const corpus = corpusOf([["projects/beacon.md", dark], ["projects/harbor.md", "The plates backlog went into a deleted database."]]);
    const r = await ask("zxqv wqrp", abstain, { corpus, k: 1 });
    expect(r.narrowing.mode).toBe("fallback");
    expect(r).toMatchObject({ notInBrain: true, coverage: { omittedNotes: 1, unreadMatched: 0, complete: true } });
    expect(render(r)).toMatch(/^NOT IN BRAIN/);
  });

  it("a question that tokenizes to nothing ranked nobody, so its omissions stay unknown", async () => {
    const corpus = corpusOf([["projects/beacon.md", dark], ["projects/harbor.md", "The plates backlog went into a deleted database."]]);
    const r = await ask("???", abstain, { corpus, k: 1 });
    expect(r.narrowing.mode).toBe("fallback");
    expect(r).toMatchObject({ notInBrain: false, coverage: { omittedNotes: 1, unreadMatched: null, complete: false } });
    expect(render(r)).toMatch(/^UNVERIFIED — partial search.*the unread notes were not ranked against the question/);
  });

  it("a full read cannot vouch for what its budget cut, so its omissions stay unknown too", async () => {
    const corpus = corpusOf([["projects/beacon.md", dark], ["notes/big.md", "…".repeat(140_000)]]);
    const r = await ask("beacon", abstain, { corpus, full: true });
    expect(r).toMatchObject({ notInBrain: false, coverage: { omittedNotes: 1, unreadMatched: null, complete: false, reason: "budget" } });
    expect(render(r)).toContain("1 omitted by budget; the unread notes were not ranked against the question.");
  });
});

describe("an empty pack never reaches the reader", () => {
  const oversized = "cortex mirror snapshot ".repeat(20_000); // ~460 KB: admitted by the write path, fits no pack

  it.each([false, true])("a corpus nothing of which fits the budget is UNVERIFIED — nothing was read (full=%s)", async (full) => {
    const corpus = corpusOf([["notes/big.md", oversized]]);
    let calls = 0;
    const r = await ask("cortex mirror snapshot", async () => { calls++; return abstain(); }, { corpus, full });
    expect(calls).toBe(0);
    expect(r).toMatchObject({
      protocol: "unread", notInBrain: false, candidates: [], citation: null,
      coverage: { selectedNotes: 0, totalNotes: 1, omittedNotes: 1, complete: false, reason: "budget", bodyBytes: 0 },
    });
    const out = render(r);
    expect(out).toMatch(/^UNVERIFIED — nothing was read: no note fit within the 400,000-byte budget/);
    expect(out).toContain("Coverage: 0 of 1 scoped notes searched; 1 omitted by budget");
    expect(render(r, { citations: false })).toMatch(/^UNVERIFIED — nothing was read/);
  });

  it("a scope that holds no notes is NOT IN BRAIN without a model call", async () => {
    const corpus = corpusOf([["projects/beacon.md", dark]]);
    let calls = 0;
    const r = await ask("beacon", async () => { calls++; return abstain(); }, { corpus, scope: ["guest/"] });
    expect(calls).toBe(0);
    expect(r).toMatchObject({ protocol: "unread", notInBrain: true, coverage: { selectedNotes: 0, totalNotes: 0, omittedNotes: 0, complete: true, reason: null } });
    expect(render(r)).toMatch(/^NOT IN BRAIN/);
    expect(render(r)).toContain("Coverage: 0 of 0 scoped notes searched; 0 omitted.");
  });
});

describe("the abstention marker is the contract's own shape", () => {
  const corpus = corpusOf([["notes/a.md", "The deploy key lives in the vault."]]);
  const reply = (answer: string) => async () => JSON.stringify({ answer, tag: "", quote: "" });

  it("a positive prose answer that merely says the words in passing is an uncited answer, not absence", async () => {
    // With complete coverage this used to render NOT IN BRAIN and be cached as the brain's verdict.
    const r = await ask("where is the deploy key", reply("The deploy key lives in the vault (this is not in brain-index.md, see notes/a.md)."), { corpus, full: true });
    expect(r).toMatchObject({ protocol: "error", notInBrain: false, coverage: { complete: true } });
    expect(render(r)).toMatch(/^UNVERIFIED — reader protocol error/);
  });

  it.each(["not in brain", "Not In Brain.", "It is NOT IN BRAIN-index.md", "see NOT IN BRAIN-index for details"])("is case-sensitive and stands alone: %s is not an abstention", async (answer) => {
    const r = await ask("where is the deploy key", reply(answer), { corpus, full: true });
    expect(r.protocol).toBe("error");
  });

  it.each(["NOT IN BRAIN", "NOT IN BRAIN — nothing on the deploy key.", "No note covers the deploy key. NOT IN BRAIN.", "Nothing on the deploy key here.\nNOT IN BRAIN", "**NOT IN BRAIN**", "**NOT IN BRAIN** — the notes say nothing on cost.", "The answer is NOT IN BRAIN.", "(NOT IN BRAIN)", "> NOT IN BRAIN", "- NOT IN BRAIN", "Answer: NOT IN BRAIN"])("accepts the marker wherever it stands as a token of its own: %s", async (answer) => {
    const r = await ask("where is the deploy key", reply(answer), { corpus, full: true });
    expect(r).toMatchObject({ protocol: "abstention", notInBrain: true });
    expect(render(r)).toMatch(/^NOT IN BRAIN/);
  });
});
