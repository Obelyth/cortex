/**
 * The landing's console demo carries the gated console's shape with nothing real on it —
 * the same contract the demo map pins byte-by-byte. These tests pin the data side: every
 * path in the demo belongs to the invented-fixture family, and the source never links a
 * gated route. The design file this demo implements used two real project names and a
 * real commit SHA; this is the test that keeps them from coming back.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  ASK,
  BUBBLE,
  COLD,
  COMMITS,
  CREDS,
  NAV,
  POOL,
  PROPOSALS,
  QUOTES,
  RETIRED,
  ROWS,
  TRIAGE,
} from "../app/console-demo-data";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const read = (p: string) => readFileSync(path.resolve(HERE, "..", p), "utf8");

/** Only invented names may appear as note paths. ADD YOUR OWN real note names when you extend. */
const INVENTED =
  /^(profile\.md|—|(projects\/(aurora|beacon|relay|signal)\.md(:\d+)?)|(notes\/(mcp-architecture|verification-contract|retrieval-eval|brain-conventions|prompt-patterns|deploy-runbook)\.md(:\d+)?)|(log\/\d{4}-\d{2}-\d{2}\.md(:\d+)?))$/;

describe("console demo data", () => {
  it("uses only invented note paths", () => {
    const paths = [
      ...POOL.map((p) => p.path),
      ...ROWS.map((r) => r.dir + r.base),
      ...CREDS.map((c) => c.loc),
      ...RETIRED.map((r) => r.path),
      ...COLD.map((c) => c.path),
      ...QUOTES.map((q) => q.loc),
      ...TRIAGE.map((t) => t.loc),
      ...PROPOSALS.map((p) => p.path),
      ...BUBBLE.map((b) => b.note),
      ASK.cite.loc,
    ];
    for (const p of paths) expect(p, p).toMatch(INVENTED);
  });

  it("carries no real commit SHA from the reference deployment", () => {
    // Demo SHAs are 8 hex chars; none may match a SHA the reference repos have published.
    // The forbidden prefixes are stored as SHA-256 digests so this file never publishes
    // the strings it forbids — every 7-hex-char window in the data source is hashed and
    // checked for membership instead.
    const FORBIDDEN_DIGESTS = new Set([
      "bdfaa132019d7ee4fefe3128acf889af623f6e06a59e2a72f52da6ec5d3290fd",
      "761bde727720cc143f8c51b0e82c3f9ee5a0949a4c60b034ff729f5c9ca5b832",
      "da6ccffa8a905fa0d7484acee7163b4fb5cef1bc7b320701e4594fbdb1a6794e",
      "26e324493e38d0fa1712c38ffd1d9b83bde7d720f25653a63e63c20a31336c6f",
      "9bd34d9761c02293a68a6a727bfd36f69403312a92ad59047e223e8eb3b5c4ac",
      "3865677841688afc73841e9fdc03d35b75b1ac4b324574eda5454b3182878d6c",
    ]);
    for (const c of COMMITS) expect(c.sha).toMatch(/^[0-9a-f]{8}$/);
    const src = read("app/console-demo-data.ts");
    for (const run of src.match(/[0-9a-f]{7,}/g) ?? []) {
      for (let i = 0; i + 7 <= run.length; i++) {
        const window = run.slice(i, i + 7);
        const digest = createHash("sha256").update(window).digest("hex");
        expect(FORBIDDEN_DIGESTS.has(digest), `hex window ${window} is a forbidden SHA`).toBe(false);
      }
    }
  });

  it("never links a gated route and says it is synthetic", () => {
    const src = read("app/console-demo.tsx");
    expect(src).not.toMatch(/href=["'][^"']*\/s\//);
    expect(src.toLowerCase()).toContain("synthetic");
    // The map tab embeds only the public demo map.
    expect(src).toContain('src="/map"');
  });

  it("carries the real shell's seven screens, in its tab order", () => {
    // The README describes seven console screens; the demo stopped omitting two of them when
    // it adopted the console's current shell. This pin keeps the demo and that claim honest.
    expect(NAV.map((n) => n.k)).toEqual(["overview", "ask", "trends", "corpus", "attention", "map", "settings"]);
  });

  it("declares its inert controls in place", () => {
    // The old demo omitted the screens whose controls mutate a deployment; this one shows
    // them and says, on the Settings screen itself, that the demo's controls change nothing.
    // The declaration must stay rendered, not just exported.
    const src = read("app/console-demo.tsx");
    expect(src).toContain("{DEMO_NOTE}");
    const data = read("app/console-demo-data.ts");
    expect(data).toContain("change nothing");
  });
});
