/**
 * live brain corpus — the router against the real thing.
 *
 * Fixtures prove the parser handles the shapes it was designed for. These prove it handles the
 * shapes an operator actually wrote, which is a different claim: 83 notes, nine with frontmatter and
 * 74 without, prose full of colons, em-dashes, `(was: "…")` markers and `---` horizontal rules.
 *
 * Skips cleanly when ../brain is absent, like every other hard-* suite, which is why CI stays
 * green without the brain checked out.
 */
import { describe, expect, it } from "vitest";
import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { parseFrontmatter, buildRouter } from "../lib/frontmatter";
import { isLive } from "../lib/corpus";
import { ROUTER_BUDGET_BYTES } from "../lib/brain";

const BRAIN = process.env.BRAIN_DIR ?? join(process.cwd(), "..", "brain");
const present = existsSync(BRAIN);

function walk(dir: string, base = ""): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    if (name === ".git") continue;
    const abs = join(dir, name);
    const rel = base ? `${base}/${name}` : name;
    if (statSync(abs).isDirectory()) out.push(...walk(abs, rel));
    else out.push(rel);
  }
  return out;
}

function liveCorpus(): Map<string, string> {
  const files = new Map<string, string>();
  for (const rel of walk(BRAIN)) {
    if (!isLive(rel)) continue;
    files.set(rel, readFileSync(join(BRAIN, rel), "utf8"));
  }
  return files;
}

describe.skipIf(!present)("live brain corpus", () => {
  const files = present ? liveCorpus() : new Map<string, string>();

  it("parses every live note without throwing", () => {
    expect(files.size).toBeGreaterThan(50);
    for (const [path, text] of files) {
      expect(() => parseFrontmatter(text), path).not.toThrow();
    }
  });

  // The whole point of the degrade rule. If this ever fails, the backfill broke a note.
  it("never loses body text — every note's body is a suffix of the file", () => {
    for (const [path, text] of files) {
      const { body } = parseFrontmatter(text);
      expect(text.endsWith(body), path).toBe(true);
      expect(body.length, path).toBeGreaterThan(0);
    }
  });

  // A `---` rule mid-note, or the `--- log/x.md ---` banners a context dump leaves behind, must
  // not be mistaken for a fence. Notes without frontmatter must come back completely untouched.
  it("returns notes without frontmatter byte-for-byte", () => {
    let bare = 0;
    for (const [path, text] of files) {
      if (/^---\r?\n/.test(text)) continue;
      bare++;
      expect(parseFrontmatter(text).body, path).toBe(text);
      expect(parseFrontmatter(text).description, path).toBe("");
    }
    // Before the backfill this was 74 of 83. Day-logs are the permanent bare set — they derive
    // their line from their own entry headings and are never given frontmatter — so the floor is
    // about them, not about a corpus that has not been described yet.
    expect(bare).toBeGreaterThanOrEqual(5);
  });

  it("reads a description out of every note that already has frontmatter", () => {
    const withFm = [...files].filter(([, t]) => /^---\r?\n/.test(t));
    expect(withFm.length).toBeGreaterThanOrEqual(9);
    for (const [path, text] of withFm) {
      const fm = parseFrontmatter(text);
      expect(fm.description.length, `${path} description`).toBeGreaterThan(10);
      // The existing notes nest `type:` under `metadata:`; a nested key must not be read as a
      // top-level one.
      expect(fm.description, path).not.toContain("node_type");
    }
  });

  it("lists every live note in the router, described or not", () => {
    const router = buildRouter(files);
    for (const path of files.keys()) expect(router, path).toContain(path);
  });

  it("router stays small enough to always load, and reports its own coverage", () => {
    // THE BUDGETED RENDER, because it is the only one boot can serve: getContext calls
    // buildRouter(files, temps, ROUTER_BUDGET_BYTES) and routerCut fits the DOCUMENT to it. This
    // test used to call buildRouter(files) unbounded and assert `tokens < 6000` — a size no code
    // path emits, measured against a literal that had drifted from the constant beside it
    // (28,000 B permits 7,000 tokens). On 2026-09-02 it went red at 6,202 tokens while the
    // document was 24,807 B: 3,193 B INSIDE its own budget, 140 of 140 rows rendered, nothing
    // dropped. The mechanism was working; the gate was failing on the corpus growing, and it
    // blocked two PRs that never touched the router. hard-context.test.ts learned this one file
    // over — "The constant, not a literal. Hardcoding 20,000 here meant the day the budget was
    // re-measured the test kept asserting the old one" — and this is that lesson applied where it
    // was missed. The bound now cannot disagree with the code, because it IS the code's number.
    const router = buildRouter(files, new Map(), ROUTER_BUDGET_BYTES);
    expect(router.length, "router exceeded ROUTER_BUDGET_BYTES").toBeLessThanOrEqual(
      ROUTER_BUDGET_BYTES
    );
    expect(router).toMatch(/_\d+ of \d+ notes carry a description\._/);

    // Headroom is PRINTED, not asserted, on purpose. Dropping rows past the budget is by design
    // and the document says how many did not fit — but a note that stops being listed stops being
    // discoverable at boot, and that is already gated next door by hard-context's "routes every
    // live note, so nothing became undiscoverable" (dropped rows are counted, never named, so a
    // real loss fails there with a readable reason). What is missing is early warning, so the
    // number a human should act on is readable in the run rather than inferred from a red tick.
    const headroom = ROUTER_BUDGET_BYTES - router.length;
    console.log(
      `      router: ${router.length} B of ${ROUTER_BUDGET_BYTES} B — ${headroom} B headroom (~${Math.round(headroom / 200)} more notes)`
    );
  });

  it("is deterministic on the real corpus", () => {
    expect(buildRouter(files)).toBe(buildRouter(files));
  });
});
