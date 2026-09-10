import { describe, it, expect } from "vitest";
import { GLYPHS, type GlyphName } from "../lib/glyphs";

const NAMES: GlyphName[] = ["fold-open", "fold-closed", "point", "done", "run", "pause", "run-again", "notices", "needs-you", "go", "opens-elsewhere", "find", "close", "snooze", "correct", "live", "trend", "note", "register", "key", "verified"];

describe("glyph set", () => {
  it("has every name in the spec and no extras", () => expect(Object.keys(GLYPHS).sort()).toEqual([...NAMES].sort()));
  it("every glyph has exactly one grain inside the 20px grid and at least one path", () => {
    for (const n of NAMES) {
      const g = GLYPHS[n];
      if (n !== "point") expect(g.paths.length, n).toBeGreaterThan(0);
      expect(g.grain.cx, n).toBeGreaterThanOrEqual(2); expect(g.grain.cx, n).toBeLessThanOrEqual(18);
      expect(g.grain.cy, n).toBeGreaterThanOrEqual(2); expect(g.grain.cy, n).toBeLessThanOrEqual(18);
    }
  });
  it("paths carry no fill or stroke attributes of their own (the component owns them)", () => {
    for (const n of NAMES) for (const p of GLYPHS[n].paths) expect(p, n).toMatch(/^[MmLlHhVvCcSsAaZz0-9 .,-]+$/);
  });
  it("only live is a field", () => { for (const n of NAMES) expect(GLYPHS[n].field === "live", n).toBe(n === "live"); });
});
