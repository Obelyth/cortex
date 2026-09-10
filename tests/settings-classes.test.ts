import { describe, expect, it } from "vitest";
import { stripCssComments } from "./support/css";
import { readFileSync } from "node:fs";

/**
 * Every set* class the Settings markup names has a rule in settings.css — the guard the Ops
 * screen earned when three of its classes shipped styled nowhere. The v2 port moved every
 * settings rule out of console.css and the module into the screen's own sheet, so this is also
 * the check that nothing was left behind on the way.
 */
const css = readFileSync("app/s/[secret]/console/settings/settings.css", "utf8");
const files = [
  "app/s/[secret]/console/settings/page.tsx",
  "app/s/[secret]/console/settings/settings-screen.tsx",
  "app/s/[secret]/console/settings/settings-client.tsx",
  "app/s/[secret]/console/settings/learning-client.tsx",
  "app/s/[secret]/console/settings/readers-panel.tsx",
  "app/s/[secret]/console/settings/ground-switch.tsx",
  "app/s/[secret]/console/settings/connect-section.tsx",
  "app/s/[secret]/console/settings/wire-client.tsx",
  "app/s/[secret]/console/settings/rows.tsx",
];

function classesIn(src: string): string[] {
  const out = new Set<string>();
  for (const m of src.matchAll(/className=(?:"([^"]*)"|\{`([^`]*)`\}|\{([^}]*)\})/g)) {
    const raw = (m[1] ?? m[2] ?? m[3] ?? "").replace(/\$\{[^}]*\}/g, " ").replace(/[^A-Za-z0-9_ -]/g, " ");
    for (const c of raw.split(/\s+/)) if (/^set[A-Za-z0-9]+$/.test(c)) out.add(c);
  }
  return [...out].sort();
}

describe("Settings markup classes", () => {
  const used = [...new Set(files.flatMap((f) => classesIn(readFileSync(f, "utf8"))))];
  it("names the band, a group, a row, the switch, the stepper, the record and a door", () => {
    expect(used).toEqual(expect.arrayContaining(["setMast", "setGroup", "setRow", "setSwt", "setKnob", "setStep", "setSelect", "setChip", "setRec", "setDoor", "setLensBtn"]));
  });
  it.each(used)("%s has a rule in settings.css", (c) => {
    expect(css).toMatch(new RegExp(`\\.${c}(?![A-Za-z0-9_-])`));
  });
  it("carries no inline style and no hex literal the dictionary lacks", () => {
    for (const f of files) expect(readFileSync(f, "utf8"), f).not.toMatch(/style=\{\{/);
    expect(css).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
  });
  it("never disables through opacity", () => {
    expect(css).not.toMatch(/opacity:\s*0?\.[0-9]+/);
  });
  it("retired the old settings rules from the shared sheets", () => {
    // Comments stripped before matching. The guard is about RULES, and a sheet that explains why
    // a rule was retired necessarily names it — so reading the prose made the note recording the
    // fix look like the fix being undone. A guard that cannot tell a selector from a sentence
    // about a selector spends its life crying wolf.
    const rules = (f: string) => stripCssComments(readFileSync(f, "utf8"));
    const shared = rules("app/s/[secret]/console/console.css");
    const mod = rules("app/s/[secret]/console/console.module.css");
    for (const sel of [".setRow", ".setBody", ".setTitle", ".setSub", ".setLock", ".swt", ".setGround", ".setRowStack"]) {
      expect(shared, `${sel} still in console.css`).not.toMatch(new RegExp(`${sel.replace(".", "\\.")}(?![A-Za-z0-9_-])`));
    }
    for (const sel of [".setGrid", ".setRows", ".stepper", ".gScope", ".gArea", ".roleGrid", ".pathGrid", ".toolRow", ".wireMeta"]) {
      expect(mod, `${sel} still in console.module.css`).not.toMatch(new RegExp(`${sel.replace(".", "\\.")}(?![A-Za-z0-9_-])`));
    }
  });
});
