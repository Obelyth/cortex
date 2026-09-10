import { describe, it, expect } from "vitest";
import { narrow, narrowDetail } from "../lib/narrow";

// Invented notes only. The export gate (tests/no-brain-leakage.test.ts) forbids shipped source
// from naming a real brain path, and `harbor` is the house synthetic project the other suites
// use. The scenario is unchanged: one topic that a run of day logs and two notes all mention.
function corpus(): Map<string, string> {
  const m = new Map<string, string>();
  for (let d = 1; d <= 6; d++) m.set(`log/2026-08-0${d}.md`, `## 09:00 · harbor\nrouter budget harbor router budget day ${d}`);
  m.set("notes/router-budget.md", "the router budget rule: 6000 tokens, harbor router budget");
  m.set("projects/harbor.md", "harbor server page: router, budget, tools");
  m.set("notes/unrelated.md", "gardening and soil");
  return m;
}

describe("narrow — one log per pack", () => {
  it("keeps at most one day log in the top k and fills the slots from the next notes", () => {
    const top = narrow(corpus(), "harbor router budget", 4);
    expect(top.filter((p) => p.startsWith("log/")).length).toBe(1);
    expect(top).toContain("notes/router-budget.md");
    expect(top).toContain("projects/harbor.md");
    // Only 2 non-log notes score at all in this fixture ("notes/unrelated.md" carries no
    // lexical overlap with the question), so the capped pack is 1 log + those 2 notes — 3, not
    // 4. The cap must not pad with a zero-score file just to hit k.
    expect(top.length).toBe(3);
  });
  it("respects maxLogs", () => {
    expect(narrow(corpus(), "harbor router budget", 4, { maxLogs: 3 }).filter((p) => p.startsWith("log/")).length).toBe(3);
    expect(narrow(corpus(), "harbor router budget", 4, { maxLogs: 0 }).filter((p) => p.startsWith("log/")).length).toBe(0);
  });
  it("returns fewer than k when the corpus has nothing else", () => {
    const m = new Map([["log/2026-08-01.md", "x"], ["log/2026-08-02.md", "x"]]);
    expect(narrow(m, "x", 2)).toHaveLength(1);
  });
});

describe("narrow — byte budget", () => {
  // Three notes, each exactly 300 bytes, all scoring on "widget" so ranking never excludes one.
  function pad(s: string, len: number): string {
    return (s + "x".repeat(len)).slice(0, len);
  }
  function budgetCorpus(): Map<string, string> {
    const m = new Map<string, string>();
    for (let i = 1; i <= 3; i++) m.set(`notes/widget-${i}.md`, pad(`widget note ${i} `, 300));
    return m;
  }

  it("stops adding notes once the running total would exceed the budget", () => {
    expect(narrow(budgetCorpus(), "widget", 3, { budgetBytes: 700 })).toHaveLength(2);
  });
  it("returns no over-budget note under a tiny budget", () => {
    expect(narrow(budgetCorpus(), "widget", 3, { budgetBytes: 100 })).toHaveLength(0);
  });

  it("does not spend log or part slots until a candidate is admitted", () => {
    const files = new Map([
      ["log/2026-08-01.md", "widget ".repeat(100)],
      ["log/2026-08-02.md", "widget"],
      ["history/harbor-2026-08.md", "widget ".repeat(100)],
      ["history/harbor-2026-07.md", "widget"],
    ]);
    const detail = narrowDetail(files, "widget", 2, {
      budgetBytes: 20,
      maxLogs: 1,
      maxPartsPerPage: 1,
    });
    expect(detail.paths).toEqual(["history/harbor-2026-07.md", "log/2026-08-02.md"]);
    expect(detail.shortlist.every((x) => x.bytes <= 20)).toBe(true);
  });

  it("counts multibyte bodies in UTF-8 bytes", () => {
    const files = new Map([
      ["notes/a.md", "widget界界"], // 12 bytes
      ["notes/b.md", "widget😀"], // 10 bytes
    ]);
    const detail = narrowDetail(files, "widget", 2, { budgetBytes: 20 });
    expect(detail.paths).toHaveLength(1);
    expect(detail.shortlist[0].bytes).toBeGreaterThan(detail.paths.length);
  });
  it("returns all k with no budget set", () => {
    expect(narrow(budgetCorpus(), "widget", 3)).toHaveLength(3);
  });
});

