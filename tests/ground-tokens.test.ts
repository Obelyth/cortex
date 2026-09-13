import { describe, expect, it } from "vitest";
import { existsSync, readdirSync, readFileSync } from "node:fs";

/**
 * The two grounds stay at parity, and every var() the console reads is defined somewhere. An
 * undefined token inside a `font:` or `transition:` shorthand silently invalidates the whole
 * declaration — this console lost four type rules and forty-eight transitions to exactly that
 * before anyone noticed (theme.css, 2026-08). This is the check the repo said it wanted.
 */
const theme = readFileSync("app/s/[secret]/console/theme.css", "utf8");
const console_ = readFileSync("app/s/[secret]/console/console.css", "utf8");
const globals = readFileSync("app/globals.css", "utf8");
// The ported screens' own sheets read the same dictionary and are held to the same check. Found
// on disk, not listed: a literal list held one of the four while ops, settings and trends went
// unchecked, and the next screen would have joined them silently.
const CONSOLE_DIR = "app/s/[secret]/console";
const screenSheets = readdirSync(CONSOLE_DIR, { withFileTypes: true })
  .filter((d) => d.isDirectory())
  .map((d) => `${CONSOLE_DIR}/${d.name}/${d.name}.css`)
  .filter((f) => existsSync(f));
const screens = screenSheets.map((f) => readFileSync(f, "utf8"));

function block(css: string, selector: string): string {
  const i = css.indexOf(selector);
  const open = css.indexOf("{", i);
  let depth = 0;
  for (let j = open; j < css.length; j++) {
    if (css[j] === "{") depth++;
    if (css[j] === "}" && --depth === 0) return css.slice(open, j);
  }
  return "";
}
const defined = (css: string) => new Set([...css.matchAll(/(--[a-z0-9-]+)\s*:/g)].map((m) => m[1]));
// Only a var() with NO fallback. `var(--ri, 0)` cannot invalidate its declaration whatever
// happens to --ri, and properties a component supplies through an inline style (the map's
// per-ring and per-mark bloom indices) are defined at runtime and never in a sheet — flagging
// those made the guard cry wolf about the one form that is already safe by construction.
const used = (css: string) =>
  new Set([...css.matchAll(/var\(\s*(--[a-z0-9-]+)\s*([,)])/g)].filter((m) => m[2] === ")").map((m) => m[1]));

describe("the two grounds", () => {
  const ink = defined(block(theme, ".conRoot {"));
  const paper = defined(block(theme, '.conRoot[data-ground="paper"]'));
  it("paper redefines every v2 name ink defines, and nothing else is missing", () => {
    const v2 = ["--ground", "--surface", "--surface2", "--sunk", "--ink", "--bright", "--muted", "--faint", "--disabled", "--line", "--hair", "--accent", "--accent-hi", "--accent-soft", "--accent-on", "--warn", "--crit", "--ok", "--band", "--grain", "--elev1", "--cast", "--well", "--glass", "--wordmark", "--modebg", "--bezel", "--trough", "--mast"];
    for (const k of v2) {
      expect(ink.has(k), `ink defines ${k}`).toBe(true);
      expect(paper.has(k), `paper defines ${k}`).toBe(true);
    }
  });
  it("re-points every compatibility alias on both grounds", () => {
    const compat = ["--paper", "--paper-raised", "--paper-sunk", "--ink-900", "--ink-700", "--ink-500", "--ink-400", "--rule", "--rule-soft", "--rule-hair", "--field-live", "--field-warn", "--field-ok", "--field-crit", "--field-on", "--band-paper", "--band-grey", "--band-ink", "--band-ink-on", "--elev-1", "--elev-2", "--sunk-well"];
    for (const k of compat) {
      expect(ink.has(k), `ink aliases ${k}`).toBe(true);
      expect(paper.has(k), `paper aliases ${k}`).toBe(true);
    }
  });
  it("ink is the default: the bare .conRoot block carries the dark ground", () => {
    expect(block(theme, ".conRoot {")).toMatch(/--ground:\s*#0f1318/);
    expect(block(theme, '.conRoot[data-ground="paper"]')).toMatch(/--ground:\s*#e4e2de/);
  });
});

describe("every var() the console reads resolves", () => {
  const all = new Set([...defined(theme), ...defined(console_), ...defined(globals)]);
  // Set inline on elements at render time, never in a stylesheet.
  const runtime = new Set(["--cx-d", "--i", "--d", "--font-archivo", "--font-jetbrains"]);
  const missing = [...used(console_), ...used(theme), ...screens.flatMap((c) => [...used(c)])].filter((v) => !all.has(v) && !runtime.has(v));
  it("names nothing that no stylesheet defines", () => {
    expect([...new Set(missing)]).toEqual([]);
  });
});
