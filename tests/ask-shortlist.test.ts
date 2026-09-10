import { describe, expect, it } from "vitest";
import { narrow, narrowDetail, rank, rankTerms, DEFAULT_MAX_LOGS } from "../lib/narrow";
import { ask, render, DEFAULT_K, NARROW_BUDGET_BYTES, DEFAULT_MAX_PARTS_PER_PAGE, type AskResult } from "../lib/ask";
import type { ReaderPrompt } from "../lib/ask";
import type { Corpus } from "../lib/corpus";

/**
 * The narrowing's working, exposed for the console's "what it read" (approved console design): the
 * shortlist carries each note's score, matched terms and bytes; every candidate a cap refused
 * carries the cap; the zero count says how many files had no signal. And the pack the reader is
 * handed is byte-for-byte what narrow() returned before — the MCP tool and the call log read
 * only render(), which must not change by a character.
 *
 * Invented notes only; `harbor` is the house synthetic project.
 */
function corpus(): Map<string, string> {
  const m = new Map<string, string>();
  for (let d = 1; d <= 4; d++) m.set(`log/2026-08-0${d}.md`, `## 09:00 · harbor\nrouter budget harbor router budget day ${d}`);
  m.set("notes/router-budget.md", "the router budget rule: 6000 tokens, harbor router budget");
  m.set("projects/harbor.md", "harbor server page: router, budget, tools");
  m.set("notes/unrelated.md", "gardening and soil");
  return m;
}

describe("rankTerms — one scorer, the terms kept", () => {
  it("scores exactly as rank() does, in the same order", () => {
    const files = corpus();
    expect(rankTerms(files, "harbor router budget").map(({ path, score }) => ({ path, score }))).toEqual(rank(files, "harbor router budget"));
  });

  it("names the question's own tokens the file contains, in question order", () => {
    const files = corpus();
    const byPath = new Map(rankTerms(files, "budget harbor gardening").map((r) => [r.path, r.terms]));
    expect(byPath.get("projects/harbor.md")).toEqual(["budget", "harbor"]);
    expect(byPath.get("notes/unrelated.md")).toEqual(["gardening"]);
  });
});

describe("narrowDetail — the pack, and why", () => {
  it("returns byte-for-byte the paths narrow() returns for the same arguments", () => {
    const files = corpus();
    for (const k of [1, 2, 3, 6]) {
      expect(narrowDetail(files, "harbor router budget", k).paths).toEqual(narrow(files, "harbor router budget", k));
    }
  });

  it("ranks the shortlist 1..n with a score, the matched terms and real UTF-8 bytes", () => {
    const files = corpus();
    const d = narrowDetail(files, "harbor router budget", 6);
    expect(d.mode).toBe("scored");
    expect(d.shortlist.map((s) => s.rank)).toEqual(d.shortlist.map((_, i) => i + 1));
    for (const s of d.shortlist) {
      expect(s.score).toBeGreaterThan(0);
      expect(s.terms.length).toBeGreaterThan(0);
      expect(s.bytes).toBe(Buffer.byteLength(files.get(s.path)!, "utf8"));
    }
    const scores = d.shortlist.map((s) => s.score);
    expect(scores).toEqual([...scores].sort((a, b) => b - a));
  });

  it("records the day-logs the log cap refused, with the cap, and counts the files with no signal", () => {
    const d = narrowDetail(corpus(), "harbor router budget", 6);
    expect(DEFAULT_MAX_LOGS).toBe(1);
    expect(d.paths.filter((p) => p.startsWith("log/"))).toHaveLength(1);
    const logCuts = d.cut.filter((c) => c.by === "log-cap");
    expect(logCuts.map((c) => c.path).sort()).toHaveLength(3);
    for (const c of logCuts) expect(c.score).toBeGreaterThan(0);
    expect(d.zeroCount).toBe(1); // notes/unrelated.md
    expect(d.cut.some((c) => c.path === "notes/unrelated.md")).toBe(false);
  });

  it("records the part the per-page cap refused", () => {
    const files = new Map([
      ["history/harbor-2026-08-1.md", "harbor harbor harbor part one"],
      ["history/harbor-2026-08-2.md", "harbor harbor part two"],
      ["history/harbor-2026-08-3.md", "harbor part three"],
      ["notes/other.md", "harbor once"],
    ]);
    const d = narrowDetail(files, "harbor", 10, { maxPartsPerPage: 2 });
    expect(d.paths).toEqual(["history/harbor-2026-08-1.md", "history/harbor-2026-08-2.md", "notes/other.md"]);
    expect(d.cut).toEqual([{ path: "history/harbor-2026-08-3.md", score: expect.any(Number), by: "parts-cap" }]);
  });

  it("records the candidate the byte budget refused, and every one behind it as refused by the same closure", () => {
    const pad = (s: string, len: number) => (s + "x".repeat(len)).slice(0, len);
    const files = new Map([
      ["notes/a.md", pad("widget widget widget ", 300)],
      ["notes/b.md", pad("widget widget ", 300)],
      ["notes/c.md", pad("widget ", 300)],
      ["notes/d.md", pad("widget ", 300)],
    ]);
    const d = narrowDetail(files, "widget", 10, { budgetBytes: 650 });
    expect(d.paths).toEqual(["notes/a.md", "notes/b.md"]);
    expect(d.cut.map((c) => [c.path, c.by])).toEqual([["notes/c.md", "budget"], ["notes/d.md", "budget"]]);
  });

  it("records what ranked below k as refused by k, not by a cap it never met", () => {
    const d = narrowDetail(corpus(), "harbor router budget", 2);
    expect(d.paths).toHaveLength(2);
    const byK = d.cut.filter((c) => c.by === "k");
    expect(byK.length).toBeGreaterThan(0);
    expect(d.cut.map((c) => c.path).concat(d.paths).sort()).toEqual([...corpus().keys()].filter((p) => p !== "notes/unrelated.md").sort());
  });

  it("says when nothing scored: the largest notes went to the caps, and the zero count is the whole corpus", () => {
    const files = corpus();
    const d = narrowDetail(files, "zzz", 2);
    expect(d.mode).toBe("fallback");
    expect(d.zeroCount).toBe(files.size);
    expect(d.paths).toEqual(narrow(files, "zzz", 2));
    for (const s of d.shortlist) expect(s).toMatchObject({ score: 0, terms: [] });
  });
});

