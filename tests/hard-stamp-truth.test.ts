import { describe, expect, it } from "vitest";
import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { splitBlocks, verifyQuote, isBannerText } from "../lib/verify";

/**
 * Asserts the STAMP, not the classifier.
 *
 * Every other suite here checks `headingIsBanner()`, `retraction()` or `superseded` in isolation.
 * That is how a fix shipped green and inert: `retraction()` was moved onto the new heading rule
 * and `retracted()` was left on the old one, so the pair became (superseded: true,
 * retraction: "none") — which matches NEITHER arm of render() and falls through to the absolute
 * "It is history, do not answer from it." Twelve blocks reclassified, zero stamps changed, 647
 * tests green.
 *
 * The stamp is the product. A test that stops one level short of it is testing a private
 * implementation detail and calling it a guarantee, so this one reproduces render()'s branch
 * exactly and runs it over the live corpus.
 *
 * The fixture notes are synthetic; the live-corpus block at the end re-checks the same
 * properties against a real brain clone when one is present, and skips when it is not.
 */
// Resolved the same way every other suite here resolves it — relative to the repo, never to
// one developer's home directory.
const BRAIN = process.env.BRAIN_DIR ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../brain");
const present = existsSync(path.join(BRAIN, "profile.md"));

/** render()'s decision, verbatim — lib/ask.ts branches on this pair and nothing else. */
type Stamp = "VERIFIED" | "CORRECTED" | "SUPERSEDED" | "UNVERIFIED";
function stampOf(text: string, quote: string): Stamp {
  const v = verifyQuote(text, quote);
  if (!v.verified) return "UNVERIFIED";
  if (v.superseded && v.retraction === "correction") return "CORRECTED";
  if (v.superseded) return "SUPERSEDED";
  return "VERIFIED";
}

function walk(dir: string, base = ""): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    if (name === ".git") continue;
    const abs = path.join(dir, name);
    const rel = base ? `${base}/${name}` : name;
    if (statSync(abs).isDirectory()) out.push(...walk(abs, rel));
    else if (rel.endsWith(".md")) out.push(rel);
  }
  return out;
}

describe("the rendered stamp", () => {
  it("a prose 'correction' heading does not stamp its section dead", () => {
    // The exact shape that was reclassified but still rendered SUPERSEDED.
    const text = "## Correction to the deploy section (2026-08-09)\n\nThe deploy is stateless and runs on Vercel.\n";
    expect(stampOf(text, "The deploy is stateless and runs on Vercel.")).not.toBe("SUPERSEDED");
  });

  it("a SHOUTED heading still stamps its section dead", () => {
    const text = "## SUPERSEDED 2026-08-09 — see the newer page\n\nThe deploy runs on Fly.io.\n";
    expect(stampOf(text, "The deploy runs on Fly.io.")).toBe("SUPERSEDED");
  });

  it("quoting the whole house-style sentence is CORRECTED, not SUPERSEDED", () => {
    // ANSWER_CONTRACT asks the reader for "a VERBATIM sentence from that file". The house style
    // puts the correction INSIDE the sentence, so an obedient reader quotes the whole thing —
    // which used to contain the retired wording and flip the live claim to dead.
    const text = 'Cortex runs on Vercel (was: "cortex runs on Fly.io"). The deploy is stateless.\n';
    expect(stampOf(text, "Cortex runs on Vercel")).toBe("CORRECTED");
    expect(stampOf(text, 'Cortex runs on Vercel (was: "cortex runs on Fly.io").')).toBe("CORRECTED");
  });

  it("quoting the RETIRED wording itself is still SUPERSEDED", () => {
    // The half of the split that must never regress: cite the dead claim, get told it is dead.
    const text = 'Cortex runs on Vercel (was: "cortex runs on Fly.io and needs a volume"). Stateless.\n';
    expect(stampOf(text, "cortex runs on Fly.io and needs a volume")).toBe("SUPERSEDED");
  });

  it("a marker too short to be a citation cannot retire one", () => {
    // 17 of 79 markers in the corpus normalise below MIN_QUOTE. A three-character "..." in a
    // neighbouring block must not swallow every quote that happens to contain it.
    const text = 'The pipeline is green and the backlog is clear.\n\nStatus reworded (was: "...").\n';
    expect(stampOf(text, "The pipeline is green and the backlog is clear.")).not.toBe("SUPERSEDED");
  });
});

describe.skipIf(!present)("stamp truth against the live corpus", () => {
  /**
   * The regression that matters at scale: a block carrying its own `(was: "…")` correction, quoted
   * WHOLE, must not come back dead. 55 passages were failing this way — every one current text.
   */
  it("no whole-sentence house-style correction stamps as SUPERSEDED", () => {
    const wrong: string[] = [];
    let checked = 0;

    const BANNERISH = (t: string) => isBannerText(t);
    for (const rel of walk(BRAIN)) {
      const text = readFileSync(path.join(BRAIN, rel), "utf8");
      const all = splitBlocks(text);
      for (const [bi, b] of all.entries()) {
        // A banner keyword anywhere in range — self, either neighbour, or the heading — takes the
        // block out of scope. Some of those are genuine retractions; ~13 are the word used as
        // PROSE ("see the correction in the section above", "the SUPERSEDED block"), which is the
        // same wolf-crying one level down and is reported, not fixed here. Widening this suite to
        // cover them would imply a fix that does not exist.
        if ([all[bi - 1], all[bi + 1]].some((n) => n && BANNERISH(n.text))) continue;
        if (BANNERISH(b.heading)) continue;
        // Only blocks whose own text carries the marker, and which no OTHER banner covers —
        // otherwise a genuine retraction next door would be miscounted as this bug.
        if (!/was:\s*"/.test(b.text)) continue;
        // Only a SHOUTED banner excuses a block now. Prose references used to be excluded here
        // because they were an unfixed defect; the rule is uniform, so the suite stops excusing
        // them and asserts what the code actually guarantees.
        if (isBannerText(b.text)) continue;
        const quote = b.text.replace(/^[ \t]*[-*+>]\s*/, "").trim();
        if (quote.length < 40) continue;
        checked++;
        if (stampOf(text, quote) === "SUPERSEDED") wrong.push(`${rel}:${b.line}`);
      }
    }

    expect(checked, "no house-style corrections found — the walk is wrong").toBeGreaterThan(10);
    expect(wrong, `live claims stamped dead:\n  ${wrong.join("\n  ")}`).toEqual([]);
  });

  it("every retired wording in the corpus still stamps SUPERSEDED when quoted directly", () => {
    // The safety direction. If this ever empties or starts failing, the fix above went too far.
    const missed: string[] = [];
    let checked = 0;

    for (const rel of walk(BRAIN)) {
      const text = readFileSync(path.join(BRAIN, rel), "utf8");
      for (const m of text.matchAll(/was:\s*"([^"]{12,400})"/g)) {
        checked++;
        if (stampOf(text, m[1]) === "CORRECTED") missed.push(`${rel} :: ${m[1].slice(0, 50)}`);
      }
    }

    expect(checked, "no retired wordings found at all").toBeGreaterThan(10);
    expect(missed, `retired wording no longer flagged:\n  ${missed.join("\n  ")}`).toEqual([]);
  });
});
