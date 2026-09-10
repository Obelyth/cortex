/**
 * The split, proven byte-for-byte.
 *
 * A project page that has grown past a quarter of a megabyte cannot be read into a boot call, and
 * the fix — keep the status at the top, move the dated record out to monthly notes — is a text
 * surgery on the operator's only copy of that record. So the property this suite pins is not
 * "the output looks right", it is that EVERY H2 section of the original survives verbatim,
 * exactly once, across the pieces. Anything softer (trimmed, re-joined, normalised) would let a
 * split quietly drop a paragraph, and nothing downstream would ever notice.
 *
 * The page name here is `harbor` — a placeholder, as in tests/history-paths.test.ts. The real
 * pages this runs against are named nowhere in this repository: the export gate reads the live
 * brain and fails on any real note path in shipped source, and once the split has actually run,
 * `history/<real-name>-YYYY-MM.md` IS a real note path.
 */
import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { splitPage, verifySplit, writeSplit } from "../scripts/split-project-page";

const page = `---
description: "page"
tags: [a]
---

# Title

intro line

## Status
now

## Decisions
- d1

## Next
- n1

## Known defects (found 2026-07-25)
defect text

## Build phase — started 2026-08-19 evening
build text

**[stated, 2026-08-20]** an append with a stamp

## Verification pass 2026-08-31 — retrieval health
verify text
`;

