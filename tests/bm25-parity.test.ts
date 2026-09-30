/**
 * The BM25 mirror — cortex's ranker and the brain-side reference ranker must agree.
 *
 * Retrieval can be scored by a separate implementation outside this server, so "the same ranking"
 * has to mean the same thing on both sides or the two disagree while both report success. This
 * reads that reference ranker's source and compares its `K1`/`B` to `lib/narrow.ts`'s, the same
 * live-differential shape as `tests/no-brain-leakage.test.ts`'s corpus parity check.
 *
 * WHERE THE REFERENCE LIVES is deployment detail, so this repo does not name it:
 * BRAIN_PARITY_RANKER holds its path. When it is unset this gate cannot run, and that fact is SAID
 * OUT LOUD rather than folded into a silent skip — `describe.skipIf` alone printed "1 passed |
 * 1 skipped" with no reason, and a run that had verified only that cortex's own two constants are
 * 1.5 and 1.0 looked identical to one that had compared them with anything. This test is the
 * mechanism keeping the two implementations honest, which makes a quiet skip a false assurance
 * rather than merely a gap.
 *
 * The reference stays OPTIONAL by default, because a developer without one must still be able to
 * run the suite. `REQUIRE_BM25_PARITY=1` turns absence into a hard failure, for any run that must
 * prove the mirror. A path that is set but missing always fails.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { K1, B } from "../lib/narrow";

const py = process.env.BRAIN_PARITY_RANKER ?? "";
const present = py !== "" && existsSync(py);

// Thrown at module load so it cannot be mistaken for one failing assertion inside the suite.
if (!present && (py !== "" || process.env.REQUIRE_BM25_PARITY === "1")) {
  throw new Error(
    `no reference ranker at ${py || "(BRAIN_PARITY_RANKER unset)"}, and this run demands the BM25 ` +
      `mirror check. Without it nothing here compares cortex's ranker to the reference, and the ` +
      `two can diverge unnoticed. Set BRAIN_PARITY_RANKER to the reference ranker's source file.`
  );
}

describe("BM25 constants", () => {
  it("are the tuned values the mirror pins", () => { expect(K1).toBe(1.5); expect(B).toBe(1.0); });

  if (!present) {
    // VISIBLE, not silent. The title is the whole point: a run without the reference must not look
    // identical to a run that checked the mirror and found it sound.
    describe.skip(
      `reference ranker mirror SKIPPED — BRAIN_PARITY_RANKER is not set, so NOTHING here compared ` +
        `cortex's ranker to the reference (set it, or REQUIRE_BM25_PARITY=1 to fail instead)`,
      () => {
        it("did not run", () => {});
      }
    );
  }

  describe.skipIf(!present)("reference ranker mirror", () => {
    it("uses the same k1 and b", () => {
      const src = readFileSync(py, "utf8");
      // Describes the fix in generic terms only. Naming brain-side history here — a commit, a
      // branch, a commit subject — would put private repo detail into shipped source, and the
      // day a log note records such a line verbatim the export gate turns this file red for
      // something that is not a leak.
      const MIRROR_HINT =
        "the brain-side ranker's BM25 line has drifted from lib/narrow.ts's rank() — the two must " +
        "read the same formula off named K1/B constants, on one line, or this repo cannot tell the " +
        "two implementations still agree. Fix the brain-side script so its k1 and b match the " +
        "values below; don't relax this test.";
      const m = /s \+= idf \* \(f \* \(K1 \+ 1\)\) \/ \(f \+ K1 \* \(\(1 - B\) \+ B \* dl \/ avgdl\)\)/.exec(src);
      expect(m, `${MIRROR_HINT} (formula line not found)`).toBeTruthy();
      const k1m = /^K1 = ([\d.]+)$/m.exec(src);
      const bm = /^B = ([\d.]+)$/m.exec(src);
      expect(k1m, `${MIRROR_HINT} (no "K1 = ..." constant)`).toBeTruthy();
      expect(bm, `${MIRROR_HINT} (no "B = ..." constant)`).toBeTruthy();
      const k1 = Number(k1m![1]); const b = Number(bm![1]);
      expect(k1, `${MIRROR_HINT} (reference K1=${k1}, lib/narrow.ts K1=${K1})`).toBe(K1);
      expect(b, `${MIRROR_HINT} (reference B=${b}, lib/narrow.ts B=${B})`).toBe(B);
    });
  });
});
