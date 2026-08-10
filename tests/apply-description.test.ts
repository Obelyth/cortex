import { describe, expect, it } from "vitest";
import { applyDescription } from "../lib/frontmatter";
import { parseFrontmatter } from "../lib/frontmatter";

describe("applyDescription", () => {
  it("prepends a block to a note that has none, leaving the body byte-identical", () => {
    const body = "# Quarry\n\n## Status\nRetired.\n";
    const out = applyDescription(body, "Retired relay app", ["quarry", "retired"]);
    expect(out).toBe(
      '---\ndescription: "Retired relay app"\ntags: [quarry, retired]\n---\n\n# Quarry\n\n## Status\nRetired.\n'
    );
    expect(parseFrontmatter(out).body).toBe(`\n${body}`);
  });

  // The nine feedback-* notes already carry name/description/metadata. Re-running the backfill
  // over them must not stack a second fence or reorder what is there.
  it("leaves an existing description alone", () => {
    const existing = '---\nname: x\ndescription: "already here"\n---\n\nbody\n';
    expect(applyDescription(existing, "new one", ["a"])).toBe(existing);
  });

  it("inserts into an existing block that has no description, preserving the other keys", () => {
    const existing = "---\nname: x\nmetadata:\n  type: feedback\n---\n\nbody\n";
    const out = applyDescription(existing, "added", ["a"]);
    expect(parseFrontmatter(out).description).toBe("added");
    expect(out).toContain("name: x");
    expect(out).toContain("  type: feedback");
    expect(parseFrontmatter(out).body).toBe("\nbody\n");
    expect(out.match(/^---$/gm)?.length).toBe(2);
  });

  it("is idempotent — running it twice changes nothing the second time", () => {
    const body = "# A\n\ntext\n";
    const once = applyDescription(body, "d", ["t"]);
    expect(applyDescription(once, "d", ["t"])).toBe(once);
  });

  it("preserves CRLF notes without converting their line endings", () => {
    const out = applyDescription("# A\r\n\r\nbody\r\n", "d", []);
    expect(out).toContain("# A\r\n");
    expect(out.startsWith("---\n")).toBe(true);
  });

  it("omits the tags key entirely when there are no tags", () => {
    expect(applyDescription("body", "d", [])).toBe('---\ndescription: "d"\n---\n\nbody');
  });

  // A description carrying a double quote would produce invalid YAML and, worse, a parse that
  // silently truncates. Refuse loudly rather than write a note we cannot read back.
  it.each(['has "quotes"', "line\nbreak", ""])("refuses an unusable description %j", (bad) => {
    expect(() => applyDescription("body", bad, [])).toThrow(/description/i);
  });

  it("refuses a tag that would break the flow sequence", () => {
    expect(() => applyDescription("body", "d", ["ok", "not,ok"])).toThrow(/tag/i);
  });

  // The whole point: a round trip must return exactly what we put in.
  it("round-trips through the parser for every note shape", () => {
    for (const body of ["plain", "# H\n\ntext", "---\nname: n\n---\n\nb", "a\n\n---\n\nb"]) {
      const out = applyDescription(body, "round trip", ["x"]);
      expect(parseFrontmatter(out).description, body).toBe("round trip");
      expect(parseFrontmatter(out).tags, body).toEqual(["x"]);
    }
  });
});
