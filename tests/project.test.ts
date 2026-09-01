import { describe, expect, it } from "vitest";
import { normaliseProject, mentionsProject } from "../lib/project";

/**
 * These two pure helpers moved out of handoff.ts so the boot call could share them without an
 * import cycle. They now decide project scope on two surfaces — brain_context and brain_handoff —
 * so a drift between them would split what "belongs to cortex" means. Pinned here at their
 * canonical home; handoff.test.ts still exercises them through its re-export.
 */

describe("normaliseProject", () => {
  it("bares and lowercases a name", () => {
    expect(normaliseProject("Cortex")).toBe("cortex");
    expect(normaliseProject("  dock-collection-ops  ")).toBe("dock-collection-ops");
  });
  it("strips the projects/ prefix and the .md suffix", () => {
    expect(normaliseProject("projects/harbor.md")).toBe("harbor");
    expect(normaliseProject("projects/Pier-Ops.md")).toBe("pier-ops");
  });
  it("returns empty for empty or whitespace input — the unscoped signal", () => {
    expect(normaliseProject("")).toBe("");
    expect(normaliseProject("   ")).toBe("");
  });
});

describe("mentionsProject", () => {
  it("matches on a whole-word boundary, case-insensitively", () => {
    expect(mentionsProject("cortex, mcp", "cortex")).toBe(true);
    expect(mentionsProject("Cortex", "cortex")).toBe(true);
    expect(mentionsProject("cortex-learning", "cortex")).toBe(true);
  });
  it("does not match a substring inside another word", () => {
    expect(mentionsProject("vortex", "cortex")).toBe(false);
    expect(mentionsProject("precortex", "cortex")).toBe(false);
    expect(mentionsProject("cortexes", "cortex")).toBe(false); // trailing 'e' is not a boundary
    expect(mentionsProject("cortex-ops, mcp", "cortex")).toBe(true); // '-' is a boundary
  });
  it("treats regex metacharacters in the name as literals", () => {
    expect(mentionsProject("c++ build", "c++")).toBe(true);
    expect(mentionsProject("cxx build", "c++")).toBe(false);
  });
});
