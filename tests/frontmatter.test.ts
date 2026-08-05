import { describe, expect, it } from "vitest";
import { parseFrontmatter, routerLine, buildRouter } from "../lib/frontmatter";

describe("parseFrontmatter", () => {
  it("reads description and tags from a real feedback-note shape", () => {
    const text = [
      "---",
      "name: feedback-no-lazy-use-agents",
      'description: "Don\'t stall mid-build; delegate to agent teams."',
      "metadata:",
      "  type: feedback",
      "---",
      "",
      "When there's an approved plan, keep building.",
    ].join("\n");
    const fm = parseFrontmatter(text);
    expect(fm.description).toBe("Don't stall mid-build; delegate to agent teams.");
    // Byte-faithful: everything after the closing fence is kept verbatim, blank line included.
    // Trimming would be a silent rewrite of note text, and note text is what quotes are proven
    // against.
    expect(fm.body).toBe("\nWhen there's an approved plan, keep building.");
  });

  it("reads tags as a YAML flow sequence and as a comma list", () => {
    const flow = "---\ndescription: x\ntags: [cortex, supabase]\n---\nbody";
    const csv = "---\ndescription: x\ntags: cortex, supabase\n---\nbody";
    expect(parseFrontmatter(flow).tags).toEqual(["cortex", "supabase"]);
    expect(parseFrontmatter(csv).tags).toEqual(["cortex", "supabase"]);
  });

  it("reads tags as a YAML block sequence", () => {
    const text = "---\ndescription: x\ntags:\n  - cortex\n  - supabase\n---\nbody";
    expect(parseFrontmatter(text).tags).toEqual(["cortex", "supabase"]);
  });

  // The 74 notes that predate the convention must not become invisible or throw. Absence is
  // the common case on day one, and it has to be a non-event.
  it("degrades to an empty record when there is no frontmatter", () => {
    const fm = parseFrontmatter("# Beacon\n\n## Status\nRetired.");
    expect(fm.description).toBe("");
    expect(fm.tags).toEqual([]);
    expect(fm.body).toBe("# Beacon\n\n## Status\nRetired.");
  });

  // A note that merely CONTAINS `---` (a horizontal rule, or a `--- log/x.md ---` banner) is not
  // a note with frontmatter. Only an opening fence on line 1 counts.
  it("ignores a --- that is not the first line", () => {
    const text = "# Title\n\n---\ndescription: not frontmatter\n---\n";
    expect(parseFrontmatter(text).description).toBe("");
    expect(parseFrontmatter(text).body).toBe(text);
  });

  it("does not treat an unterminated fence as frontmatter", () => {
    const text = "---\ndescription: dangling\nno closing fence here";
    expect(parseFrontmatter(text).description).toBe("");
    expect(parseFrontmatter(text).body).toBe(text);
  });

  it("strips matching quotes but keeps apostrophes and inner colons", () => {
    expect(parseFrontmatter("---\ndescription: 'it: works'\n---\nb").description).toBe("it: works");
    expect(parseFrontmatter("---\ndescription: the operator's brain\n---\nb").description).toBe("the operator's brain");
  });

  it("tolerates CRLF line endings", () => {
    const text = "---\r\ndescription: windows\r\n---\r\nbody";
    expect(parseFrontmatter(text).description).toBe("windows");
  });
});

describe("routerLine", () => {
  it("renders path, description, tags and date", () => {
    const line = routerLine({
      path: "projects/beacon.md",
      description: "Retired 3-tier relay; Relay replaced it.",
      tags: ["beacon", "retired"],
      updated: "2026-07-24",
      stale: false,
    });
    expect(line).toBe(
      "- projects/beacon.md · Retired 3-tier relay; Relay replaced it. · beacon, retired · 2026-07-24"
    );
  });

  // A note with no description still gets a line. Dropping it would make the note invisible in
  // the one surface that lists everything — the exact silent-loss failure this system forbids.
  it("still renders a line when there is no description", () => {
    const line = routerLine({
      path: "notes/x.md",
      description: "",
      tags: [],
      updated: "",
      stale: false,
    });
    expect(line).toBe("- notes/x.md · (no description yet)");
  });

  it("marks a stale description rather than hiding the line", () => {
    const line = routerLine({
      path: "notes/x.md",
      description: "d",
      tags: [],
      updated: "2026-01-01",
      stale: true,
    });
    expect(line).toContain("notes/x.md");
    expect(line).toContain("d");
    expect(line).toContain("STALE");
  });
});

describe("buildRouter", () => {
  const files = new Map<string, string>([
    ["profile.md", "---\ndescription: Who the operator is.\n---\nbody"],
    ["projects/a.md", "---\ndescription: Project A.\ntags: [alpha]\n---\nbody"],
    ["notes/b.md", "# B\nno frontmatter here"],
    ["log/2026-08-04.md", "# Log\n\n## 12:35 · cortex\n\ntext"],
  ]);

  it("groups by directory in the INDEX order and lists every file", () => {
    const out = buildRouter(files);
    const order = ["Root", "projects", "notes", "log"];
    let last = -1;
    for (const d of order) {
      const at = out.indexOf(`## ${d}`);
      expect(at).toBeGreaterThan(last);
      last = at;
    }
    for (const p of files.keys()) expect(out).toContain(p);
  });

  it("carries descriptions where they exist and marks where they do not", () => {
    const out = buildRouter(files);
    expect(out).toContain("Project A.");
    expect(out).toContain("(no description yet)");
  });

  it("reports coverage so the gap is visible instead of implied", () => {
    // 3, not 2: the day-log's description is derived from its own entry headings, so it counts as
    // described without anyone having authored one.
    expect(buildRouter(files)).toMatch(/3 of 4 notes/);
  });

  it("derives a day-log's line instead of asking for a description", () => {
    const out = buildRouter(files);
    expect(out).toContain("- log/2026-08-04.md · 1 entry: cortex · 2026-08-04");
  });

  it("is deterministic — same input, byte-identical output", () => {
    expect(buildRouter(files)).toBe(buildRouter(new Map([...files].reverse())));
  });
});
