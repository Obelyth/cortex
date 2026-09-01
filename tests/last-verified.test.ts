import { describe, expect, it } from "vitest";
import { lastVerified, stampVerified } from "../lib/health";

/**
 * Which `_Facts last verified_` stamp is the page's claim — the LAST one.
 *
 * The check used to read the first match, which asked "when was the oldest section of this page
 * checked?". On a brain page that is the wrong question: pages here are append-only build logs
 * where each dated section keeps the stamp it was verified under, and the groundskeeper's written
 * convention is that the page ENDS with its current stamp. Measured 2026-08-17: two long project
 * pages were reported 16 days stale off an early section stamp while each carried a stamp five
 * days old at its foot, every night, for a fortnight. Nothing was wrong with either page.
 *
 * The read and the write are pinned together here on purpose. If the queue reads the last stamp
 * and the console's button rewrites the first, the button commits a change, reports success,
 * clears nothing, and quietly restamps a historical section on the way past.
 */
describe("lastVerified — the page's current freshness claim", () => {
  const page = [
    "# Long page",
    "",
    "## An early section",
    "",
    "_Facts last verified 2026-08-01 — the section this line belongs to._",
    "",
    "## A later section",
    "",
    "_Facts last verified 2026-08-12 — bounded pass, live state only._",
    "",
  ].join("\n");

  it("reads the LAST stamp, not the first", () => {
    expect(lastVerified(page)).toBe("2026-08-12");
  });

  it("a single-stamp page is unchanged by the rule", () => {
    expect(lastVerified("body\n\n_Facts last verified 2026-07-04._\n")).toBe("2026-07-04");
  });

  it("a page making no claim returns null rather than a guess", () => {
    expect(lastVerified("# Note\n\nNo stamp anywhere.\n")).toBeNull();
    // Prose ABOUT the convention is not a stamp: the placeholder carries no date to read.
    expect(lastVerified("A note whose `_Facts last verified YYYY-MM-DD` stamp is old.")).toBeNull();
  });

  it("is positional, NOT max-by-date — an out-of-order page stays watched", () => {
    // Deliberate: taking the newest date anywhere would let one freshly-checked section vouch
    // for a page whose real claim is older, and a wrong answer here has to land on "watched".
    const outOfOrder =
      "_Facts last verified 2026-08-12._\n\nlater text\n\n_Facts last verified 2026-08-01._\n";
    expect(lastVerified(outOfOrder)).toBe("2026-08-01");
  });

  it("case-insensitive, and tolerant of the newline the house style wraps stamps across", () => {
    expect(lastVerified("_facts last verified\n2026-06-30 — wrapped._")).toBe("2026-06-30");
  });
});

describe("stampVerified — the button writes the stamp the queue reads", () => {
  const page =
    "## Early\n\n_Facts last verified 2026-08-01 — that section._\n\n" +
    "## Late\n\n_Facts last verified 2026-08-12 — this page's claim._\n";

  it("moves the last stamp and leaves the dated section stamps alone", () => {
    const out = stampVerified(page, "2026-08-17")!;
    expect(out).toContain("_Facts last verified 2026-08-01 — that section._");
    expect(out).toContain("_Facts last verified 2026-08-17 — this page's claim._");
    expect(lastVerified(out)).toBe("2026-08-17");
  });

  it("agrees with lastVerified: stamping today clears the finding it was pressed for", () => {
    expect(lastVerified(stampVerified(page, "2026-08-17")!)).toBe("2026-08-17");
  });

  it("refuses a page with no stamp rather than inventing one", () => {
    expect(stampVerified("# Note\n\nNo claim here.\n", "2026-08-17")).toBeNull();
  });

  it("keeps the rest of the note byte-identical — the text citations are proven against", () => {
    const out = stampVerified(page, "2026-08-17")!;
    expect(out.replace("2026-08-17", "2026-08-12")).toBe(page);
  });

  it("BUG GUARD: works on the shape real stamps actually have — a date followed by prose", () => {
    // The write path used to require the stamp to end right after the date, and the house shape
    // is `_Facts last verified <date> — what was checked, what was skipped._`. So the button
    // refused with "has no stamp to refresh" on very nearly every page the queue flagged, which
    // read as the console being broken rather than the pattern being wrong.
    const real =
      "_Facts last verified 2026-08-12 — bounded pass. Exit codes re-read live; the run tally\n" +
      "came straight out of the log. Not re-checked: the sheet's tab titles. Prior: 08-09, 08-03._";
    const out = stampVerified(real, "2026-08-17")!;
    expect(out).not.toBeNull();
    expect(lastVerified(out)).toBe("2026-08-17");
    // Everything the stamp says about WHAT was checked survives the date change untouched.
    expect(out).toContain("Not re-checked: the sheet's tab titles. Prior: 08-09, 08-03._");
  });

  it("preserves the closing punctuation in both shapes the brain uses", () => {
    expect(stampVerified("_Facts last verified 2026-07-01._", "2026-08-17")).toBe(
      "_Facts last verified 2026-08-17._"
    );
    expect(stampVerified("_Facts last verified 2026-07-01_", "2026-08-17")).toBe(
      "_Facts last verified 2026-08-17_"
    );
  });
});
