import { describe, expect, it } from "vitest";
import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { splitBlocks, retraction, isBannerText, normalise, MIN_QUOTE } from "../lib/verify";

/**
 * The heading rule was loosened. This proves nothing stopped being caught.
 *
 * `retraction()` used a case-insensitive test on the heading, so `### Correction from the race
 * officer` marked its whole section retracted — the freshest passage in the note stamped
 * "history, not the current state". The fix requires a heading's marker to be SHOUTED (all-caps or
 * bold) before it counts as a banner.
 *
 * Loosening a safety check is the dangerous direction. Over-reporting SUPERSEDED annoys; UNDER-
 * reporting it hands back a dead claim as current, which is the failure the whole verifier exists
 * to prevent. So the test that matters is not "does the bug go away" — it is "does every real
 * banner still fire". That is asserted against the live corpus, not a fixture, because the corpus
 * is where the conventions actually live.
 */
const BRAIN = process.env.BRAIN_DIR ?? join(process.cwd(), "..", "brain");
const present = existsSync(BRAIN);

function walk(dir: string, base = ""): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    if (name === ".git") continue;
    const abs = join(dir, name);
    const rel = base ? `${base}/${name}` : name;
    if (statSync(abs).isDirectory()) out.push(...walk(abs, rel));
    else if (rel.endsWith(".md")) out.push(rel);
  }
  return out;
}

describe("headingIsBanner", () => {
  it("counts a SHOUTED marker — the house style for a real banner", () => {
    for (const h of ["SUPERSEDED 2025-05-06", "CORRECTION — the tide table was a year old", "DEPRECATED"]) {
      expect(isBannerText(h), h).toBe(true);
    }
  });

  it("counts a bold marker whatever its case", () => {
    expect(isBannerText("**Superseded** — see the newer page")).toBe(true);
    expect(isBannerText("**correction** to the start times")).toBe(true);
  });

  it("counts an explicit directive", () => {
    expect(isBannerText("Do not answer from this page")).toBe(true);
  });

  it("does NOT count the word used as ordinary prose — the bug", () => {
    // Invented headings that use a marker word as an ordinary noun or adjective. The old
    // case-insensitive rule would have marked each whole section dead.
    for (const h of [
      "Correction from the race officer",
      "Why the regatta results needed a correction",
      "Superseded sail numbers still painted on the old dinghies",
      "Deprecated fittings the chandlery still stocks",
      "TODO — find out which of the old tide tables are superseded",
    ]) {
      expect(isBannerText(h), h).toBe(false);
    }
  });

  it("a PROSE reference to a correction does NOT retract the text around it", () => {
    // The other half, and the reason this change exists. Invented lines that mention a marker
    // word in lowercase without retracting anything.
    for (const line of [
      "the club kept the superseded sail numbers on two of the old dinghies",
      "the treasurer's correction to the bar prices went up on Friday",
      "we swapped the deprecated shackles for stainless ones over the winter",
      "ask the harbourmaster about the correction to the tide gauge",
    ]) {
      expect(isBannerText(line), line).toBe(false);
    }
  });
});

describe("retraction() reads a sentence-case correction heading as a correction", () => {
  // The concrete regression, pinned without a brain. A heading that starts with the word
  // "Correction" introduces the CURRENT text; if the heading were read with the
  // case-insensitive block rule, every quote under it would come back as history.
  const text = '## Correction from the race officer\n\nThe first gun fires at 10:55 (was: "the first gun fires at 11:00").\n';
  const blocks = splitBlocks(text);
  const i = blocks.findIndex((b) => b.text.includes("10:55"));

  it("stamps the current claim under that heading as a correction", () => {
    expect(i).toBeGreaterThan(0);
    expect(retraction(blocks, i, "The first gun fires at 10:55")).toBe("correction");
  });

  it("still stamps the retired wording in the same block as retracted", () => {
    expect(retraction(blocks, i, "the first gun fires at 11:00")).toBe("banner");
  });
});

