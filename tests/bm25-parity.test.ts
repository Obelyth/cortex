/**
 * The BM25 mirror — cortex's ranker and the brain's `tools/brain_ask.py` must agree.
 *
 * The operator's Python eval scores retrieval independently of this server, so "the same ranking"
 * has to mean the same thing on both sides or the two disagree while both report success. This
 * reads the real Python source out of the brain checkout and compares its `K1`/`B` to
 * `lib/narrow.ts`'s, the same live-differential shape as `tests/no-brain-leakage.test.ts`'s corpus
 * parity check.
 *
 * WHEN NO BRAIN IS CHECKED OUT this gate cannot run, and that fact is SAID OUT LOUD rather than
 * folded into a silent skip — `describe.skipIf` alone printed "1 passed | 1 skipped" with no
 * reason, and CI never clones a brain, so in CI this file reported green having verified only that
 * cortex's own two constants are 1.5 and 1.0. It had never once compared anything. The README
 * names this test as the mechanism keeping the two implementations honest, which makes a quiet
 * skip a documented false assurance rather than merely a gap.
 *
 * The brain stays OPTIONAL by default, because a developer without a checkout must still be able
 * to run the suite. `REQUIRE_BM25_PARITY=1` turns absence into a hard failure, for CI and any path
 * that publishes. `REQUIRE_EXPORT_GATE=1` does the same, on purpose: that variable already marks
 * "this run actually ports code", and a run that must not publish copied brain text is the same
 * run that must not publish a ranker silently diverged from the brain's — one variable to learn,
 * not two, for the same intent.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { K1, B } from "../lib/narrow";

const BRAIN = process.env.BRAIN_DIR ?? `${process.cwd()}/../brain`;
const py = `${BRAIN}/tools/brain_ask.py`;
const present = existsSync(py);

// Thrown at module load so it cannot be mistaken for one failing assertion inside the suite.
if (!present && (process.env.REQUIRE_BM25_PARITY === "1" || process.env.REQUIRE_EXPORT_GATE === "1")) {
  throw new Error(
    `no brain_ask.py at ${py}, and this run demands the BM25 mirror check (REQUIRE_BM25_PARITY=1 ` +
      `or REQUIRE_EXPORT_GATE=1). Without it nothing here compares cortex's ranker to the brain's, ` +
      `and the two can diverge unnoticed. Clone the brain or set BRAIN_DIR.`
  );
}

describe("BM25 constants", () => {
  it("are the study's measured values", () => { expect(K1).toBe(1.5); expect(B).toBe(1.0); });

  if (!present) {
    // VISIBLE, not silent. The title is the whole point: a run without a brain must not look
    // identical to a run that checked the mirror and found it sound.
    describe.skip(
      `mirror brain_ask.py SKIPPED — no brain_ask.py at ${py}, so NOTHING here compared cortex's ` +
        `ranker to the brain's (set BRAIN_DIR, or REQUIRE_BM25_PARITY=1 to fail instead)`,
      () => {
        it("did not run", () => {});
      }
    );
  }

  describe.skipIf(!present)("mirror brain_ask.py", () => {
    it("uses the same k1 and b", () => {
      const src = readFileSync(py, "utf8");
      // Names the fix by commit HASH and describes it in our own words. Quoting the brain's commit
      // SUBJECT verbatim, as this once did, puts a 62-character line of brain-side history into
      // shipped source — and the day a log note records that subject on its own line, the export
      // gate turns this file red for something that is not a leak.
      const MIRROR_HINT =
        "brain_ask.py's BM25 line has drifted from lib/narrow.ts's rank() — the two must read " +
        "the same formula off named K1/B constants, on one line, or this repo cannot tell the " +
        "two implementations still agree. The fix is brain commit 128c366 on the brain repo's " +
        "split/mega-pages branch, which sets brain_ask.py's k1 and b to the values below; merge " +
        "it to the brain's main, don't relax this test.";
      const m = /s \+= idf \* \(f \* \(K1 \+ 1\)\) \/ \(f \+ K1 \* \(\(1 - B\) \+ B \* dl \/ avgdl\)\)/.exec(src);
      expect(m, `${MIRROR_HINT} (formula line not found)`).toBeTruthy();
      const k1m = /^K1 = ([\d.]+)$/m.exec(src);
      const bm = /^B = ([\d.]+)$/m.exec(src);
      expect(k1m, `${MIRROR_HINT} (no "K1 = ..." constant)`).toBeTruthy();
      expect(bm, `${MIRROR_HINT} (no "B = ..." constant)`).toBeTruthy();
      const k1 = Number(k1m![1]); const b = Number(bm![1]);
      expect(k1, `${MIRROR_HINT} (brain_ask.py K1=${k1}, lib/narrow.ts K1=${K1})`).toBe(K1);
      expect(b, `${MIRROR_HINT} (brain_ask.py B=${b}, lib/narrow.ts B=${B})`).toBe(B);
    });
  });
});
