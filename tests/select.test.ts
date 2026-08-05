import { describe, expect, it } from "vitest";
import { selectNotes } from "../lib/select";

const OPTS = { budgetBytes: 100, defaultK: 10 };

function corpus(sizes: Record<string, number>): Map<string, string> {
  return new Map(Object.entries(sizes).map(([p, n]) => [p, "x".repeat(n)]));
}

describe("selectNotes — by path", () => {
  const files = corpus({ "notes/a.md": 10, "notes/b.md": 10, "projects/c.md": 10 });

  it("returns exactly the notes asked for, in the order asked", () => {
    const s = selectNotes(files, { ...OPTS, paths: ["projects/c.md", "notes/a.md"] });
    expect(s.paths).toEqual(["projects/c.md", "notes/a.md"]);
    expect(s.missing).toEqual([]);
  });

  // A caller working from the router can name a note that has since been renamed or deleted.
  // Silently returning fewer notes than were asked for reads as "these are all that exist".
  it("reports a requested path that is not in the corpus", () => {
    const s = selectNotes(files, { ...OPTS, paths: ["notes/a.md", "notes/gone.md"] });
    expect(s.paths).toEqual(["notes/a.md"]);
    expect(s.missing).toEqual(["notes/gone.md"]);
  });

  it("bounds an explicit path request too", () => {
    const big = corpus({ "a.md": 60, "b.md": 60, "c.md": 60 });
    const s = selectNotes(big, { ...OPTS, paths: ["a.md", "b.md", "c.md"] });
    expect(s.paths).toEqual(["a.md"]);
    expect(s.dropped).toBe(2);
    expect(s.cursor).toBe("a.md");
  });
});

describe("selectNotes — by question", () => {
  it("ranks and caps at k", () => {
    const files = new Map([
      ["notes/metrics.md", "metrics warehouse query"],
      ["notes/camera.md", "camera ble cohn"],
      ["notes/other.md", "unrelated words"],
    ]);
    const s = selectNotes(files, { ...OPTS, question: "metrics", k: 1 });
    expect(s.paths).toEqual(["notes/metrics.md"]);
  });
});

describe("selectNotes — listing and the cursor", () => {
  const files = corpus({ "a.md": 40, "b.md": 40, "c.md": 40, "d.md": 40 });

  it("fills the budget and hands back a cursor for the rest", () => {
    const s = selectNotes(files, OPTS);
    expect(s.paths).toEqual(["a.md", "b.md"]);
    expect(s.dropped).toBe(2);
    expect(s.cursor).toBe("b.md");
  });

  it("resumes strictly after the cursor, with no repeat and no gap", () => {
    const first = selectNotes(files, OPTS);
    const second = selectNotes(files, { ...OPTS, after: first.cursor! });
    expect(second.paths).toEqual(["c.md", "d.md"]);
    expect([...first.paths, ...second.paths]).toEqual(["a.md", "b.md", "c.md", "d.md"]);
    expect(second.cursor).toBeNull();
  });

  it("returns nothing and no cursor once the corpus is exhausted", () => {
    const s = selectNotes(files, { ...OPTS, after: "d.md" });
    expect(s.paths).toEqual([]);
    expect(s.cursor).toBeNull();
  });

  // Otherwise paging jams: the oversized note never fits, nothing is returned, the cursor never
  // advances past it, and every retry gets the same empty answer.
  it("always yields at least one note, even one larger than the whole budget", () => {
    const s = selectNotes(corpus({ "huge.md": 5000, "next.md": 10 }), OPTS);
    expect(s.paths).toEqual(["huge.md"]);
    expect(s.dropped).toBe(1);
    expect(selectNotes(corpus({ "huge.md": 5000, "next.md": 10 }), { ...OPTS, after: "huge.md" }).paths).toEqual(["next.md"]);
  });

  it("never loses a note across a full paged walk of a real-sized corpus", () => {
    const many = corpus(Object.fromEntries(Array.from({ length: 83 }, (_, i) => [`n${String(i).padStart(2, "0")}.md`, 30])));
    const seen: string[] = [];
    let after: string | undefined;
    for (let guard = 0; guard < 100; guard++) {
      const s = selectNotes(many, { ...OPTS, after });
      seen.push(...s.paths);
      if (!s.cursor) break;
      after = s.cursor;
    }
    expect(seen).toEqual([...many.keys()].sort());
    expect(new Set(seen).size).toBe(83);
  });
});

describe("selectNotes — precedence", () => {
  const files = corpus({ "a.md": 10, "b.md": 10 });
  it("paths wins over question, so the precise ask is never overridden by a ranker", () => {
    const s = selectNotes(files, { ...OPTS, paths: ["b.md"], question: "a" });
    expect(s.paths).toEqual(["b.md"]);
  });
});