describe("narrow — parts per page", () => {
  // Four history parts of the SAME source page ("harbor"), one part of a DIFFERENT page
  // ("dock"), and one ordinary note — all scoring on the same terms so ranking never excludes
  // one. Mirrors the maxLogs fixture shape: a cap that must fill freed slots from the next
  // SCORED candidates, never pad with a zero-score file, and never touch a different group.
  function partsCorpus(): Map<string, string> {
    const m = new Map<string, string>();
    m.set("history/harbor-2026-07.md", "harbor router budget part a");
    m.set("history/harbor-2026-08.md", "harbor router budget part b");
    m.set("history/harbor-2026-08-2.md", "harbor router budget part c");
    m.set("history/harbor-2026-08-3.md", "harbor router budget part d");
    m.set("history/dock-2026-08.md", "harbor router budget dock");
    m.set("notes/router-budget.md", "the router budget rule harbor");
    return m;
  }

  it("caps history parts from the same source page and fills slots from the next notes", () => {
    const top = narrow(partsCorpus(), "harbor router budget", 4, { maxPartsPerPage: 2 });
    expect(top.filter((p) => p.startsWith("history/harbor-")).length).toBe(2);
    expect(top).toContain("history/dock-2026-08.md");
    expect(top).toContain("notes/router-budget.md");
    expect(top.length).toBe(4);
  });

  it("never caps below one part, and never caps a different page's parts", () => {
    const top = narrow(partsCorpus(), "harbor router budget", 6, { maxPartsPerPage: 1 });
    expect(top.filter((p) => p.startsWith("history/harbor-")).length).toBe(1);
    expect(top).toContain("history/dock-2026-08.md");
  });

  it("returns every part with no cap set", () => {
    const top = narrow(partsCorpus(), "harbor router budget", 6);
    expect(top.filter((p) => p.startsWith("history/harbor-")).length).toBe(4);
  });
});

describe("narrow — a shorter pack is a prefix of a deeper one", () => {
  // scripts/eval-retrieval.ts ranks every arm to a fixed depth of 100 so a miss's rank can be
  // reported even when it falls outside k, then applies the k bar on top of that one list. That
  // is only sound if asking for more candidates never changes which ones come FIRST — and with
  // three post-rank limits in play it is a property to prove, not an obvious truth.
  //
  // It holds because all three act on the same ordered single pass and none of them looks ahead:
  // the log and part filters `continue` before a slot is spent, and the budget `break`s. k only
  // ever decides where that pass stops.
  // Every note is the same 300 bytes, so BM25 ties and the order is path-ascending — which makes
  // the fixture's arithmetic readable: two history parts, then one of the two logs, then one
  // ordinary note is 1,200 bytes exactly, and the next one breaks the budget.
  function mixed(): Map<string, string> {
    const body = "harbor router budget ".repeat(20).slice(0, 300);
    const m = new Map<string, string>();
    for (const p of [
      "log/2026-08-01.md",
      "log/2026-08-02.md",
      "history/harbor-2026-07.md",
      "history/harbor-2026-08.md",
      "history/harbor-2026-08-2.md",
      "notes/router-budget.md",
      "notes/harbor-plan.md",
    ]) {
      m.set(p, body);
    }
    return m;
  }

  it("holds with the log cap, the part cap and the byte budget all engaged", () => {
    const m = mixed();
    const opts = { maxLogs: 1, maxPartsPerPage: 2, budgetBytes: 1200 };
    const q = "harbor router budget";
    const deep = narrow(m, q, 100, opts);
    // All three limits must actually be doing something, or this proves nothing.
    expect(deep.filter((p) => p.startsWith("log/")).length).toBe(1);
    expect(deep.filter((p) => p.startsWith("history/harbor-")).length).toBeLessThanOrEqual(2);
    expect(deep.length).toBeLessThan(m.size);
    for (let k = 1; k <= m.size + 2; k++) {
      expect(narrow(m, q, k, opts), `k=${k}`).toEqual(deep.slice(0, k));
    }
  });

  it("holds for the no-signal fallback too, which the same limits filter", () => {
    const m = mixed();
    const opts = { maxLogs: 1, maxPartsPerPage: 2, budgetBytes: 1200 };
    const deep = narrow(m, "???", 100, opts);
    expect(deep.length).toBeGreaterThan(0);
    for (let k = 1; k <= m.size + 2; k++) {
      expect(narrow(m, "???", k, opts), `k=${k}`).toEqual(deep.slice(0, k));
    }
  });
});
