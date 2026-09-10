import { describe, expect, it } from "vitest";
import { stripCssComments } from "./support/css";
import { readFileSync } from "node:fs";

/**
 * Every ops* class the Ops screen puts in the markup has a rule in its own stylesheet. Three
 * classes on the shipped screen were styled nowhere (opsLine, opsNo, opsGroup — critique
 * 2026-09-05), and nothing could have said so: the screen has no DOM test, and a class with no
 * rule renders as nothing rather than as an error. The v2 port (2026-09-05) moved the screen's
 * rules from console.css to ops/ops.css; the same guard follows them, and gains the port
 * brief's other rules — tokens only, no inline styles, one shared lens — because those fail just
 * as silently.
 */
const css = readFileSync("app/s/[secret]/console/ops/ops.css", "utf8");
const shell = readFileSync("app/s/[secret]/console/console.css", "utf8");
const theme = readFileSync("app/s/[secret]/console/theme.css", "utf8");
const globals = readFileSync("app/globals.css", "utf8");
const dir = "app/s/[secret]/console/ops";
const files = ["page.tsx", "ops-screen.tsx", "ops-client.tsx", "ops-decisions.tsx", "ops-lens.tsx"].map((f) => `${dir}/${f}`);
const sources = Object.fromEntries(files.map((f) => [f, readFileSync(f, "utf8")]));
/* Tokenisation-aware, so a /* inside a string or url() cannot swallow the rules after it —
   see tests/support/css.ts. Used on the stylesheet and on the TSX shell alike; both are read as
   text and both explain in prose what these guards look for. */
const uncommented = (s: string) => stripCssComments(s, "");

function classesIn(src: string): string[] {
  const out = new Set<string>();
  for (const m of src.matchAll(/className=(?:"([^"]*)"|\{`([^`]*)`\}|\{([^}]*)\})/g)) {
    const raw = (m[1] ?? m[2] ?? m[3] ?? "").replace(/\$\{[^}]*\}/g, " ").replace(/[^A-Za-z0-9_ -]/g, " ");
    for (const c of raw.split(/\s+/)) if (/^ops[A-Za-z0-9-]+$/.test(c)) out.add(c);
  }
  return [...out].sort();
}

describe("Ops markup classes", () => {
  const used = [...new Set(files.flatMap((f) => classesIn(sources[f])))];
  it("names the strip, the register, the two panels beneath it and the lens bodies", () => {
    expect(used).toEqual(expect.arrayContaining(["opsStrip", "opsRegister", "opsRow", "opsChip", "opsDecisions", "opsDecision", "opsTimeline", "opsReceipt", "opsLensKv", "opsAct"]));
  });
  // A trailing dash is a family the markup completes at render time (opsChip-${tone}); the
  // family's members all need rules, and the tones they take are the console's fixed sets.
  const tones = ["ok", "warn", "crit", "live", "paper", "dashed"];
  const sevs = ["crit", "warn", "watch", "proposal"];
  const phases = ["working", "done", "failed"]; // rest is the button itself
  const family: Record<string, string[]> = { "opsChip-": tones, "opsMark-": tones.filter((t) => t !== "dashed"), "opsSev-": sevs, "opsAct-": phases };
  const expanded = used.flatMap((c) => (c.endsWith("-") ? (family[c] ?? []).map((m) => `${c}${m}`) : [c]));
  it("every dynamic family in the markup is one this test knows the members of", () => {
    expect(used.filter((c) => c.endsWith("-") && !family[c])).toEqual([]);
  });
  it.each(expanded)("%s has a rule in ops.css", (c) => {
    expect(css).toMatch(new RegExp(`\\.${c}(?![A-Za-z0-9_-])`));
  });
});

describe("the port brief's rules", () => {
  it("no inline styles in the port", () => {
    for (const f of files) expect(sources[f], f).not.toMatch(/\bstyle=\{/);
  });
  it("ops.css names only tokens: no hex literal, and every var() is one a stylesheet defines", () => {
    expect(uncommented(css).match(/#[0-9a-fA-F]{3,8}\b/g) ?? []).toEqual([]);
    const defined = new Set([...(theme + shell + globals).matchAll(/(--[a-z0-9-]+)\s*:/g)].map((m) => m[1]));
    const missing = [...css.matchAll(/var\((--[a-z0-9-]+)/g)].map((m) => m[1]).filter((v) => !defined.has(v));
    expect([...new Set(missing)]).toEqual([]);
  });
  it("no compatibility alias: a ported screen reads the v2 names", () => {
    const compat = /var\(--(paper|paper-raised|paper-sunk|ink-900|ink-700|ink-600|ink-500|ink-400|rule|rule-soft|rule-hair|field-live|field-warn|field-ok|field-crit|field-on|band-paper|band-grey|band-ink|band-ink-on|elev-1|elev-2|sunk-well)\)/;
    expect(css).not.toMatch(compat);
  });
  it("console.css no longer carries the screen — only what the tray and the map still compose", () => {
    const left = [...new Set([...uncommented(shell).matchAll(/\.(ops[A-Za-z0-9-]*)/g)].map((m) => m[1]))].sort();
    expect(left).toEqual(["opsBtn", "opsBtnSecondary", "opsDegraded", "opsField", "opsField-crit", "opsField-live", "opsField-ok", "opsField-paper", "opsField-warn"]);
  });
  it("the lens is the shared one: no second drawer, every body opens through useLens", () => {
    expect(sources[`${dir}/ops-client.tsx`]).toMatch(/useLens\(\)/);
    expect(sources[`${dir}/ops-decisions.tsx`]).toMatch(/useLens\(\)/);
    for (const f of files) expect(sources[f], f).not.toMatch(/role="dialog"/);
  });
  it("the honesty copy survives the port", () => {
    expect(sources[`${dir}/ops-client.tsx`]).toContain("no receipts yet · the first run writes the first row");
    expect(sources[`${dir}/ops-decisions.tsx`]).toContain("nothing needs attention · quiet is the correct state");
    expect(sources[`${dir}/ops-client.tsx`]).toContain("receipts · newest first · 30 d");
  });
});
