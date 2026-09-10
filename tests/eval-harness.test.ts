import { describe, it, expect } from "vitest";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { summarise, frozenTree } from "../scripts/eval-retrieval";

const rows = [
  { q: "a", expected: "notes/a.md", ranked: ["notes/a.md", "notes/b.md"], packBytes: 100 },
  { q: "b", expected: "notes/b.md", ranked: ["notes/x.md", "notes/y.md", "notes/z.md"], packBytes: 300 },
  { q: "c", expected: "notes/c.md", ranked: Array.from({ length: 30 }, (_, i) => `notes/n${i}.md`).concat(["notes/c.md"]), packBytes: 500 },
  { q: "d", expected: "notes/d.md", ranked: ["notes/d.md"], packBytes: 200, contains: ["--no-verify"], bodies: new Map([["notes/d.md", "never use --no-verify"]]) },
  { q: "e", expected: "notes/e.md", ranked: ["notes/e.md"], packBytes: 200, contains: ["serverless"], bodies: new Map([["notes/e.md", "nothing here"]]) },
];

describe("summarise", () => {
  const r = summarise("bm25", rows, 10);
  it("counts a hit only inside k and reports the rank of every miss", () => {
    expect(r.hits).toBe(2); expect(r.total).toBe(5);
    expect(r.misses.map((m) => [m.q, m.rank])).toEqual([["b", null], ["c", 31], ["e", 1]]);
  });
  it("is strict about expect_contains: a top-ranked note that lacks the phrase is a miss", () => {
    expect(r.misses.find((m) => m.q === "e")).toBeTruthy();
    expect(r.misses.find((m) => m.q === "d")).toBeUndefined();
  });
  it("carries pack-cost columns", () => { expect(r.meanPackBytes).toBe(260); expect(r.maxPackBytes).toBe(500); });
  it("reports rankHits (rank-only) alongside hits (strict): e is rank-in-k but fails contains", () => {
    // a, d, e all rank inside k=10 -> rankHits=3; only a and d survive the strict contains check.
    expect(r.rankHits).toBe(3);
    expect(r.hits).toBe(2);
  });
  it("tags a strict-only miss (ranked fine, contains failed) with containsOnly", () => {
    expect(r.misses.find((m) => m.q === "e")?.containsOnly).toBe(true);
  });
  it("does not tag a rank miss as containsOnly", () => {
    expect(r.misses.find((m) => m.q === "b")?.containsOnly).toBe(false);
    expect(r.misses.find((m) => m.q === "c")?.containsOnly).toBe(false);
  });
});

describe("frozenTree", () => {
  it("exports the note at HEAD, then removes the extracted directory once cleanup() runs", () => {
    const repo = mkdtempSync(path.join(os.tmpdir(), "frozen-tree-test-repo-"));
    try {
      execFileSync("git", ["init", "-q", repo]);
      execFileSync("git", ["-C", repo, "config", "user.email", "test@example.com"]);
      execFileSync("git", ["-C", repo, "config", "user.name", "test"]);
      writeFileSync(path.join(repo, "note.md"), "hello from the frozen tree\n");
      execFileSync("git", ["-C", repo, "add", "note.md"]);
      execFileSync("git", ["-C", repo, "commit", "-q", "-m", "add note"]);

      const { dir, cleanup } = frozenTree(repo, "HEAD");
      try {
        expect(existsSync(path.join(dir, "note.md"))).toBe(true);
      } finally {
        cleanup();
      }
      expect(existsSync(dir)).toBe(false);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });
});
