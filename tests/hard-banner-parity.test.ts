import { describe, expect, it } from "vitest";
import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { splitBlocks, retraction, isBannerText } from "../lib/verify";

/**
 * The heading rule was loosened. This proves nothing stopped being caught.
 *
 * `retraction()` used a case-insensitive test on the heading, so `### Correction to the guest door
 * section above` marked its whole section retracted — the freshest passage in the note stamped
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
    for (const h of ["SUPERSEDED 2026-07-25", "CORRECTION — the toolset was backwards", "DEPRECATED"]) {
      expect(isBannerText(h), h).toBe(true);
    }
  });

  it("counts a bold marker whatever its case", () => {
    expect(isBannerText("**Superseded** — see the newer page")).toBe(true);
    expect(isBannerText("**correction** to the guest door")).toBe(true);
  });

  it("counts an explicit directive", () => {
    expect(isBannerText("Do not answer from this page")).toBe(true);
  });

  it("does NOT count the word used as ordinary prose — the bug", () => {
    // Every one of these is a real heading from the corpus. Each marked its whole section dead.
    for (const h of [
      "Correction to the guest door section above (2026-08-03, PR #39 `6f8b168`)",
      "Framing correction (2026-07-25)",
      "Pipeline correction (recovered 2026-07-26)",
      "Correction and full audit 2026-07-26",
      "DEFECT — `brain_recall` can answer from a superseded archive page",
    ]) {
      expect(isBannerText(h), h).toBe(false);
    }
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
    // wherever it sits. Measured across the brain: 67 such lines, and all 67 are caps or bold.
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

  it("a PROSE reference to a correction does NOT retract the text around it", () => {
    // The other half, and the reason this change exists. Lines shaped like real corpus prose.
    for (const line of [
      "and #33 (superseded draft wizard), and live-edits files mid-session",
      "The operator's correction: the console overview design is the ENTIRE landing",
      "hwdb is native and survives updates vs. compiling deprecated libinput-config",
      "see the correction in the recovered-session section above",
    ]) {
      expect(isBannerText(line), line).toBe(false);
    }
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
    // The concrete regression. A quote of the CURRENT claim beside a `(was: "…")` marker, under a
    // heading that says the section is a correction, must stamp CORRECTED.
    const rel = "projects/cortex.md";
    if (!existsSync(join(BRAIN, rel))) return;
    const blocks = splitBlocks(readFileSync(join(BRAIN, rel), "utf8"));

    const i = blocks.findIndex(
      (b) => /A guest gets/.test(b.text) && /was:/.test(b.text)
    );
    if (i < 0) return; // the note was rewritten; nothing to assert

    const claim = "brain_ask (scoped) and brain_propose, and nothing else";
    expect(retraction(blocks, i, claim)).toBe("correction");

    // ...and quoting the RETIRED wording out of the same block still reads as retracted, which is
    // the half of the split that must not regress.
    const old = /was:\s*"([^"]+)"/.exec(blocks[i].text)?.[1];
    if (old) expect(retraction(blocks, i, old)).toBe("banner");
  });
});
