import { beforeEach, describe, expect, it, vi } from "vitest";
import { corpus } from "./helpers/health-corpus";

vi.mock("../lib/corpus", () => ({ loadCorpus: vi.fn() }));

import { loadCorpus } from "../lib/corpus";
import { health } from "../lib/health";

const mLoad = vi.mocked(loadCorpus);


beforeEach(() => {
  vi.resetAllMocks();
});

/**
 * The ledger's expansion shows what a note says about itself — which makes health() the second
 * place (after retractedList) where note TEXT leaves the server for a screen. Same law applies:
 * everything is redacted on the way out, and a note with nothing to say yields empty strings,
 * never an invented description.
 */
describe("note self-description", () => {
  it("extracts title, first prose line and the outline with real line numbers", async () => {
    mLoad.mockResolvedValue(
      corpus([
        [
          "projects/tandem.md",
          "# Tandem — plates intake\n\nThe plates backlog went into a deleted database.\n\n## Recovery\n\ndetails here\n\n## Status\n\nmore\n",
        ],
      ])
    );
    const h = await health();
    const n = h.notes[0];
    expect(n.title).toBe("Tandem — plates intake");
    expect(n.desc).toBe("The plates backlog went into a deleted database.");
    expect(n.headings).toEqual([
      { h: "Tandem — plates intake", line: 1 },
      { h: "Recovery", line: 5 },
      { h: "Status", line: 9 },
    ]);
  });

  it("falls back to the filename for a headingless note, and to no description at all", async () => {
    // "No description" must mean the note has none — not a parser opinion dressed as data.
    mLoad.mockResolvedValue(corpus([["notes/scraps.md", "> just a quote\n\n```\ncode\n```\n"]]));
    const h = await health();
    expect(h.notes[0].title).toBe("scraps");
    expect(h.notes[0].desc).toBe("");
  });

  it("redacts every field on the way out — the console is an egress too", async () => {
    mLoad.mockResolvedValue(
      corpus([
        [
          "notes/ops.md",
          "# Ops ADMIN_PASSWORD=3121\n\nThe admin password: hunter2 is set for prod.\n\n## Rotate token=abc123 soon\n\nx\n",
        ],
      ])
    );
    const h = await health();
    const n = h.notes[0];
    for (const s of [n.title, n.desc, ...n.headings.map((x) => x.h)]) {
      expect(s).not.toContain("3121");
      expect(s).not.toContain("hunter2");
      expect(s).not.toContain("abc123");
    }
    expect(n.title).toContain("<redacted>");
  });

  it("takes a list item as a first line rather than calling the note empty", async () => {
    mLoad.mockResolvedValue(corpus([["log/2026-08-04.md", "- 09:12 shipped the release\n"]]));
    const h = await health();
    expect(h.notes[0].desc).toBe("09:12 shipped the release");
  });
});
