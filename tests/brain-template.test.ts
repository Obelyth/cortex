/** The installed corpus starts with no invented memories or example projects. */
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { retracted, splitBlocks } from "../lib/verify";
import { isLive } from "../lib/corpus";
import { renderContext } from "../lib/brain";

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
    expect(rel).toEqual(["INDEX.md", "profile.md"]);
    expect(readFileSync(path.join(ROOT, "profile.md"), "utf8").trim()).toBe("# Profile");
  });

  it("serves only the blank profile, with no sample project or recent history on first boot", () => {
    const live = new Map(files
      .map((file) => [path.relative(ROOT, file), readFileSync(file, "utf8")] as const)
      .filter(([file]) => isLive(file)));
    const context = renderContext({
      corpus: { files: live, sha: "blank-template", bytes: 10, fetchedAt: 0 },
      bubble: { state: "absent" }, scores: null, nonce: "template-test",
    });
    expect([...live.keys()]).toEqual(["profile.md"]);
    // The profile itself is a router row; no other note is installed.
    expect(context.routerRows).toBe(1);
    expect(context.expandedDays).toEqual([]);
    expect(context.digestedDays).toEqual([]);
    expect(context.bubble).toBe("absent");
  });

  it("boots with zero retracted blocks — no template file trips the verifier", () => {
    for (const file of files) {
      const blocks = splitBlocks(readFileSync(file, "utf8"));
      const flagged = blocks.filter((_, i) => retracted(blocks, i));
      expect(flagged, path.relative(ROOT, file)).toEqual([]);
    }
  });
});
