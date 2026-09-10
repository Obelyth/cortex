import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

/**
 * Every tr* class the Trends markup names has a rule in trends.css — the same guard the Ops
 * and Map screens earned when classes shipped styled nowhere. Scanned from every string
 * literal in the screen's files, not only className attributes, because the chart classes are
 * picked in expressions (`i === peak ? "trBarPeak" : …`) and a class chosen at runtime renders
 * as nothing rather than as an error just the same.
 */
const css = readFileSync("app/s/[secret]/console/trends/trends.css", "utf8");
const files = [
  "app/s/[secret]/console/trends/trends-screen.tsx",
  "app/s/[secret]/console/trends/trends-client.tsx",
  "app/s/[secret]/console/trends/charts.tsx",
];

function classesIn(src: string): string[] {
  const out = new Set<string>();
  for (const m of src.matchAll(/(?:"([^"\n]*)"|'([^'\n]*)'|`([^`]*)`)/g)) {
    const raw = (m[1] ?? m[2] ?? m[3] ?? "").replace(/\$\{[^}]*\}/g, " ");
    for (const c of raw.matchAll(/\btr[A-Z][A-Za-z0-9-]*/g)) out.add(c[0]);
  }
  return [...out].sort();
}

const defined = new Set([...css.matchAll(/\.(tr[A-Za-z0-9-]+)/g)].map((m) => m[1]));

describe("Trends markup classes", () => {
  const used = [...new Set(files.flatMap((f) => classesIn(readFileSync(f, "utf8"))))];
  it("names the strip, the troughs, the drawings and the lens", () => {
    expect(used).toEqual(expect.arrayContaining(["trInv", "trStrip", "trTrough", "trChart", "trClock", "trDonut", "trHeat", "trRow", "trLens"]));
  });
  it.each(used)("%s has a rule in trends.css", (c) => {
    if (c.endsWith("-")) {
      // A tone prefix completed at runtime (`trBar-${tone}`): some rule must complete it.
      expect([...defined].some((d) => d.startsWith(c)), `a rule completes ${c}`).toBe(true);
    } else {
      expect(defined.has(c), `.${c} is defined`).toBe(true);
    }
  });
  it("names no hex literal the dictionary lacks, and puts no style attribute in the markup", () => {
    expect(css).not.toMatch(/#[0-9a-f]{3,8}\b/i);
    for (const f of files) expect(readFileSync(f, "utf8"), `${f} carries no style=`).not.toMatch(/\bstyle=\{/);
  });
  it("is the only sheet the old trends rules survive in", () => {
    const console_ = readFileSync("app/s/[secret]/console/console.css", "utf8");
    const module_ = readFileSync("app/s/[secret]/console/console.module.css", "utf8");
    for (const gone of [".statStrip", ".mcPlot", ".patRow", ".heatWrap", ".shareRow", ".trEmpty", ".trGrid"]) {
      expect(console_, `${gone} retired from console.css`).not.toContain(gone);
    }
    for (const gone of [".heatGrid", ".heatCell", ".checkedRow"]) {
      expect(module_, `${gone} retired from console.module.css`).not.toContain(gone);
    }
  });
});
