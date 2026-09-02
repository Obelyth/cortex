import { beforeEach, describe, expect, it, vi } from "vitest";
import { corpus } from "./helpers/health-corpus";
import { noteOf } from "../lib/triage-loc";

vi.mock("../lib/corpus", () => ({ loadCorpus: vi.fn() }));

import { loadCorpus } from "../lib/corpus";
import { health } from "../lib/health";

const mLoad = vi.mocked(loadCorpus);

describe("noteOf — mapping a triage loc back to its note path", () => {
  it("returns a bare path unchanged (a stale-stamp loc)", () => {
    expect(noteOf("projects/live.md")).toBe("projects/live.md");
  });

  it("drops a real :line suffix (a credential or superseded-link loc)", () => {
    expect(noteOf("notes/creds.md:42")).toBe("notes/creds.md");
    expect(noteOf("projects/harbor.md:3")).toBe("projects/harbor.md");
  });

  it("keeps a trailing colon that is not a line number", () => {
    // Defensive: paths carry no colon today, but the parser must not amputate one if they did.
    expect(noteOf("weird:name")).toBe("weird:name");
  });

  it("drops the ' · L…' reference list of an unmarked retired-tool loc", () => {
    expect(noteOf("projects/old-tools.md · L3")).toBe("projects/old-tools.md");
    expect(noteOf("projects/old-tools.md · L3, L7, L9")).toBe("projects/old-tools.md");
  });

  it("returns the FIRST path of a co-read / correction pair", () => {
    expect(noteOf("notes/glaze.md ↔ projects/kiln.md")).toBe("notes/glaze.md");
  });
});

/**
 * Producer↔consumer contract: the loc health() actually emits for a retired-tool finding must
 * round-trip back to the note path, or the console's "open the note" and "ask the brain" links
 * carry a needle no note holds and land on an empty screen — the bug this parser branch fixes.
 */
describe("noteOf round-trips the loc health() emits for a retired-tool finding", () => {
  beforeEach(() => vi.resetAllMocks());

  it("the ' · L…' loc resolves back to the flagged note", async () => {
    mLoad.mockResolvedValue(
      corpus([["notes/tool-notes.md", "# Tools\n\nStill runs recall.py against the old index.\n"]]),
    );
    const item = (await health()).triage.find((t) => t.title.startsWith("Unmarked retired-tool"));
    expect(item).toBeDefined();
    expect(item!.loc).toContain(" · L");
    expect(noteOf(item!.loc)).toBe("notes/tool-notes.md");
  });
});
