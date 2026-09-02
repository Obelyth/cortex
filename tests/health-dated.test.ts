import { beforeEach, describe, expect, it, vi } from "vitest";
import { corpus } from "./helpers/health-corpus";

vi.mock("../lib/corpus", () => ({ loadCorpus: vi.fn() }));

import { loadCorpus } from "../lib/corpus";
import { health } from "../lib/health";

const mLoad = vi.mocked(loadCorpus);
beforeEach(() => vi.resetAllMocks());

/**
 * A note whose filename is a date — `log/2026-07-26.md` — is a record OF that date, not a
 * standing claim, so its "_Facts last verified_" stamp cannot go stale. DATED_ENTRY already
 * takes such files off the retired-tool check for exactly this reason; they must be off the
 * stale-stamp clock too.
 *
 * Regression this guards: `log/2026-08-17.md` carried an old stamp and rode the groundskeeper's
 * re-verify queue every night, asking the operator to re-verify his own diary — a slot burned on
 * a page that can never resolve.
 *
 * Failure direction, same as decays: a standing claim wrongly skipped is a stale fact answered as
 * current, so the control note MUST still be flagged. The exclusion is narrow by filename shape.
 */
const STAMPED = (body = "_Facts last verified 2026-07-01._") =>
  `---\ndescription: "d"\n---\n\n# Page\n\n${body}\n`;

describe("dated-entry notes are off the stale-stamp clock", () => {
  const NOW = new Date("2026-08-11T12:00:00Z"); // 41 days past the 2026-07-01 stamp

  it("a day-log with an old stamp is never flagged stale, but a standing note still is", async () => {
    mLoad.mockResolvedValue(
      corpus([
        ["log/2026-07-26.md", STAMPED()], // dated entry — must be skipped
        ["projects/live.md", STAMPED()], // standing claim — must still be flagged
      ])
    );
    const h = await health(NOW);
    const stalePaths = h.stale.map((s) => s.path);
    expect(stalePaths).not.toContain("log/2026-07-26.md");
    expect(stalePaths).toContain("projects/live.md");
  });

  it("excludes by the YYYY-MM-DD.md filename shape, not the log/ directory alone", async () => {
    mLoad.mockResolvedValue(corpus([["notes/2026-01-01.md", STAMPED()]]));
    const h = await health(NOW);
    expect(h.stale).toEqual([]);
  });
});
