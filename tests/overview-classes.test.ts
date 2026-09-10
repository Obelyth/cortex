import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { BUBBLE_KINDS } from "@/lib/bubble";
import { CHIP_TONES, MAX_BAND, TONES } from "@/lib/overview";

/**
 * Every ov* class the Overview markup puts in the DOM has a rule in overview.css — the guard
 * the Ops screen earned when three of its classes shipped styled nowhere (a class with no rule
 * renders as nothing rather than as an error).
 *
 * Classes are read out of className attributes, not out of every string literal in the file. The
 * wider scan swept up prose too: any comment, aria-label or fragment of JSX text that happened to
 * quote an ov-shaped word became a class the css then had to define, so writing "we dropped
 * ovD13" in a comment would have failed the build. Composed forms (`ovWsKind-${kind}`) still
 * resolve, and the values they compose from are imported rather than retyped, so a fifth bubble
 * kind cannot be added without this guard noticing.
 *
 * And the v2 port brief's other rules, held here so they cannot drift: no inline styles in the
 * screen, no hex literal in its stylesheet (every colour is a token), and none of the paper-era
 * compatibility aliases a ported screen must not use.
 */
const dir = "app/s/[secret]/console/overview";
const css = readFileSync(`${dir}/overview.css`, "utf8");
const files = readdirSync(dir).filter((f) => f.endsWith(".tsx")).map((f) => `${dir}/${f}`);

/** The source text of every className attribute: the quoted string, or the braced expression. */
function classAttrs(src: string): string[] {
  const out: string[] = [];
  const re = /className=/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null) {
    const i = m.index + m[0].length;
    const q = src[i];
    if (q === '"' || q === "'") {
      const end = src.indexOf(q, i + 1);
      if (end > i) out.push(src.slice(i + 1, end));
      continue;
    }
    if (q !== "{") continue;
    let depth = 0;
    let j = i;
    for (; j < src.length; j++) {
      if (src[j] === "{") depth++;
      else if (src[j] === "}" && --depth === 0) break;
    }
    out.push(src.slice(i + 1, j));
  }
  return out;
}

function take(raw: string, out: Set<string>): void {
  for (const c of raw.replace(/[^A-Za-z0-9_§ -]/g, " ").split(/\s+/)) {
    if (/^ov[A-Z][A-Za-z0-9]*(-[a-z]+)?$/.test(c)) out.add(c);
  }
}

/**
 * What an interpolation does to the name in front of it. `ovMark${x ? " ovMarkX" : ""}` appends a
 * whole second class, so `ovMark` stands on its own and must resolve; `ovD${band}` completes the
 * name, so `ovD` is a prefix and only its composed forms resolve. A branch that opens with a
 * space is what separates the two.
 */
function appends(expr: string): boolean {
  return [...expr.matchAll(/["'`]([^"'`]*)["'`]/g)].some((m) => m[1].startsWith(" "));
}

function classesIn(src: string): string[] {
  const out = new Set<string>();
  for (const attr of classAttrs(src)) {
    // A class named inside an interpolation is a real class (`ovLensAct${p ? " ovLensActPrimary" : ""}`).
    for (const e of attr.matchAll(/\$\{([\s\S]*?)\}/g)) {
      for (const lit of e[1].matchAll(/["'`]([^"'`]*)["'`]/g)) take(lit[1], out);
    }
    // "§" keeps a composed prefix from being read as a finished class; a space lets the name in
    // front of an appending interpolation finish.
    take(attr.replace(/\$\{([\s\S]*?)\}/g, (_m, e: string) => (appends(e) ? " " : "§")), out);
  }
  return [...out].sort();
}

/** The composed forms, from the values the screen composes them out of — never a second list. */
const COMPOSED = [
  ...BUBBLE_KINDS.map((k) => `ovWsKind-${k}`),
  ...TONES.map((t) => `ovTone-${t}`),
  ...CHIP_TONES.map((t) => `ovChip-${t}`),
  ...Array.from({ length: MAX_BAND + 1 }, (_, i) => `ovD${i}`),
];

describe("Overview markup classes", () => {
  const used = [...new Set([...files.flatMap((f) => classesIn(readFileSync(f, "utf8"))), ...COMPOSED])];
  it("names the nine instruments", () => {
    expect(used).toEqual(expect.arrayContaining(["ovRoot", "ovMast", "ovMastN", "ovFlood", "ovCorpus", "ovField", "ovMark", "ovPanels", "ovPanel", "ovBoot", "ovRing", "ovTrough", "ovChart", "ovWs", "ovKv", "ovDoor", "ovSave", "ovStack", "ovLensKv"]));
  });
  it.each(used)("%s has a rule in overview.css", (c) => {
    expect(css).toMatch(new RegExp(`\\.${c}(?![A-Za-z0-9_-])`));
  });
});

describe("the v2 port rules", () => {
  it("the screen carries no inline styles", () => {
    for (const f of files) expect(readFileSync(f, "utf8"), f).not.toMatch(/\bstyle=\{/);
  });
  it("the stylesheet names no colour the dictionary lacks", () => {
    expect(css.match(/#[0-9a-fA-F]{3,8}\b/g) ?? []).toEqual([]);
    expect(css.match(/rgba?\(/g) ?? []).toEqual([]);
  });
  it("the stylesheet uses no compatibility alias", () => {
    expect(css.match(/var\(--(paper|ink-\d+|rule|rule-soft|rule-hair|field-[a-z]+|band-[a-z]+|elev-\d|sunk-well|card-line[a-z-]*)\)/g) ?? []).toEqual([]);
  });
  it("page.tsx imports the stylesheet", () => {
    expect(readFileSync(`${dir}/page.tsx`, "utf8")).toMatch(/import "\.\/overview\.css"/);
  });
});

describe("the console root the reader controls post to", () => {
  it("is the /console segment, not the last one", async () => {
    const { consoleRoot } = await import("../app/s/[secret]/console/use-reader-save");
    // A tab segment.
    expect(consoleRoot("/s/abc/console/overview")).toBe("/s/abc/console");
    expect(consoleRoot("/s/abc/console/trends/")).toBe("/s/abc/console");
    // NOT a tab segment — the console serves these too, and cutting the last segment against the
    // tab table left them posting to `…/attention/settings/save`.
    expect(consoleRoot("/s/abc/console/attention")).toBe("/s/abc/console");
    expect(consoleRoot("/s/abc/console/proposals")).toBe("/s/abc/console");
    // Already the root.
    expect(consoleRoot("/s/abc/console")).toBe("/s/abc/console");
  });
});