describe("splitPage", () => {
  const out = splitPage(page, { name: "harbor", keepHeadings: ["Status", "Decisions", "Next"], maxStatusBytes: 8192 });
  it("keeps the frontmatter, the title, the intro and the kept sections on the status page", () => {
    expect(out.status.startsWith("---\ndescription:")).toBe(true);
    expect(out.status).toContain("# Title");
    expect(out.status).toContain("## Status\nnow");
    expect(out.status).toContain("## Next\n- n1");
    expect(out.status).not.toContain("defect text");
  });
  it("moves dated sections into history files named by month, in order, verbatim", () => {
    expect([...out.history.keys()]).toEqual(["history/harbor-2026-07.md", "history/harbor-2026-08.md"]);
    expect(out.history.get("history/harbor-2026-07.md")).toContain("## Known defects (found 2026-07-25)\ndefect text");
    const aug = out.history.get("history/harbor-2026-08.md")!;
    expect(aug.indexOf("## Build phase")).toBeLessThan(aug.indexOf("## Verification pass"));
  });
  it("gives every history file frontmatter with description, tags and decays: false", () => {
    for (const [p, t] of out.history) expect(t, p).toMatch(/^---\ndescription: ".+"\ntags: \[.+\]\ndecays: false\n---\n/);
  });
  it("links the status page to its history", () => {
    expect(out.status).toContain("history/harbor-2026-08.md");
  });
  it("verifies byte preservation of every section", () => {
    expect(verifySplit(page, out.status, out.history)).toEqual({ ok: true, missing: [], duplicated: [] });
    const broken = new Map(out.history);
    broken.set("history/harbor-2026-08.md", broken.get("history/harbor-2026-08.md")!.replace("build text", "build txt"));
    expect(verifySplit(page, out.status, broken).ok).toBe(false);
  });
  it("assigns an undated section to the month of the previous dated section, and refuses when the status page would exceed the cap", () => {
    const withUndated = page + "\n## Loose thoughts\nno date here\n";
    const o = splitPage(withUndated, { name: "harbor", keepHeadings: ["Status"], maxStatusBytes: 8192 });
    expect(o.history.get("history/harbor-2026-08.md")).toContain("## Loose thoughts");
    expect(o.report.undated).toBe(1);
    expect(() =>
      splitPage(page, {
        name: "harbor",
        keepHeadings: ["Status", "Decisions", "Next", "Known defects (found 2026-07-25)"],
        maxStatusBytes: 60,
      })
    ).toThrow(/status page/);
  });

  // The rest of this suite is not in the plan's fixture. It pins the decisions the plan's prose
  // states but its assertions do not reach — the ones a rewrite could silently invert.

  it("counts a leading undated section separately from one that inherits a month", () => {
    // Decisions and Next are undated and stand BEFORE any dated section, so nothing precedes them
    // to inherit from; they land in the earliest month by a different rule and are reported as
    // their own number. Folding them into `undated` would hide which sections were placed by a
    // guess carried forward and which by a fallback.
    const o = splitPage(page, { name: "harbor", keepHeadings: ["Status"], maxStatusBytes: 8192 });
    expect(o.report.undated).toBe(0);
    expect(o.report.undatedLeading).toBe(2);
    expect(o.history.get("history/harbor-2026-07.md")).toContain("## Decisions");
  });

  it("reports what it did", () => {
    expect(out.report.sections).toBe(6);
    expect(out.report.kept).toBe(3);
    expect(out.report.moved).toBe(3);
    expect(out.report.statusBytes).toBe(Buffer.byteLength(out.status, "utf8"));
  });

  it("dates a section from its first stamp when the heading carries no date", () => {
    const stamped = `# T\n\n## An untitled turn\n\n**[inferred, 2026-05-04]** a stamped line\n`;
    const o = splitPage(stamped, { name: "harbor", keepHeadings: [], maxStatusBytes: 8192 });
    expect([...o.history.keys()]).toEqual(["history/harbor-2026-05.md"]);
  });

  it("does not see a `## ` line inside a fenced code block as a heading", () => {
    const fenced = `# T\n\n## Real 2026-03-01\n\n\`\`\`md\n## Not a heading\n\`\`\`\n\n## Also real 2026-04-01\ntext\n`;
    const o = splitPage(fenced, { name: "harbor", keepHeadings: [], maxStatusBytes: 8192 });
    expect(o.report.sections).toBe(2);
    expect(o.history.get("history/harbor-2026-03.md")).toContain("## Not a heading");
    expect(verifySplit(fenced, o.status, o.history).ok).toBe(true);
  });

  it("matches a kept heading by its leading words, case-insensitively, and keeps only the LAST", () => {
    // An earlier block under a kept heading is a superseded version of it: the page's "Next" list
    // from three weeks ago is history by definition, and it is dated by whatever it sits under.
    // Keeping every match would carry every superseded plan onto the status page and re-assert it
    // as current — the exact thing this split exists to stop.
    const repeated = `# T\n\n## Next\n- a\n\n## Done 2026-02-01\nx\n\n## next — the second list\n- b\n`;
    const o = splitPage(repeated, { name: "harbor", keepHeadings: ["next"], maxStatusBytes: 8192 });
    expect(o.report.kept).toBe(1);
    expect(o.status).not.toContain("- a");
    expect(o.status).toContain("- b");
    expect(o.history.get("history/harbor-2026-02.md")).toContain("## Next\n- a");
    expect(verifySplit(repeated, o.status, o.history).ok).toBe(true);
  });

  it("splits a month too big for one note into ordered parts, and leaves a small month alone", () => {
    // A month is not a size. One month of a busy project can be 240 KB, and a history note that
    // large defeats the split — a retrieval that pulls it is back to the pack size the split was
    // meant to cure. So the month is the FILING rule and the byte cap is the FILE rule, and where
    // they disagree the month is written as parts.
    const body = (c: string) => c.repeat(400);
    const big = `# T\n\n## One 2026-04-01\n${body("a")}\n\n## Two 2026-04-02\n${body("b")}\n\n## Three 2026-04-03\n${body("c")}\n\n## Small 2026-05-01\nx\n`;
    const o = splitPage(big, { name: "harbor", keepHeadings: [], maxStatusBytes: 8192, maxHistoryBytes: 900 });
    expect([...o.history.keys()]).toEqual([
      "history/harbor-2026-04-1.md",
      "history/harbor-2026-04-2.md",
      "history/harbor-2026-05.md",
    ]);
    expect(o.history.get("history/harbor-2026-04-1.md")).toContain("part 1 of 2");
    expect(o.history.get("history/harbor-2026-04-2.md")).toContain("part 2 of 2");
    // No section is ever cut in half to make a part fit: the boundary falls between sections.
    expect(o.history.get("history/harbor-2026-04-1.md")).toContain("## Two 2026-04-02");
    expect(o.history.get("history/harbor-2026-04-2.md")).toContain("## Three 2026-04-03");
    expect(o.status).toContain("history/harbor-2026-04-2.md");
    expect(verifySplit(big, o.status, o.history)).toEqual({ ok: true, missing: [], duplicated: [] });
  });

  it("gives a part its own section rather than splitting one, even when one section busts the cap", () => {
    const huge = `# T\n\n## One 2026-04-01\n${"a".repeat(500)}\n\n## Two 2026-04-02\n${"b".repeat(500)}\n`;
    const o = splitPage(huge, { name: "harbor", keepHeadings: [], maxStatusBytes: 8192, maxHistoryBytes: 10 });
    expect([...o.history.keys()]).toEqual(["history/harbor-2026-04-1.md", "history/harbor-2026-04-2.md"]);
    expect(verifySplit(huge, o.status, o.history).ok).toBe(true);
  });

  it("preserves the whitespace BETWEEN two sections that stay together", () => {
    // The bytes between one section and the next are part of the first section, not a separator
    // this script gets to choose. A re-join with "\n\n" would pass every other assertion here and
    // still rewrite the file — including the blank line before a trailing stamped append.
    expect(out.history.get("history/harbor-2026-08.md")).toContain(
      "build text\n\n**[stated, 2026-08-20]** an append with a stamp\n\n## Verification pass"
    );
  });

  it("names a missing section rather than only failing", () => {
    const broken = new Map(out.history);
    broken.delete("history/harbor-2026-07.md");
    const v = verifySplit(page, out.status, broken);
    expect(v.ok).toBe(false);
    expect(v.missing.join(" ")).toContain("Known defects");
  });

  it("fails verification when the frontmatter or the preamble did not reach the status page", () => {
    expect(verifySplit(page, out.status.replace("intro line", ""), out.history).missing).toContain("(preamble)");
    expect(verifySplit(page, out.status.slice(4), out.history).missing).toContain("(frontmatter)");
  });

  // Verification is STRUCTURAL: each output file is parsed back into sections and those sections
  // are matched to the original's by exact bytes, one for one. Counting substrings instead — the
  // first version of this — reports the same text found twice as a duplicate, and there are three
  // ordinary ways for one section's bytes to occur inside another's.

  it("verifies a section whose body is a prefix of another section's", () => {
    // The second block is the last on the page, so its body lacks the trailing blank line the
    // first one carries. Its bytes are therefore a prefix of the first's, and a substring count
    // finds it twice.
    const prefixy = `# T\n\n## Alpha 2026-01-01\nshared line\n\n## Alpha 2026-01-01\nshared line\n`;
    const o = splitPage(prefixy, { name: "harbor", keepHeadings: [], maxStatusBytes: 8192 });
    expect(verifySplit(prefixy, o.status, o.history)).toEqual({ ok: true, missing: [], duplicated: [] });
  });

  it("verifies two byte-identical sections as two sections, not as a duplicate", () => {
    const twins = `# T\n\n## Twin 2026-01-01\nsame\n\n## Twin 2026-01-01\nsame\n\n## Tail 2026-01-02\nend\n`;
    const o = splitPage(twins, { name: "harbor", keepHeadings: [], maxStatusBytes: 8192 });
    expect(verifySplit(twins, o.status, o.history)).toEqual({ ok: true, missing: [], duplicated: [] });
    // And losing ONE of the twins is still a failure: two must mean two.
    const short = new Map(o.history);
    short.set("history/harbor-2026-01.md", short.get("history/harbor-2026-01.md")!.replace("## Twin 2026-01-01\nsame\n\n", ""));
    expect(verifySplit(twins, o.status, short).ok).toBe(false);
  });

  it("does not count a section quoted inside another section's code fence", () => {
    const quoted = `# T\n\n## Real 2026-01-01\nbody\n\n## Notes 2026-02-01\n\`\`\`md\n## Real 2026-01-01\nbody\n\n\`\`\`\n`;
    const o = splitPage(quoted, { name: "harbor", keepHeadings: [], maxStatusBytes: 8192 });
    expect(verifySplit(quoted, o.status, o.history)).toEqual({ ok: true, missing: [], duplicated: [] });
  });

  it("rejects an output file carrying a section the original never had", () => {
    const forged = new Map(out.history);
    forged.set("history/harbor-2026-07.md", `${forged.get("history/harbor-2026-07.md")!}\n## Invented 2026-07-01\nnot from the page\n`);
    const v = verifySplit(page, out.status, forged);
    expect(v.ok).toBe(false);
    expect(v.duplicated.join(" ")).toContain("Invented");
  });

  it("does not read a serial number as a date", () => {
    // `1234-56-78` is the shape of a date and none of its values. Reading it as one files the
    // section under month 56 and names a note nothing can route to.
    const serial = `# T\n\n## Serial 1234-56-78\nnot dated\n\n## Real 2026-06-01\ndated\n`;
    const o = splitPage(serial, { name: "harbor", keepHeadings: [], maxStatusBytes: 8192 });
    expect([...o.history.keys()]).toEqual(["history/harbor-2026-06.md"]);
    expect(o.report.undatedLeading).toBe(1);
  });

  it("leaves a page with no dated section alone rather than inventing a month", () => {
    const undatedOnly = `# T\n\n## Status\nnow\n\n## Thoughts\nsome\n`;
    const o = splitPage(undatedOnly, { name: "harbor", keepHeadings: ["Status"], maxStatusBytes: 8192 });
    expect(o.history.size).toBe(0);
    expect(o.report.moved).toBe(0);
    expect(o.status).toBe(undatedOnly);
  });
});

