import { describe, expect, it } from "vitest";
import { verifyQuote, retraction, retracted, splitBlocks } from "../lib/verify";

/**
 * A banner retires a passage. An in-place correction does the opposite — house style is
 * `<current claim> (was: "<old claim>")`, so the block carrying `was:` is the block carrying the
 * truth. Both used to produce the same stamp: "It is history, not the current state. Do not
 * answer from it." Measured on the live brain, that fired on two CORRECT, CURRENT answers about
 * the most recently corrected content in the corpus.
 *
 * The fix is wording, not detection. Nothing that was flagged before is silent now — these tests
 * pin both halves of that.
 */

const CORRECTION =
  'Cortex runs on Vercel (was: "cortex runs on Fly.io" — updated 2026-07-20). The deploy is stateless.';

const BANNER =
  "> **SUPERSEDED 2026-07-25 — production is dark.**\n\nSHIPPED 2026-07-14: live in production.";

describe("a correction is not a retraction", () => {
  it("stamps the CURRENT claim beside a (was: …) marker as corrected, not dead", () => {
    const v = verifyQuote(CORRECTION, "Cortex runs on Vercel");
    expect(v.verified).toBe(true);
    expect(v.retraction).toBe("correction");
    // Still flagged. The broad boolean every other caller reads is unchanged — only the
    // sentence render() prints depends on the new field.
    expect(v.superseded).toBe(true);
  });

  it("stamps the RETIRED wording inside (was: …) as genuinely superseded", () => {
    // The one case a `was:` marker alone cannot decide, and the case the landmine test hunts:
    // quoting the inside of the parenthetical is a dead citation.
    const v = verifyQuote(CORRECTION, "cortex runs on Fly.io");
    expect(v.verified).toBe(true);
    expect(v.retraction).toBe("banner");
    expect(v.superseded).toBe(true);
  });

  it("leaves an explicit banner exactly as strong as it was", () => {
    const v = verifyQuote(BANNER, "SHIPPED 2026-07-14: live in production.");
    expect(v.verified).toBe(true);
    expect(v.retraction).toBe("banner");
    expect(v.superseded).toBe(true);
  });

  it("treats a SUPERSEDED heading as a banner for everything under it", () => {
    const text = "# Done — SUPERSEDED 2026-07-30\n\nrecall.py ranked the index.";
    const v = verifyQuote(text, "recall.py ranked the index.");
    expect(v.retraction).toBe("banner");
  });

  it("reports no retraction on ordinary prose", () => {
    const v = verifyQuote("The plates backlog went into a deleted database.", "plates backlog");
    expect(v.retraction).toBe("none");
    expect(v.superseded).toBeFalsy();
  });
});

describe("detection stayed as broad as it was", () => {
  // The regression that matters most: this change must not make anything silent. `retracted()`
  // is the original boolean, untouched, and it must still fire everywhere it used to.
  const cases = [CORRECTION, BANNER, "# Done — SUPERSEDED 2026-07-30\n\nrecall.py ranked it.",
    "DEPRECATED — the old route.\n\nPOST /api/v1/ask still works.",
    "Do not answer from this.\n\nThe server is on Fly."];

  it("flags every shape the corpus actually uses", () => {
    for (const text of cases) {
      const blocks = splitBlocks(text);
      const flagged = blocks.some((_, i) => retracted(blocks, i));
      expect(flagged, text.slice(0, 40)).toBe(true);
    }
  });

  it("classifies a was:-only neighbour as a correction, and a banner neighbour as a banner", () => {
    const near = splitBlocks('The port is 3310.\n\nThe host is local (was: "the host is prod").');
    expect(retraction(near, 0, "The port is 3310.")).toBe("correction");

    const banner = splitBlocks("The port is 3310.\n\n> **DEPRECATED — see the new note.**");
    expect(retraction(banner, 0, "The port is 3310.")).toBe("banner");
  });

  it("does not let an overlapping old claim slip through as current", () => {
    // Partial overlap in either direction still resolves to the retired wording. A quote that
    // is a fragment of the old claim is exactly as dead as the whole of it.
    const v = verifyQuote(CORRECTION, "runs on Fly.io");
    expect(v.retraction).toBe("banner");
  });
});
