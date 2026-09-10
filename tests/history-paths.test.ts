/**
 * `history/` at every gate that enumerates the note prefixes.
 *
 * The prefix was already LIVE before any of this: corpus.ts's SKIP_PREFIX never excluded it, so a
 * history page was retrieved, mirrored, scored and cited from the moment one existed. What did not
 * know about it was every allowlist written as an explicit alternation — the write and read
 * policies, the prose-path scanner the graph builds correction edges from, the pin route, the
 * guest scope. Each of those is a separate regex in a separate module, and each fails in its own
 * quiet way: brain_read refusing a path its own citations name, an edge that never forms, a pin
 * the console cannot place, a guest scope that matches nothing.
 *
 * So they are asserted together, in one file, against one path. A prefix is not "supported"
 * because the router lists it; it is supported when every gate on the way to it agrees.
 *
 * The traversal case is asserted alongside each acceptance for the same reason it always is —
 * widening an alternation is exactly the edit that loosens a pattern by accident.
 */
import { describe, expect, it } from "vitest";
import { validatePath, validateReadPath } from "../lib/brain";
import { isScopeEntry } from "../lib/guest";
import { correctionEdges } from "../lib/edges";
import { ORDER } from "../lib/frontmatter";
import { isHistoryPath, monthKey } from "../lib/digest";

const HISTORY = "history/harbor-2026-08.md";

describe("history/ is a first-class note prefix", () => {
  it("is writable and readable by exact path", () => {
    expect(() => validatePath(HISTORY)).not.toThrow();
    expect(() => validateReadPath(HISTORY)).not.toThrow();
    // The write policy's own error text has to name it too, or a caller refused for an unrelated
    // reason is told to write somewhere that is not the full list of somewheres.
    expect(() => validatePath("secrets.env")).toThrow(/history\/\*\.md/);
  });

  it("refuses traversal through the new prefix", () => {
    expect(() => validatePath("history/../x.md")).toThrow(/Invalid brain path/);
    expect(() => validateReadPath("history/../x.md")).toThrow(/Invalid brain path/);
  });

  it("is a valid guest scope, as an exact note and as a directory prefix", () => {
    expect(isScopeEntry(HISTORY)).toBe(true);
    expect(isScopeEntry("history/")).toBe(true);
    expect(isScopeEntry("history/../x.md")).toBe(false);
    // The trailing slash still matters: `history/harbor` would also cover harbor-private.md.
    expect(isScopeEntry("history/harbor")).toBe(false);
  });

  it("is seen by the graph's prose-path scanner, so corrections can point at it", () => {
    const files = new Map<string, string>([
      ["projects/harbor.md", `SUPERSEDED — the August detail moved to ${HISTORY}\n`],
      [HISTORY, "the August detail\n"],
    ]);
    const edges = correctionEdges(files);
    expect(edges).toHaveLength(1);
    expect(edges[0]).toMatchObject({ src: "projects/harbor.md", dst: HISTORY, kind: "correction" });
  });

  it("is a known directory in the shared order, after log and before archive", () => {
    // ORDER is the ONE array — the router groups by it and INDEX.md's generator lists by it, and
    // that generator DROPS any directory not on it. A prefix missing here is routed, retrievable
    // and absent from the catalogue a human browses, with nothing to notice.
    expect(ORDER.indexOf("history")).toBe(ORDER.indexOf("log") + 1);
    expect(ORDER.indexOf("history")).toBeLessThan(ORDER.indexOf("archive"));
  });

  it("is recognised as a dated month slice, and a day log is not one", () => {
    expect(isHistoryPath(HISTORY)).toBe(true);
    expect(isHistoryPath("history/harbor.md")).toBe(false); // undated — not a month slice
    expect(isHistoryPath("log/2026-08-04.md")).toBe(false);
    expect(monthKey(HISTORY)).toBe("history/harbor-2026-08");
  });
});
