import { describe, expect, it } from "vitest";
import {
  sessionize,
  baselineScores,
  candidateScores,
  cooccurrence,
  topK,
  recallAtK,
  pairKey,
  HALF_LIFE_DAYS,
  KIND_BLEND,
  type AccessEvent,
  type StructuralEdges,
} from "../lib/prediction";

/** Fixture events in one line. All times UTC; the hour window is what sessionize cares about. */
const ev = (at: string, path: string): AccessEvent => ({ at, path });

const NO_STRUCTURE: StructuralEdges = { links: new Set(), tags: new Map() };

describe("sessionize", () => {
  it("groups rows into clock-hour windows of distinct sorted paths, oldest window first", () => {
    const rows = [
      ev("2026-08-10T14:59:00Z", "notes/b.md"),
      ev("2026-08-10T14:05:00Z", "notes/a.md"),
      ev("2026-08-10T14:20:00Z", "notes/a.md"), // same note twice in the hour: one entry
      ev("2026-08-10T09:10:00Z", "notes/c.md"),
    ];
    const w = sessionize(rows);
    expect(w).toHaveLength(2);
    expect(w[0]).toMatchObject({ paths: ["notes/c.md"] });
    expect(w[1]).toMatchObject({ paths: ["notes/a.md", "notes/b.md"] });
    expect(w[0].start).toBeLessThan(w[1].start);
  });

  it("drops a row whose timestamp does not parse rather than guessing it into a window", () => {
    expect(sessionize([ev("not-a-time", "notes/a.md")])).toEqual([]);
  });
});

describe("baselineScores — recency + frequency", () => {
  const now = Date.parse("2026-08-11T00:00:00Z");

  it("counts frequency: two accesses outrank one at equal age", () => {
    const s = baselineScores(
      [ev("2026-08-10T00:00:00Z", "notes/a.md"), ev("2026-08-10T00:00:00Z", "notes/a.md"), ev("2026-08-10T00:00:00Z", "notes/b.md")],
      now
    );
    expect(s.get("notes/a.md")!).toBeGreaterThan(s.get("notes/b.md")!);
  });

  it(`halves an access's worth every ${HALF_LIFE_DAYS} days`, () => {
    const s = baselineScores(
      [ev("2026-08-10T00:00:00Z", "notes/fresh.md"), ev("2026-08-03T00:00:00Z", "notes/stale.md")],
      now
    );
    // stale is exactly one half-life older than fresh.
    expect(s.get("notes/stale.md")!).toBeCloseTo(s.get("notes/fresh.md")! / 2, 10);
  });

  it("never counts a row at or after the moment being predicted — that would be the leak", () => {
    const s = baselineScores([ev("2026-08-11T00:00:00Z", "notes/a.md"), ev("2026-08-12T00:00:00Z", "notes/a.md")], now);
    expect(s.has("notes/a.md")).toBe(false);
  });
});

describe("cooccurrence", () => {
  it("counts the distinct windows a pair shared, order-free", () => {
    const w = sessionize([
      ev("2026-08-10T14:00:00Z", "notes/a.md"),
      ev("2026-08-10T14:30:00Z", "notes/b.md"),
      ev("2026-08-10T16:00:00Z", "notes/b.md"),
      ev("2026-08-10T16:30:00Z", "notes/a.md"),
    ]);
    const c = cooccurrence(w);
    expect(c.get(pairKey("notes/b.md", "notes/a.md"))).toBe(2);
    expect(c.size).toBe(1);
  });
});

