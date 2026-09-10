import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

/**
 * Every ask* class the Ask screen puts in the markup has a rule in ask.css — and none of them is
 * a class console.css's older ask block also styles. Three classes on the shipped Ops screen
 * were once styled nowhere and nothing could have said so: a class with no rule renders as
 * nothing rather than as an error. The second check is the port's own hazard: console.css still
 * carries `.askForm`, `.askInput`, `.askGo`, `.askLabel`… for the previous demonstration screen,
 * and a same-named class here would be styled twice, by two files, in cascade order.
 */
const css = readFileSync("app/s/[secret]/console/ask/ask.css", "utf8");
const legacy = readFileSync("app/s/[secret]/console/console.css", "utf8");
const files = [
  "app/s/[secret]/console/ask/page.tsx",
  "app/s/[secret]/console/ask/ask-screen.tsx",
  "app/s/[secret]/console/ask/ask-explorer.tsx",
  "app/s/[secret]/console/ask/ask-lens.tsx",
  "app/s/[secret]/console/ask/loading.tsx",
];

function classesIn(src: string): string[] {
  // Ids and label targets share the prefix (askQ, askBandTitle, askSortLabel) and are not classes.
  const ids = new Set([...src.matchAll(/\b(?:id|htmlFor|aria-labelledby|aria-controls)="([^"]*)"/g)].map((m) => m[1]));
  const out = new Set<string>();
  // Every ask* token, wherever the markup composes it: a className string, a template
  // (`askGroup${…}`), an array of variants joined later. A token cut short by a template
  // expression (askD${depth}, askPin-${temperature}) is the variant test's business, below.
  for (const m of src.matchAll(/\bask[A-Z][A-Za-z0-9-]*[A-Za-z0-9]/g)) {
    const after = src.slice(m.index! + m[0].length, m.index! + m[0].length + 2);
    // A single letter before a template expression (askD${depth}) or a dash before one
    // (askPin-${temperature}) is a stem, not a class; a paren or an assignment is an identifier.
    if (after.startsWith("-$") || (after.startsWith("$") && /^ask[A-Z]$/.test(m[0]))) continue;
    if (after.startsWith("(") || after.startsWith(" =")) continue;
    if (ids.has(m[0])) continue;
    out.add(m[0]);
  }
  return [...out].sort();
}

const rule = (c: string) => new RegExp(`\\.${c}(?![A-Za-z0-9_-])`);

describe("Ask markup classes", () => {
  const used = [...new Set(files.flatMap((f) => classesIn(readFileSync(f, "utf8"))))];

  it("names at least the band, the explorer, the readout and the lens bodies", () => {
    for (const c of ["askBand", "askSubmit", "askExplorer", "askTree", "askRow", "askGroup", "askReadout", "askAnswerCard", "askRead", "askReadRow", "askCost", "askKv", "askPinRow", "askEdgeRow", "askContextLink"]) {
      expect(used, c).toContain(c);
    }
  });

  it.each(used)("%s has a rule in ask.css", (c) => {
    expect(css).toMatch(rule(c));
  });

  it("the depth, pin and verdict variants the markup composes all have rules", () => {
    for (const c of ["askD1", "askD2", "askPin-hot", "askPin-warm", "askPin-cold", "askVerdictOk", "askVerdictWarn", "askVerdictBad", "askVerdictAbstain"]) {
      expect(css, c).toMatch(rule(c));
    }
  });

  it("shares no class name with console.css's older ask block", () => {
    const mine = new Set([...css.matchAll(/\.(ask[A-Za-z0-9-]+)/g)].map((m) => m[1]));
    const theirs = new Set([...legacy.matchAll(/\.(ask[A-Za-z0-9-]+)/g)].map((m) => m[1]));
    expect([...mine].filter((c) => theirs.has(c))).toEqual([]);
  });

  it("uses tokens only — no hex literal the dictionary does not carry", () => {
    const hexes = [...css.matchAll(/#[0-9a-f]{3,8}\b/gi)].map((m) => m[0]);
    expect(hexes).toEqual([]);
  });

  it("every var() it reads is defined by the foundation", () => {
    const theme = readFileSync("app/s/[secret]/console/theme.css", "utf8");
    const defined = new Set([...theme.matchAll(/(--[a-z0-9-]+)\s*:/g)].map((m) => m[1]));
    const runtime = new Set(["--cx-d"]);
    const missing = [...new Set([...css.matchAll(/var\((--[a-z0-9-]+)/g)].map((m) => m[1]))].filter((v) => !defined.has(v) && !runtime.has(v) && !css.includes(`${v}:`));
    expect(missing).toEqual([]);
  });
});
