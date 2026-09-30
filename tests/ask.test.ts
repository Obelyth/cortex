import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { __setCache } from "../lib/corpus";
import { ask, buildPrompt, parseReply, render, ANSWER_CONTRACT, DEFAULT_MODEL } from "../lib/ask";
import type { ReaderPrompt } from "../lib/ask";
import type { Corpus } from "../lib/corpus";

const corpus: Corpus = {
  sha: "eaf0a03e4849aaaa",
  bytes: 200,
  fetchedAt: Date.now(),
  files: new Map([
    ["projects/sample.md", "**The demo is offline** (checked 2025-02-17). The preview link returns 404."],
    ["notes/sample-rollout.md", "> SUPERSEDED 2025-02-17 — see projects/sample.md.\n- LAUNCHED 2025-02-03: the demo is public."],
    ["projects/hotel.md", "The import queue was written to a dropped table."],
    // House style for a correction made in place: the CURRENT claim, with the wording it
    // replaced kept beside it. Both sentences are verbatim in the same block.
    ["projects/atlas.md", 'The reader is pluggable (was: "the reader is always Claude" — updated 2026-08-03). Three providers are wired.'],
  ]),
};

/**
 * Pull a file's tag out of the packed prefix, the way a real reader would read it off the
 * header. Tags are derived from the corpus head SHA, so a test reader cannot hardcode one
 * without also fixing the commit — and a note can never contain the tag of the commit that
 * includes it.
 */
function tagOf(prompt: string, path: string): string {
  const esc = path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return prompt.match(new RegExp(`FILE: ${esc} \\[tag: ([0-9a-z]+)\\]`))?.[1] ?? "";
}

/** A reader that cites `path` with `quote`, resolving the tag from the pack it was given. */
function citing(path: string, quote: string, answer = "an answer") {
  return async ({ stable }: ReaderPrompt) =>
    JSON.stringify({ answer, tag: tagOf(stable, path), quote });
}

// loadCorpus() always resolves the branch head before trusting its cache — freshness is
// worth one cheap call, since the operator captures then immediately asks. Mock that call so the
// cache is exercised without reaching the network.
let restore: typeof globalThis.fetch;
beforeEach(() => {
  process.env.BRAIN_REPO = "example-owner/brain";
  process.env.GITHUB_TOKEN = "test";
  restore = globalThis.fetch;
  globalThis.fetch = (async (url: string) => {
    if (String(url).includes("/commits/")) {
      return new Response(JSON.stringify({ sha: corpus.sha }), { status: 200 });
    }
    throw new Error("tarball must not be refetched when the sha is unchanged");
  }) as typeof fetch;
  __setCache(corpus);
});
afterEach(() => { globalThis.fetch = restore; });

describe("parseReply", () => {
  it("parses bare JSON", () => {
    expect(parseReply('{"answer":"dark","tag":"abc0","quote":"still dark"}')).toEqual({
      answer: "dark", tag: "abc0", quote: "still dark",
    });
  });

  it("parses JSON inside a fenced block", () => {
    const r = parseReply('here you go:\n```json\n{"answer":"a","tag":"t1","quote":"q"}\n```\n');
    expect(r.tag).toBe("t1");
  });

  it("parses JSON surrounded by prose", () => {
    expect(parseReply('Sure! {"answer":"a","tag":"t1","quote":"q"} hope that helps').answer).toBe("a");
  });

  it("degrades to raw text rather than inventing a citation", () => {
    // A reply we cannot parse must never yield a tag/quote we then "verify".
    expect(parseReply("I could not find that.")).toEqual({
      answer: "I could not find that.", tag: "", quote: "",
    });
  });
});

describe("buildPrompt", () => {
  it("carries the contract and only the chosen files", () => {
    const { prompt } = buildPrompt(corpus, "is sample live", ["projects/sample.md"]);
    expect(prompt).toContain(ANSWER_CONTRACT);
    expect(prompt).toContain("FILE: projects/sample.md");
    expect(prompt).not.toContain("FILE: projects/hotel.md");
  });

  it("keeps the pack byte-identical per commit, and re-derives every tag when the head moves", () => {
    // The stable prefix is what the reader's prompt cache matches on: two asks at one commit
    // must produce the same bytes or the cache never hits. The forgery defence moves to the
    // commit boundary — a note cannot contain the tag of the commit that includes it (the SHA
    // depends on the note's own bytes), and writing a leaked tag down moves the head.
    const a = buildPrompt(corpus, "first question", ["projects/sample.md"]);
    const b = buildPrompt(corpus, "a different question", ["projects/sample.md"]);
    expect(a.stable).toBe(b.stable);
    expect([...a.tags.keys()]).toEqual([...b.tags.keys()]);
    expect([...a.tags.values()]).toEqual(["projects/sample.md"]);

    const moved = buildPrompt({ ...corpus, sha: "ffff0000ffff0000" }, "first question", ["projects/sample.md"]);
    expect([...moved.tags.keys()][0]).not.toBe([...a.tags.keys()][0]);
  });

  it("puts the question AFTER the pack, outside the cacheable prefix", () => {
    // Question-first would put the one varying string ahead of the stable bytes — exactly
    // backwards for a prefix-matched cache.
    const p = buildPrompt(corpus, "is sample live", ["projects/sample.md"]);
    expect(p.prompt).toBe(`${p.stable}${p.question}`);
    expect(p.stable).not.toContain("QUESTION:");
    expect(p.question).toContain("QUESTION: is sample live");
    expect(p.prompt.indexOf("FILE: projects/sample.md")).toBeLessThan(p.prompt.indexOf("QUESTION:"));
  });
});