/** The ask() half: the corpus handed in, the reader a stub, nothing on the network. */
const askCorpus: Corpus = {
  sha: "eaf0a03e4849aaaa",
  bytes: 200,
  fetchedAt: Date.now(),
  files: new Map([
    ["projects/beacon.md", "**Production is still dark** (re-checked 2026-07-25). Both URLs still return 404."],
    ["projects/harbor.md", "The plates backlog went into a deleted database."],
    ["notes/unrelated.md", "gardening and soil"],
    ["log/2026-08-01.md", "beacon dark today"],
    ["log/2026-08-02.md", "beacon still dark"],
  ]),
};

function tagOf(prompt: string, path: string): string {
  const esc = path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return prompt.match(new RegExp(`FILE: ${esc} \\[tag: ([0-9a-z]+)\\]`))?.[1] ?? "";
}
const citing = (path: string, quote: string) => async ({ stable }: ReaderPrompt) =>
  JSON.stringify({ answer: "an answer", tag: tagOf(stable, path), quote });

describe("ask() carries the working, and the tool path does not change", () => {
  it("returns the shortlist, the cuts, the zero count and the caps by name", async () => {
    const r = await ask("is production still dark", citing("projects/beacon.md", "Production is still dark"), { corpus: askCorpus });
    expect(r.shortlist.map((s) => s.path)).toEqual(r.candidates);
    expect(r.shortlist[0]).toMatchObject({ rank: 1, path: "projects/beacon.md", terms: expect.arrayContaining(["dark"]) });
    expect(r.shortlist.every((s) => typeof s.score === "number" && s.bytes > 0)).toBe(true);
    expect(r.cut.map((c) => c.by)).toContain("log-cap");
    expect(r.zeroCount).toBe(2); // harbor, unrelated
    expect(r.narrowing).toEqual({ mode: "narrowed", k: DEFAULT_K, budgetBytes: NARROW_BUDGET_BYTES, maxLogs: DEFAULT_MAX_LOGS, maxPartsPerPage: DEFAULT_MAX_PARTS_PER_PAGE });
  });

  it("a full read has no ranking: null scores, no terms, no cuts, the mode says so", async () => {
    const r = await ask("is production still dark", citing("projects/beacon.md", "Production is still dark"), { corpus: askCorpus, full: true });
    expect(r.narrowing.mode).toBe("full");
    expect(r.narrowing.maxLogs).toBeNull();
    expect(r.shortlist.map((s) => s.path)).toEqual(r.candidates);
    expect(r.shortlist.every((s) => s.score === null && s.terms.length === 0)).toBe(true);
    expect(r.cut).toEqual([]);
    expect(r.zeroCount).toBe(0);
  });

  it("render() — what the MCP tool and the call log read — is byte-identical with the working stripped", async () => {
    const r = await ask("is production still dark", citing("projects/beacon.md", "Production is still dark"), { corpus: askCorpus });
    const stripped = { ...r, shortlist: [], cut: [], zeroCount: 0 } as AskResult;
    for (const citations of [true, false]) {
      const a = render(r, { citations });
      expect(a).toBe(render(stripped, { citations }));
      expect(a).not.toMatch(/bm25|shortlist|matched/i);
    }
    expect(render(r)).toMatch(/^VERIFIED/);
  });
});
