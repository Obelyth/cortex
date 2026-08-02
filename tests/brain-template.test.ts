/**
 * A fresh brain must boot clean. The scaffold documents the retraction system, and any
 * literal marker word in a template file would make a brand-new customer's console open
 * with amber "retracted" findings before they have written a word — which is why the
 * template files point at the README's stamp table instead of spelling the words out.
 * This pins that choice against a well-meaning future edit that writes one back in.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { retracted, splitBlocks } from "../lib/verify";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../brain-template");

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = path.join(dir, name);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}

describe("brain-template scaffold", () => {
  const files = walk(ROOT).filter((p) => p.endsWith(".md"));

  it("has the pages a fresh brain boots from", () => {
    const rel = files.map((p) => path.relative(ROOT, p)).sort();
    expect(rel).toContain("profile.md");
    expect(rel).toContain("INDEX.md");
    expect(rel).toContain("notes/conventions.md");
    expect(rel).toContain("projects/example-project.md");
  });

  it("boots with zero retracted blocks — no template file trips the verifier", () => {
    for (const file of files) {
      const blocks = splitBlocks(readFileSync(file, "utf8"));
      const flagged = blocks.filter((_, i) => retracted(blocks, i));
      expect(flagged, path.relative(ROOT, file)).toEqual([]);
    }
  });
});
