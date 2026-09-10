import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
const src = readFileSync("app/s/[secret]/console/reveal.tsx", "utf8");
const css = readFileSync("app/s/[secret]/console/console.css", "utf8");
describe("Reveal uses the Fold glyph", () => {
  it("imports Glyph and renders fold-closed", () => { expect(src).toMatch(/from "\.\/glyph"/); expect(src).toMatch(/"fold-closed"/); });
  it("no longer prints a text caret", () => { expect(src).not.toMatch(/[">]\s*[>v]\s*[<"]/); });
  it("the caret swings 90° over 220ms and the body unfolds over 260ms", () => { expect(css).toMatch(/\.revOpen \.revCaret[^}]*rotate\(90deg\)/); expect(css).toMatch(/cx-unfold 260ms/); });
});