describe("candidateScores — the blend the eval measures", () => {
  const now = Date.parse("2026-08-11T00:00:00Z");

  it("pulls a co-accessed partner of a recently-touched note above an untouched stranger", () => {
    const prior = [
      ev("2026-08-10T14:00:00Z", "notes/seed.md"),
      ev("2026-08-10T14:30:00Z", "notes/partner.md"),
      ev("2026-08-10T20:00:00Z", "notes/seed.md"),
      ev("2026-08-10T20:30:00Z", "notes/partner.md"),
      ev("2026-08-10T22:00:00Z", "notes/seed.md"),
    ];
    const s = candidateScores(prior, sessionize(prior), NO_STRUCTURE, now);
    // partner gets its own baseline PLUS the pull from seed's recent touches.
    const baseline = baselineScores(prior, now);
    expect(s.get("notes/partner.md")!).toBeGreaterThan(baseline.get("notes/partner.md")!);
    expect(s.has("notes/stranger.md")).toBe(false);
  });

  it("lets a structural link pull in a note the log has never seen", () => {
    const prior = [ev("2026-08-10T14:00:00Z", "projects/harbor.md")];
    const structure: StructuralEdges = {
      links: new Set([pairKey("projects/harbor.md", "notes/soundings.md")]),
      tags: new Map(),
    };
    const s = candidateScores(prior, sessionize(prior), structure, now);
    expect(s.get("notes/soundings.md")!).toBeGreaterThan(0);
  });

  it("weighs the kinds per KIND_BLEND — a coaccess hour outranks a shared tag", () => {
    const prior = [ev("2026-08-10T14:00:00Z", "notes/seed.md"), ev("2026-08-10T14:30:00Z", "notes/co.md")];
    const structure: StructuralEdges = { links: new Set(), tags: new Map([[pairKey("notes/seed.md", "notes/tagged.md"), 1]]) };
    const s = candidateScores(prior, sessionize(prior), structure, now);
    // co.md has baseline + coaccess pull; strip the baseline to compare pulls alone.
    const pullCo = s.get("notes/co.md")! - baselineScores(prior, now).get("notes/co.md")!;
    const pullTag = s.get("notes/tagged.md")!;
    expect(pullCo).toBeGreaterThan(pullTag);
    expect(KIND_BLEND.coaccess).toBeGreaterThan(KIND_BLEND.tag);
  });
});

describe("topK and recallAtK", () => {
  it("orders by score with the path-name tiebreak, so equal scores never reorder", () => {
    const s = new Map([
      ["notes/b.md", 1],
      ["notes/a.md", 1],
      ["notes/c.md", 2],
    ]);
    expect(topK(s, 3)).toEqual(["notes/c.md", "notes/a.md", "notes/b.md"]);
  });

  it("scores recall as the touched fraction found in the top k", () => {
    expect(recallAtK(["a", "b", "c"], ["a", "z"], 2)).toBe(0.5);
    expect(recallAtK(["a", "b"], ["a", "b"], 2)).toBe(1);
    expect(recallAtK([], ["a"], 5)).toBe(0);
    expect(recallAtK(["a"], [], 5)).toBe(0);
  });
});

describe("determinism — the property the eval's honesty rests on", () => {
  it("produces byte-identical rankings on repeated runs over the same rows", () => {
    // A deliberately messy fixture: interleaved hours, repeats, ties.
    const rows: AccessEvent[] = [];
    for (let i = 0; i < 40; i++) {
      rows.push(ev(`2026-08-${String(1 + (i % 9)).padStart(2, "0")}T${String(i % 24).padStart(2, "0")}:1${i % 6}:00Z`, `notes/n${i % 7}.md`));
    }
    const structure: StructuralEdges = {
      links: new Set([pairKey("notes/n1.md", "notes/n2.md")]),
      tags: new Map([[pairKey("notes/n3.md", "notes/n4.md"), 2]]),
    };
    const now = Date.parse("2026-08-11T00:00:00Z");
    const run = () => ({
      windows: sessionize(rows),
      base: topK(baselineScores(rows, now), 10),
      cand: topK(candidateScores(rows, sessionize(rows), structure, now), 10),
    });
    expect(run()).toEqual(run());
    expect(JSON.stringify(run())).toBe(JSON.stringify(run()));
  });
});
