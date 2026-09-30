import { describe, expect, it } from "vitest";
import { logDigest, logSections, isLogPath, dateFromLogPath } from "../lib/digest";

// An invented bakery day-log in the house shape: a dated title, timestamped H2 entries with tags
// after the middle dot, and prose under each. One tag repeats across entries.
const LOG_SHAPE = `# Log 2025-03-11

## 07:05 · oven, sourdough, stock

Fed the starter before dawn; flour counted and reordered.

## 13:40 · delivery, sourdough, invoices, market

Four loaves to the market stall; two invoices sent.
`;

describe("isLogPath / dateFromLogPath", () => {
  it("recognises a dated day-log and extracts its date", () => {
    expect(isLogPath("log/2025-03-11.md")).toBe(true);
    expect(dateFromLogPath("log/2025-03-11.md")).toBe("2025-03-11");
  });
  it("rejects anything else, including a log-shaped note elsewhere", () => {
    for (const p of ["notes/log.md", "projects/log/2025-03-11.md", "log/notes.md", "log/2025-3-11.md"]) {
      expect(isLogPath(p), p).toBe(false);
    }
  });
});

describe("logDigest", () => {
  it("unions the tags across entries and counts them", () => {
    const d = logDigest(LOG_SHAPE);
    expect(d.entries).toBe(2);
    expect(d.tags).toEqual(["oven", "sourdough", "stock", "delivery", "invoices", "market"]);
    expect(d.description).toBe("2 entries: oven, sourdough, stock, delivery, invoices, market");
  });

  it("de-duplicates a tag that appears on more than one entry", () => {
    const text = "# Log\n\n## 01:00 · cortex, web\n\na\n\n## 02:00 · cortex, deploy\n\nb\n";
    expect(logDigest(text).tags).toEqual(["cortex", "web", "deploy"]);
  });

  it("counts a bare timestamped entry that carries no tags", () => {
    const text = "# Log\n\n## 04:49\n\nsomething happened\n";
    const d = logDigest(text);
    expect(d.entries).toBe(1);
    expect(d.tags).toEqual([]);
    expect(d.description).toBe("1 entry, untagged");
  });

  // Day-logs can carry prose H2s that are not timestamped entries — "## build server — wiring notes".
  // Those are headings inside a day, not entries, and counting them inflates the digest.
  it("ignores an H2 that is not a timestamped entry", () => {
    const text = "# Log\n\n## 04:49 · cortex\n\na\n\n## build server — wiring notes\n\nb\n";
    const d = logDigest(text);
    expect(d.entries).toBe(1);
    expect(d.tags).toEqual(["cortex"]);
  });

  it("survives a day file with no entries at all", () => {
    const d = logDigest("# Log 2025-03-12\n");
    expect(d.entries).toBe(0);
    expect(d.description).toBe("no entries");
  });

  it("uses the singular for one entry and the plural for more", () => {
    expect(logDigest("## 01:00 · a\n").description).toBe("1 entry: a");
    expect(logDigest("## 01:00 · a\n\n## 02:00 · b\n").description).toBe("2 entries: a, b");
  });

  // The digest is always loaded, so an unusually chatty day must not be able to blow the budget.
  it("caps the tag list and says how many it dropped", () => {
    const many = Array.from({ length: 30 }, (_, i) => `## 0${i % 10}:00 · tag${i}`).join("\n\n");
    const d = logDigest(many);
    expect(d.description).toMatch(/\+\d+ more$/);
    expect(d.description.length).toBeLessThan(200);
  });

  it("tolerates CRLF", () => {
    expect(logDigest("## 01:00 · cortex\r\n").tags).toEqual(["cortex"]);
  });
});

describe("logSections", () => {
  it("splits a day into its timestamped entries, headings included, prose H2s kept inside", () => {
    const s = logSections(
      "# Log 2025-03-11\n\n## 07:05 · oven, sourdough\n\nfirst body\n\n## a topic heading\n\nstill the first entry\n\n## 13:40 · delivery\n\nsecond body"
    );
    expect(s).toHaveLength(2);
    expect(s[0]).toMatchObject({ time: "07:05", tags: "oven, sourdough" });
    expect(s[0].text).toContain("## a topic heading");
    expect(s[0].text).toContain("still the first entry");
    expect(s[1]).toMatchObject({ time: "13:40", tags: "delivery" });
    expect(s[1].text).toContain("second body");
  });

  it("gives an untagged entry empty tags, and returns nothing for a day with no entries", () => {
    expect(logSections("## 09:00\n\nbody")[0]).toMatchObject({ time: "09:00", tags: "" });
    expect(logSections("# Log 2025-03-12\njust prose")).toEqual([]);
  });

  it("keeps the title line out of every section", () => {
    const s = logSections("# Log 2025-03-11\n\n## 10:00 · a\n\nbody");
    expect(s[0].text).not.toContain("# Log");
  });
});