describe.skipIf(!present)("banner parity against the live corpus", () => {
  /**
   * Every block whose own TEXT carries a banner must still classify as one. This is the guarantee
   * that matters: the fix touched headings only, so block-level detection must be untouched, and
   * asserting it here means a future edit to BANNER_RE cannot quietly weaken it either.
   */
  it("every SHOUTED banner in the corpus still fires", () => {
    // The guarantee, restated for a uniform rule. It used to assert that any block whose text
    // contained the WORD still fired — which is the bug, not the contract. What must never
    // regress is that a real banner, the kind house style writes in caps or bold, is caught
    // wherever it sits. House style writes every real banner in caps or bold.
    const missed: string[] = [];
    let checked = 0;

    for (const rel of walk(BRAIN)) {
      const blocks = splitBlocks(readFileSync(join(BRAIN, rel), "utf8"));
      blocks.forEach((b, i) => {
        if (!isBannerText(b.text)) return;
        checked++;
        if (retraction(blocks, i) !== "banner") missed.push(`${rel}:${b.line}`);
      });
    }

    expect(checked, "no shouted banners found — the corpus or the walk is wrong").toBeGreaterThan(20);
    expect(missed, `shouted banners that stopped firing:\n  ${missed.join("\n  ")}`).toEqual([]);
  });

  it("every heading reclassified by this change is prose, never a shouted banner", () => {
    // The other half of the guarantee: enumerate the headings whose classification MOVED, and
    // assert each one reads as prose. If a future edit makes a real `## SUPERSEDED` banner stop
    // firing, it shows up here as a heading that should not have moved.
    const BLOCK_BANNER = /\bSUPERSEDED\b|\bCORRECTION\b|\bDEPRECATED\b|\bDo not answer\b/i;
    const IS_HEADING = /^[ \t]*#{1,6}[ \t]+/;
    const wrongly: string[] = [];

    for (const rel of walk(BRAIN)) {
      for (const b of splitBlocks(readFileSync(join(BRAIN, rel), "utf8"))) {
        if (!IS_HEADING.test(b.text) || !BLOCK_BANNER.test(b.text)) continue;
        const text = b.text.replace(IS_HEADING, "").trim();
        // Moved from banner to prose. That is only correct if it is genuinely not shouted.
        if (!isBannerText(text) && /\b(?:SUPERSEDED|CORRECTION|DEPRECATED)\b/.test(text)) {
          wrongly.push(`${rel}:${b.line} ${text.slice(0, 60)}`);
        }
      }
    }

    expect(wrongly, `all-caps headings must still be banners:\n  ${wrongly.join("\n  ")}`).toEqual([]);
  });

  it("the corrected sections now read as corrections, not as retractions", () => {
    // The concrete regression. A quote of the CURRENT claim beside a `(was: "…")` marker, in a
    // passage no banner covers, must stamp CORRECTED. The passages are found by shape at run
    // time — a block carrying its own quoted marker — so no note path or note text is pinned in
    // this file. A brain with no such passage fails the floor below instead of passing silently.
    let asserted = 0;
    for (const rel of walk(BRAIN)) {
      const blocks = splitBlocks(readFileSync(join(BRAIN, rel), "utf8"));
      blocks.forEach((b, i) => {
        if (isBannerText(b.heading)) return;
        if ([blocks[i - 1], b, blocks[i + 1]].some((n) => n && isBannerText(n.text))) return;
        const m = /was:\s*"([^"]+)"/.exec(b.text);
        if (!m) return;
        // The current claim is the text in front of the marker, in the same block.
        const claim = b.text.slice(0, m.index).replace(/\(\s*$/, "").replace(/^[ \t]*[-*+>]\s*/, "").trim();
        if (normalise(claim).length < MIN_QUOTE) return;
        expect(retraction(blocks, i, claim), `${rel}:${b.line}`).toBe("correction");
        asserted++;

        // ...and quoting the RETIRED wording out of the same block still reads as retracted,
        // which is the half of the split that must not regress.
        if (normalise(m[1]).length >= MIN_QUOTE) {
          expect(retraction(blocks, i, m[1]), `${rel}:${b.line}`).toBe("banner");
        }
      });
    }
    expect(asserted, "no current claim beside a (was: \"…\") marker found — the corpus or the walk is wrong").toBeGreaterThan(0);
  });
});
