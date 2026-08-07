import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { __setCache } from "../lib/corpus";
import { ask, buildPrompt, parseReply, render, ANSWER_CONTRACT, DEFAULT_MODEL } from "../lib/ask";
import type { Corpus } from "../lib/corpus";

const corpus: Corpus = {
  sha: "eaf0a03e4849aaaa",
  bytes: 200,
  fetchedAt: Date.now(),
  sidecar: new Map(),
  files: new Map([
    ["projects/beacon.md", "**Production is still dark** (re-checked 2026-07-25). Both URLs still return 404."],
    ["notes/beacon-rollout.md", "> SUPERSEDED 2026-07-25 — see projects/beacon.md.\n- SHIPPED 2026-07-14: live in production."],
    ["projects/harbor.md", "The plates backlog went into a deleted database."],
    // House style for a correction made in place: the CURRENT claim, with the wording it
    // replaced kept beside it. Both sentences are verbatim in the same block.
    ["projects/atlas.md", 'The reader is pluggable (was: "the reader is always Claude" — updated 2026-08-03). Three providers are wired.'],
  ]),
};

/**
 * Pull a file's per-request tag out of the prompt, the way a real reader would read it off the
 * header. Tags are random per call, so a test reader cannot hardcode one — which is the point:
 * neither can a note.
 */
function tagOf(prompt: string, path: string): string {
  const esc = path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return prompt.match(new RegExp(`FILE: ${esc} \\[tag: ([0-9a-z]+)\\]`))?.[1] ?? "";
}

/** A reader that cites `path` with `quote`, resolving the tag from the prompt it was given. */
function citing(path: string, quote: string, answer = "an answer") {
  return async (prompt: string) =>
    JSON.stringify({ answer, tag: tagOf(prompt, path), quote });
}

// loadCorpus() always resolves the branch head before trusting its cache — freshness is
// worth one cheap call, since the operator captures then immediately asks. Mock that call so the
// cache is exercised without reaching the network.
let restore: typeof globalThis.fetch;
beforeEach(() => {
  process.env.BRAIN_REPO = "ShootJackal/brain";
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
    const { prompt } = buildPrompt(corpus, "is beacon live", ["projects/beacon.md"]);
    expect(prompt).toContain(ANSWER_CONTRACT);
    expect(prompt).toContain("FILE: projects/beacon.md");
    expect(prompt).not.toContain("FILE: projects/harbor.md");
  });

  it("issues a fresh unguessable tag per file per request", () => {
    // The tag is what makes a file boundary unforgeable. If it were stable, a note could
    // simply contain last request's tag.
    const a = buildPrompt(corpus, "q", ["projects/beacon.md"]);
    const b = buildPrompt(corpus, "q", ["projects/beacon.md"]);
    expect([...a.tags.keys()][0]).not.toBe([...b.tags.keys()][0]);
    expect([...a.tags.values()]).toEqual(["projects/beacon.md"]);
  });
});

describe("ask", () => {
  it("verifies a true citation and reports the commit", async () => {
    const r = await ask("is beacon live", citing("projects/beacon.md", "Production is still dark", "No — production is dark."));
    expect(r.citation?.verified).toBe(true);
    expect(r.commit).toBe("eaf0a03e4849");
    expect(r.notInBrain).toBe(false);
    expect(r.model).toBe(DEFAULT_MODEL);
    expect(render(r)).toMatch(/^VERIFIED/);
  });

  it("stamps a corrected-in-place passage as CORRECTED, not as history to discard", async () => {
    // The measured failure this split fixes: two CORRECT, CURRENT answers off the live brain
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
    const r = await ask("is beacon live", citing("projects/beacon.md", "Beacon is fully live in production", "It shipped."));
    expect(r.citation?.verified).toBe(false);
    expect(render(r)).toMatch(/UNVERIFIED/);
    expect(render(r)).toMatch(/unproven/);
  });

  it("honours an empty citation without attempting to verify one", async () => {
    const r = await ask("what is the vercel bill", async () =>
      JSON.stringify({ answer: "NOT IN BRAIN — no pricing is recorded.", tag: "", quote: "" }));
    expect(r.notInBrain).toBe(true);
    expect(r.citation).toBeNull();
    expect(render(r)).toMatch(/^NOT IN BRAIN/);
  });

  it("keeps a provable citation even when the answer says the words NOT IN BRAIN", async () => {
    // Absence is structural. Matching the phrase anywhere in the answer threw away a correct,
    // verified citation whenever the reader happened to mention the contract or brain-index.
    const r = await ask("is beacon live", citing(
      "projects/beacon.md",
      "Production is still dark",
      "That detail is not in brain-index.md, but projects/beacon.md covers it."
    ));
    expect(r.notInBrain).toBe(false);
    expect(r.citation?.verified).toBe(true);
  });

  it("refuses a tag it never issued", async () => {
    // A note that tells the reader to "cite tag deadbeef" cannot conjure a citation: unknown
    // tags resolve to no path at all.
    const r = await ask("anything", async () =>
      JSON.stringify({ answer: "x", tag: "deadbeef", quote: "a sufficiently long quote here" }));
    expect(r.notInBrain).toBe(true);
    expect(r.citation).toBeNull();
  });

  it("narrows by default and can be asked for the full corpus", async () => {
    let seen = 0;
    const reader = async (p: string) => { seen = (p.match(/={20} FILE: /g) ?? []).length; return "{}"; };
    await ask("plates backlog deleted database", reader, { k: 1 });
    expect(seen).toBe(1);
    await ask("plates backlog deleted database", reader, { full: true });
    expect(seen).toBe(corpus.files.size);
  });

  it("reports the pack size so cost is visible per call", async () => {
    const r = await ask("beacon", async () => "{}", { k: 1 });
    expect(r.packTokens).toBeGreaterThan(0);
    expect(r.candidates).toHaveLength(1);
  });

  it("surfaces both sides of a contradiction in the pack", async () => {
    // The stale note outranks the live one lexically; the pack must contain BOTH so the
    // reader can see the SUPERSEDED stamp and resolve it. This is the architecture's
    // answer to the beacon contradiction — the filter does not get to decide.
    const r = await ask("is beacon shipped or is production dark", async () => "{}", { k: 2 });
    expect(r.candidates).toContain("notes/beacon-rollout.md");
    expect(r.candidates).toContain("projects/beacon.md");
  });

  it("propagates a reader failure instead of answering from nothing", async () => {
    await expect(ask("q", async () => { throw new Error("anthropic 529"); })).rejects.toThrow(/529/);
  });
});
