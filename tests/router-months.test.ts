/**
 * The router used to spend one row on every day log, forever. That is the one class of note the
 * corpus grows by every single day, and each row bought almost nothing: a derived digest of a day
 * nobody is going to route to by name. On the live brain it was the difference between a router
 * that fits its always-loaded budget and one that does not.
 *
 * So day logs collapse to one row per month — how many days, how many entries, the month's
 * loudest tags — and `history/` pages (the dated slices two mega pages were split into) list
 * individually, because those ARE routed to by name.
 *
 * The guarantee that survives the collapse: for every live path the router contains the path OR
 * its month key. Nothing became undiscoverable; a month row is the signpost to its days.
 */
import { describe, it, expect } from "vitest";
import { buildRouter } from "../lib/frontmatter";
import { monthKey, isHistoryPath } from "../lib/digest";

const fm = (d: string) => `---\ndescription: "${d}"\ntags: [a, b]\n---\n`;
const files = new Map<string, string>([
  ["profile.md", fm("who")],
  ["notes/x.md", fm("note x")],
  ["log/2026-08-04.md", "## 09:00 · cortex, mocap\nbody\n\n## 10:00 · cortex\nbody"],
  ["log/2026-08-05.md", "## 09:00 · grain\nbody"],
  ["log/2026-09-01.md", "## 09:00 · cortex\nbody"],
  ["history/harbor-2026-08.md", fm("harbor history August 2026") + "## x\n"],
  // A month too big for one note is written as ordered parts. Both are real, individually named
  // notes; only their MONTH is shared.
  ["history/harbor-2026-09-1.md", fm("harbor history September 2026 part 1 of 2") + "## x\n"],
  ["history/harbor-2026-09-2.md", fm("harbor history September 2026 part 2 of 2") + "## y\n"],
]);

describe("month rows", () => {
  it("maps day logs and history files to month keys", () => {
    expect(monthKey("log/2026-08-04.md")).toBe("log/2026-08");
    expect(monthKey("history/harbor-2026-08.md")).toBe("history/harbor-2026-08");
    expect(monthKey("notes/x.md")).toBeNull();
    expect(isHistoryPath("history/harbor-2026-08.md")).toBe(true);
  });

  it("reads a part suffix as the same month, and still as a history path", () => {
    // A month that outgrew one note is split into `-1`, `-2`, … Those parts are siblings of the
    // same month, so they must answer with the month they belong to rather than with three
    // different keys that look like three different months.
    expect(isHistoryPath("history/harbor-2026-09-1.md")).toBe(true);
    expect(monthKey("history/harbor-2026-09-1.md")).toBe("history/harbor-2026-09");
    expect(monthKey("history/harbor-2026-09-12.md")).toBe("history/harbor-2026-09");
    // The suffix is a part number, not a day. A dated third component is not this shape.
    expect(isHistoryPath("history/harbor-2026-09-1x.md")).toBe(false);
  });

  it("lists every part of a split month on its own row", () => {
    // Parts are reached BY NAME, like any other history note — they must not collapse into one
    // month row the way day logs do, or the second half of a month becomes unreachable.
    const r = buildRouter(files, new Map(), 28_000);
    expect(r).toContain("- history/harbor-2026-09-1.md · harbor history September 2026 part 1 of 2");
    expect(r).toContain("- history/harbor-2026-09-2.md · harbor history September 2026 part 2 of 2");
  });
  it("collapses day logs into one row per month with counts and top tags", () => {
    const r = buildRouter(files, new Map(), 28_000);
    expect(r).toContain("- log/2026-08 · 2 day logs · 3 entries · cortex, mocap, grain");
    expect(r).toContain("- log/2026-09 · 1 day log · 1 entry · cortex");
    expect(r).not.toContain("log/2026-08-04.md");
  });
  it("lists a history file on its own row with its description", () => {
    expect(buildRouter(files, new Map(), 28_000)).toContain("- history/harbor-2026-08.md · harbor history August 2026");
  });
  it("groups history after log, in the directory order the router has always used", () => {
    const r = buildRouter(files, new Map(), 28_000);
    // `history` is a known directory, not an unknown one sorted alphabetically onto the end —
    // which, with a corpus containing only these two, would put it BEFORE log and read as an
    // accident. Its place is deliberate: older siblings of the days, after the days.
    expect(r.indexOf("## history")).toBeGreaterThan(r.indexOf("## log"));
    expect(r.indexOf("## log")).toBeGreaterThan(r.indexOf("## notes"));
  });
  it("prioritizes month discovery rows without letting them bypass the hard budget", () => {
    // Month signposts lead the walk, but a long-lived brain can accumulate hundreds of them.
    // Those that do not fit are counted and remain reachable through the named corpus route.
    const tight = buildRouter(files, new Map(), 320);
    expect(tight).toContain("- log/2026-08 ·");
    expect(tight).not.toContain("- log/2026-09 ·");
    expect(tight).toMatch(/did not fit this router's budget/);
    expect(tight).toContain("brain_corpus");
    expect(new TextEncoder().encode(tight).byteLength).toBeLessThanOrEqual(320);
  });
  it("routes every live path or its month", () => {
    const r = buildRouter(files, new Map(), 28_000);
    // `toContain(monthKey(p) ?? p)`, not `includes(p) || includes(monthKey(p) ?? " ")`. The
    // fallback in that second form was a space, which every router contains — so a path with no
    // month key asserted nothing at all, and the test would have passed on a router that had
    // dropped it. A vacuous coverage test is worse than none: it reads as the guarantee.
    for (const p of files.keys()) expect(r, p).toContain(monthKey(p) ?? p);
  });
});