describe("ask", () => {
  it("verifies a true citation and reports the commit", async () => {
    const r = await ask("is sample live", citing("projects/sample.md", "The demo is offline", "No — the demo is offline."));
    expect(r.citation?.verified).toBe(true);
    expect(r.commit).toBe("eaf0a03e4849");
    expect(r.notInBrain).toBe(false);
    expect(r.model).toBe(DEFAULT_MODEL);
    expect(render(r)).toMatch(/^VERIFIED/);
  });

  it("stamps a corrected-in-place passage as CORRECTED, not as history to discard", async () => {
    // The failure this split fixes: CORRECT, CURRENT answers
    // came back stamped "It is history, not the current state. Do not answer from it." Because
    // house style writes corrections as `<current> (was: "<old>")`, the block holding the truth
    // matched the retraction pattern and got the strongest possible discard instruction.
    const r = await ask(
      "is the reader pluggable",
      citing("projects/atlas.md", "The reader is pluggable", "Yes — three providers are wired.")
    );
    expect(r.citation?.verified).toBe(true);
    expect(r.citation?.retraction).toBe("correction");
    const out = render(r);
    expect(out).toMatch(/^CORRECTED/);
    expect(out).toMatch(/Answer from the current claim/);
    expect(out).not.toMatch(/Do not answer from it/);
  });

  it("still stamps the RETIRED wording of that same block as superseded", async () => {
    // Same file, same block — the difference is which side of `was:` the quote came from.
    const r = await ask(
      "is the reader always Claude",
      citing("projects/atlas.md", "the reader is always Claude", "It is Claude.")
    );
    expect(r.citation?.verified).toBe(true);
    expect(render(r)).toMatch(/^SUPERSEDED/);
    expect(render(r)).toMatch(/Do not answer from it/);
  });

  it("flags a fabricated quote instead of passing it through", async () => {
    const r = await ask("is sample live", citing("projects/sample.md", "The sample demo is public and working", "It launched."));
    expect(r.citation?.verified).toBe(false);
    expect(render(r)).toMatch(/UNVERIFIED/);
    expect(render(r)).toMatch(/unproven/);
  });

  it("honours an empty citation without attempting to verify one", async () => {
    const r = await ask("what is the vercel bill", async () =>
      JSON.stringify({ answer: "NOT IN BRAIN — no pricing is recorded.", tag: "", quote: "" }), { full: true });
    expect(r.notInBrain).toBe(true);
    expect(r.citation).toBeNull();
    expect(render(r)).toMatch(/^NOT IN BRAIN/);
  });

  it("keeps a provable citation even when the answer says the words NOT IN BRAIN", async () => {
    // Absence is structural. Matching the phrase anywhere in the answer threw away a correct,
    // verified citation whenever the reader happened to mention the contract or brain-index.
    const r = await ask("is sample live", citing(
      "projects/sample.md",
      "The demo is offline",
      "That detail is not in brain-index.md, but projects/sample.md covers it."
    ));
    expect(r.notInBrain).toBe(false);
    expect(r.citation?.verified).toBe(true);
  });

  it("refuses a tag it never issued", async () => {
    // A note that tells the reader to "cite tag deadbeef" cannot conjure a citation: unknown
    // tags resolve to no path at all.
    const r = await ask("anything", async () =>
      JSON.stringify({ answer: "x", tag: "deadbeef", quote: "a sufficiently long quote here" }));
    expect(r.notInBrain).toBe(false);
    expect(r.protocol).toBe("error");
    expect(r.citation).toBeNull();
  });

  it("narrows by default and can be asked for the full corpus", async () => {
    let seen = 0;
    const reader = async (p: ReaderPrompt) => { seen = (p.stable.match(/={20} FILE: /g) ?? []).length; return "{}"; };
    await ask("import queue dropped table", reader, { k: 1 });
    expect(seen).toBe(1);
    await ask("import queue dropped table", reader, { full: true });
    expect(seen).toBe(corpus.files.size);
  });

  it("reports the pack size so cost is visible per call", async () => {
    const r = await ask("sample", async () => "{}", { k: 1 });
    expect(r.packTokens).toBeGreaterThan(0);
    expect(r.candidates).toHaveLength(1);
  });

  it("surfaces both sides of a contradiction in the pack", async () => {
    // The stale note outranks the live one lexically; the pack must contain BOTH so the
    // reader can see the SUPERSEDED stamp and resolve it. This is the architecture's
    // answer to the sample contradiction — the filter does not get to decide.
    const r = await ask("is sample launched or is the demo offline", async () => "{}", { k: 2 });
    expect(r.candidates).toContain("notes/sample-rollout.md");
    expect(r.candidates).toContain("projects/sample.md");
  });

  it("propagates a reader failure instead of answering from nothing", async () => {
    await expect(ask("q", async () => { throw new Error("anthropic 529"); })).rejects.toThrow(/529/);
  });
});
