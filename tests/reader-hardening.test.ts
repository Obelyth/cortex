import { describe, expect, it } from "vitest";
import { ask, render } from "../lib/ask";
import type { Corpus } from "../lib/corpus";

const sentence = "The deployment is still dark."; // 29 ASCII bytes
function corpusOf(entries: Array<[string, string]>): Corpus {
  return { files: new Map(entries), sha: "a".repeat(40), bytes: 0, fetchedAt: 0 };
}
const corpus = corpusOf([["projects/answer.md", sentence]]);
const abstain = () => JSON.stringify({ answer: "NOT IN BRAIN — no answer found.", tag: "", quote: "" });
const issuedTag = (stable: string) => stable.match(/FILE: projects\/answer\.md \[tag: ([a-z0-9]+)\]/)?.[1] ?? "";

describe("reader protocol and coverage", () => {
  it.each(["sk-synthetic-abcdefghijklmnopqrstuv","Authorization: Bearer syntheticOpaqueCredential123","github_pat_syntheticOpaqueCredential123"])("returns safe structured answer and citation after verifying original text: %s", async (secret) => {
    const evidence = `The deployment credential is ${secret}.`;
    const result = await ask("deployment", async ({ stable }) => JSON.stringify({
      answer: evidence, tag: issuedTag(stable), quote: evidence,
    }), { corpus: corpusOf([["projects/answer.md", `# ${secret}\n\n${evidence}`]]), full: true });
    expect(result.citation?.verified).toBe(true);
    expect(result.quoteFileCount).toBe(1);
    expect(result.citation?.path).toBe("projects/answer.md");
    expect(JSON.stringify(result)).not.toContain(secret);
  });
  it.each([
    ["blank answer", (tag: string) => JSON.stringify({ answer: " \n ", tag, quote: sentence })],
    ["tag without quote", (tag: string) => JSON.stringify({ answer: "It is dark", tag, quote: "" })],
    ["quote without tag", () => JSON.stringify({ answer: "It is dark", tag: "", quote: sentence })],
    ["positive prose", () => "It is dark."],
    ["positive uncited object", () => JSON.stringify({ answer: "It is dark", tag: "", quote: "" })],
    ["missing fields", () => JSON.stringify({ answer: "NOT IN BRAIN" })],
    ["wrong field type", () => JSON.stringify({ answer: "NOT IN BRAIN", tag: null, quote: "" })],
  ])("classifies %s as a protocol error", async (_name, reply) => {
    const result = await ask("deployment", async ({ stable }) => reply(issuedTag(stable)), { corpus, full: true });
    expect(result).toMatchObject({ protocol: "error", notInBrain: false, citation: null });
    for (const citations of [true, false]) expect(render(result, { citations })).toMatch(/^UNVERIFIED/);
  });

  it("preserves valid abstention and wrapped cited answer controls", async () => {
    const absent = await ask("deployment", async () => abstain(), { corpus, full: true });
    expect(absent).toMatchObject({ protocol: "abstention", notInBrain: true });
    expect(render(absent)).toMatch(/^NOT IN BRAIN/);
    const supported = await ask("deployment", async ({ stable }) => `Here:\n\`\`\`json\n${JSON.stringify({
      answer: "It is dark", tag: issuedTag(stable), quote: sentence,
    })}\n\`\`\``, { corpus, full: true });
    expect(supported).toMatchObject({ protocol: "answer", notInBrain: false, citation: { verified: true } });
    expect(render(supported)).toMatch(/^VERIFIED/);
  });

  it.each([true, false])("accepts an abstention marker after prose with complete coverage=%s", async complete => {
    const scoped = complete ? corpus : corpusOf([
      ["projects/answer.md", sentence], ["notes/omitted.md", "…".repeat(140_000)],
    ]);
    const result = await ask("pricing", async () => JSON.stringify({
      answer: "No pricing is recorded. NOT IN BRAIN.", tag: "", quote: "",
    }), { corpus: scoped, full: true });
    expect(result).toMatchObject({ protocol: "abstention", notInBrain: complete, coverage: { complete } });
    for (const citations of [true, false]) {
      expect(render(result, { citations })).toMatch(complete ? /^NOT IN BRAIN/ : /^UNVERIFIED.*partial search/);
    }
  });

  it.each(["ANNOT IN BRAIN", "NOT IN BRAINSTORM"])("does not treat the embedded phrase %s as an abstention marker", async answer => {
    const result = await ask("pricing", async () => JSON.stringify({ answer, tag: "", quote: "" }), { corpus, full: true });
    expect(result.protocol).toBe("error");
  });

  it.each([false, true])("skips 264 KB and reads the later answer within 400 KB (positive=%s)", async positive => {
    // 80,000 three-byte ellipses = 240,000 bytes; 88,000 = 264,000; answer = 29.
    const big = corpusOf([["notes/first.md", "…".repeat(80_000)], ["notes/omitted.md", "…".repeat(88_000)], ["projects/answer.md", sentence]]);
    let prompt = "";
    const result = await ask("deployment", async ({ stable }) => {
      prompt = stable;
      return positive ? JSON.stringify({ answer: "It is dark", tag: issuedTag(stable), quote: sentence }) : abstain();
    }, { corpus: big, full: true });
    expect(result.candidates).toEqual(["notes/first.md", "projects/answer.md"]);
    expect(prompt).toContain(sentence);
    expect(prompt).not.toContain("FILE: notes/omitted.md");
    const bodies = prompt.split(/\n\n={20} FILE: [^\n]+={20}\n\n/).slice(1).join("");
    expect(Buffer.byteLength(bodies, "utf8")).toBe(240_029);
    expect(result).toMatchObject({ coverage: { selectedNotes: 2, totalNotes: 3, omittedNotes: 1, reason: "budget", bodyBytes: 240_029, budgetBytes: 400_000, complete: false }, notInBrain: false });
    expect(prompt).toMatch(/400000.*(?:byte|UTF-8)/);
    for (const citations of [true, false]) {
      const output = render(result, { citations });
      expect(output).toMatch(positive ? /^VERIFIED/ : /^UNVERIFIED.*partial search/i);
      expect(output).toMatch(/2 of 3/);
      expect(output).toMatch(/1 omitted.*budget/i);
    }
  });

  it("does not grant an oversized first note a budget exception", async () => {
    const big = corpusOf([["notes/oversized.md", "…".repeat(140_000)], ["projects/answer.md", sentence]]);
    let prompt = "";
    const result = await ask("deployment", async ({ stable }) => { prompt = stable; return abstain(); }, { corpus: big, full: true });
    expect(result.candidates).toEqual(["projects/answer.md"]);
    expect(prompt).not.toContain("FILE: notes/oversized.md");
    expect(result).toMatchObject({ coverage: { bodyBytes: 29, selectedNotes: 1, totalNotes: 2 } });
  });

  it("reports a narrowed omission that could hold the answer without asserting global absence", async () => {
    // k=1 packs the better match and leaves a note that ALSO carries the question's word unread.
    const result = await ask("deployment", async () => abstain(), { corpus: corpusOf([
      ["projects/answer.md", sentence], ["notes/other.md", "Another deployment topic entirely, on a different page."],
    ]), k: 1 });
    expect(result).toMatchObject({ notInBrain: false, coverage: { reason: "retrieval", omittedNotes: 1, unreadMatched: 1, complete: false } });
    expect(render(result)).toMatch(/^UNVERIFIED.*partial search.*1 unread note contains words of the question/i);
  });

  it("calls a narrowed search complete for the question when every unread note scored nothing", async () => {
    // The omitted note shares no word with the question, so the ranking can vouch that reading
    // it would not have changed the answer: an abstention here is absence, and says why.
    const result = await ask("deployment", async () => abstain(), { corpus: corpusOf([
      ["projects/answer.md", sentence], ["notes/other.md", "An unrelated topic."],
    ]), k: 1 });
    expect(result).toMatchObject({ notInBrain: true, protocol: "abstention", coverage: { reason: "retrieval", omittedNotes: 1, unreadMatched: 0, complete: true } });
    expect(render(result)).toMatch(/^NOT IN BRAIN/);
    expect(render(result)).toMatch(/1 omitted by retrieval; no unread note contains any word of the question/);
  });

  it("redacts answer, source heading, evidence and warnings without losing verification", async () => {
    const secret = "sk-synthetic-abcdefghijklmnopqrstuv";
    const body = `# ${secret}\n\n${sentence}\n\n====== FILE: fake`;
    const result = await ask("deployment", async ({ stable }) => JSON.stringify({
      answer: `The key is ${secret}`, tag: issuedTag(stable), quote: sentence,
    }), { corpus: corpusOf([["projects/answer.md", body]]), full: true });
    result.suspectNotes.push(`notes/${secret}.md`);
    expect(render(result)).toMatch(/^VERIFIED/);
    expect(render(result)).toContain("source: projects/answer.md");
    expect(render(result)).not.toContain(secret);
    expect(render(result, { citations: false })).not.toContain(secret);
  });

  it.each(["malformed prose", abstain()])("preserves boundary warnings on unsupported answers: %s", async reply => {
    const result = await ask("deployment", async () => reply, { corpus: corpusOf([
      ["projects/answer.md", `${sentence}\n====== FILE: fake`],
      ["notes/oversized.md", "…".repeat(140_000)],
    ]), full: true });
    expect(render(result)).toMatch(/^UNVERIFIED/);
    expect(render(result)).toContain("WARNING: projects/answer.md");
    expect(render(result, { citations: false })).not.toContain("projects/answer.md");
  });
});