/**
 * The second run.
 *
 * Everything above proves the split accounts for the page it was handed. This proves the one
 * thing that reasoning structurally cannot reach: bytes already on disk from an EARLIER run.
 * Splitting a page that has since gained a new dated session used to write the new sections over
 * `history/<name>-YYYY-MM.md` and delete the record filed there, while the run reported "every
 * section preserved byte-for-byte" — verifySplit partitions the ORIGINAL page, the worktree gate
 * looks for uncommitted changes and the first split was committed, and the from-disk re-verify
 * re-reads only what it just wrote. A refusal is the only place that check can live.
 *
 * The temp directory is a throwaway, never a brain checkout.
 */
describe("writeSplit — refuses rather than overwrite a history file it did not write", () => {
  function scratch<T>(run: (brain: string) => T): T {
    const brain = mkdtempSync(join(tmpdir(), "split-write-"));
    try {
      return run(brain);
    } finally {
      rmSync(brain, { recursive: true, force: true });
    }
  }

  const KEEP = { name: "harbor", keepHeadings: ["Status", "Decisions", "Next"], maxStatusBytes: 8192 };

  it("writes history first and the page last on a first run", () => {
    scratch((brain) => {
      mkdirSync(join(brain, "projects"), { recursive: true });
      writeFileSync(join(brain, "projects/harbor.md"), page, "utf8");
      const out = splitPage(page, KEEP);
      expect(writeSplit(brain, "projects/harbor.md", out)).toEqual([
        "history/harbor-2026-07.md",
        "history/harbor-2026-08.md",
        "projects/harbor.md",
      ]);
      for (const [p, text] of out.history) expect(readFileSync(join(brain, p), "utf8"), p).toBe(text);
      expect(readFileSync(join(brain, "projects/harbor.md"), "utf8")).toBe(out.status);
    });
  });

  it("refuses a re-split of an already-split page and leaves every byte on disk untouched", () => {
    scratch((brain) => {
      mkdirSync(join(brain, "projects"), { recursive: true });
      writeFileSync(join(brain, "projects/harbor.md"), page, "utf8");
      const first = splitPage(page, KEEP);
      writeSplit(brain, "projects/harbor.md", first);

      // What an operator actually does next: the status page accrues another dated session, in a
      // month that already has a history note, and the same command gets run again.
      const grown = `${readFileSync(join(brain, "projects/harbor.md"), "utf8")}\n## Second pass 2026-08-30\nnew work\n`;
      writeFileSync(join(brain, "projects/harbor.md"), grown, "utf8");

      const before = new Map(
        ["projects/harbor.md", ...first.history.keys()].map((p) => [p, readFileSync(join(brain, p), "utf8")])
      );
      const second = splitPage(grown, KEEP);
      expect([...second.history.keys()]).toContain("history/harbor-2026-08.md");

      expect(() => writeSplit(brain, "projects/harbor.md", second)).toThrow(/history\/harbor-2026-08\.md/);
      expect(() => writeSplit(brain, "projects/harbor.md", second)).toThrow(/NOTHING was written/);

      // The whole run, not just the colliding file: nothing on disk moved by a byte, and no new
      // file appeared beside it either.
      for (const [p, text] of before) expect(readFileSync(join(brain, p), "utf8"), p).toBe(text);
      for (const p of second.history.keys()) {
        if (!before.has(p)) expect(existsSync(join(brain, p)), p).toBe(false);
      }
    });
  });

  /**
   * The route no exact-filename check can see. A month that fits is filed as
   * `<name>-YYYY-MM.md`; a month that does not is `<name>-YYYY-MM-<i>.md`. The two schemes never
   * collide, so when a month's PART COUNT changes between runs no destination exists, the run
   * succeeds, and the previous run's files stay on disk with nothing pointing at them — the page's
   * `## History` block now lists only the new run's months. No bytes lost, but the page has lost
   * its record all the same. Both directions, since the naming is asymmetric.
   */
  function sessions(n: number, size: number, from: number): string {
    let out = "";
    for (let i = 0; i < n; i++) out += `\n## Session 2026-08-${String(from + i).padStart(2, "0")}\n${"a".repeat(size)}\n`;
    return out;
  }

  it("refuses when the same page-month is already filed under a different part count", () => {
    scratch((brain) => {
      mkdirSync(join(brain, "projects"), { recursive: true });
      // Run 1: two big sessions and a small byte cap, so August files as two parts.
      const parted = `# Harbor\n\n## Status\nnow\n${sessions(2, 400, 5)}`;
      writeFileSync(join(brain, "projects/harbor.md"), parted, "utf8");
      const first = splitPage(parted, { ...KEEP, keepHeadings: ["Status"], maxHistoryBytes: 500 });
      expect([...first.history.keys()]).toEqual(["history/harbor-2026-08-1.md", "history/harbor-2026-08-2.md"]);
      writeSplit(brain, "projects/harbor.md", first);

      // Run 2: the page now holds one small August session, which files as a single unparted
      // note. `history/harbor-2026-08.md` does not exist, so nothing collides by name.
      const single = `# Harbor\n\n## Status\nnow\n${sessions(1, 10, 20)}`;
      writeFileSync(join(brain, "projects/harbor.md"), single, "utf8");
      const second = splitPage(single, { ...KEEP, keepHeadings: ["Status"] });
      expect([...second.history.keys()]).toEqual(["history/harbor-2026-08.md"]);

      const before = new Map(
        ["projects/harbor.md", ...first.history.keys()].map((p) => [p, readFileSync(join(brain, p), "utf8")])
      );
      expect(() => writeSplit(brain, "projects/harbor.md", second)).toThrow(/harbor-2026-08-1\.md/);
      expect(() => writeSplit(brain, "projects/harbor.md", second)).toThrow(/harbor-2026-08-2\.md/);
      for (const [p, text] of before) expect(readFileSync(join(brain, p), "utf8"), p).toBe(text);
      expect(existsSync(join(brain, "history/harbor-2026-08.md"))).toBe(false);
    });
  });

  it("refuses in the other direction too — one part already filed, this run would make several", () => {
    scratch((brain) => {
      mkdirSync(join(brain, "projects"), { recursive: true });
      const single = `# Harbor\n\n## Status\nnow\n${sessions(1, 10, 5)}`;
      writeFileSync(join(brain, "projects/harbor.md"), single, "utf8");
      const first = splitPage(single, { ...KEEP, keepHeadings: ["Status"] });
      expect([...first.history.keys()]).toEqual(["history/harbor-2026-08.md"]);
      writeSplit(brain, "projects/harbor.md", first);

      const grown = `# Harbor\n\n## Status\nnow\n${sessions(3, 400, 10)}`;
      writeFileSync(join(brain, "projects/harbor.md"), grown, "utf8");
      const second = splitPage(grown, { ...KEEP, keepHeadings: ["Status"], maxHistoryBytes: 500 });
      expect([...second.history.keys()]).not.toContain("history/harbor-2026-08.md");

      const kept = readFileSync(join(brain, "history/harbor-2026-08.md"), "utf8");
      expect(() => writeSplit(brain, "projects/harbor.md", second)).toThrow(/harbor-2026-08\.md/);
      expect(readFileSync(join(brain, "history/harbor-2026-08.md"), "utf8")).toBe(kept);
      for (const p of second.history.keys()) expect(existsSync(join(brain, p)), p).toBe(false);
    });
  });

  it("refuses when a DIFFERENT page's split already claimed the basename", () => {
    // `name` is the basename, so projects/harbor.md and notes/harbor.md both file to
    // history/harbor-YYYY-MM.md. Same hole, reached from the side.
    scratch((brain) => {
      mkdirSync(join(brain, "projects"), { recursive: true });
      mkdirSync(join(brain, "notes"), { recursive: true });
      writeFileSync(join(brain, "projects/harbor.md"), page, "utf8");
      writeSplit(brain, "projects/harbor.md", splitPage(page, KEEP));

      const other = `# Other\n\n## Status\nnow\n\n## A session 2026-08-14\nanother page's august\n`;
      writeFileSync(join(brain, "notes/harbor.md"), other, "utf8");
      const kept = readFileSync(join(brain, "history/harbor-2026-08.md"), "utf8");

      expect(() =>
        writeSplit(brain, "notes/harbor.md", splitPage(other, { ...KEEP, keepHeadings: ["Status"] }))
      ).toThrow(/same basename/);
      expect(readFileSync(join(brain, "history/harbor-2026-08.md"), "utf8")).toBe(kept);
      expect(readFileSync(join(brain, "notes/harbor.md"), "utf8")).toBe(other);
    });
  });
});
