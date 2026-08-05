import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../lib/github", () => ({
  getFile: vi.fn(),
  putFile: vi.fn(),
  listTree: vi.fn(),
  // getContext resolves the branch head before serving the corpus. Answering with the fixture's
  // own SHA makes loadCorpus return the seeded cache on its clean path; without it these tests
  // pass through the head-resolution-failed fallback instead, which is a different code path than
  // the one they mean to exercise.
  gh: vi.fn(async () => ({ ok: true, json: async () => ({ sha: "deadbeefcafe0000" }) })),
  repo: () => "owner/brain",
  branch: () => "main",
}));

import { getFile, putFile, listTree } from "../lib/github";
import { __setCache } from "../lib/corpus";
import {
  capture,
  getContext,
  lastNDates,
  readNote,
  todayStamp,
  validatePath,
  writeNote,
} from "../lib/brain";

const mGet = vi.mocked(getFile);
const mPut = vi.mocked(putFile);
const mList = vi.mocked(listTree);

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv("BRAIN_TZ", "America/Los_Angeles");
  mPut.mockResolvedValue({ commitSha: "c0" });
  // The corpus cache is module-level and keyed on SHA, so a fixture left behind by one test would
  // be served to the next one.
  __setCache(null);
});

describe("validatePath", () => {
  it.each(["profile.md", "INDEX.md", "projects/beacon.md", "notes/a-b_c.md", "log/2026-07-24.md", "archive/old/x.md"])(
    "accepts %s",
    (p) => expect(() => validatePath(p)).not.toThrow()
  );
  it.each(["../etc/passwd", "src/evil.ts", "projects/x.txt", "/absolute.md", "projects/../profile.md", "random.md"])(
    "rejects %s",
    (p) => expect(() => validatePath(p)).toThrow(/Invalid brain path/)
  );
});

describe("todayStamp", () => {
  it("formats date and time in BRAIN_TZ", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-24T20:30:00Z")); // 13:30 in LA (PDT)
    expect(todayStamp()).toEqual({ date: "2026-07-24", time: "13:30" });
    vi.useRealTimers();
  });
});

describe("getContext", () => {
  function corpusOf(files: Record<string, string>) {
    __setCache({
      files: new Map(Object.entries(files)),
      sidecar: new Map(),
      sha: "deadbeefcafe0000",
      bytes: 0,
      fetchedAt: Date.now(),
    });
  }

  it("assembles profile + router + recent logs, skipping missing days", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-24T20:30:00Z"));
    corpusOf({
      "profile.md": "PROFILE",
      "notes/a.md": '---\ndescription: "a described note"\n---\n\nbody',
      "log/2026-07-24.md": "# Log\n\n## 09:00 · cortex\n\ntoday log",
      "log/2026-07-20.md": "# Log\n\n## 09:00 · older\n\nolder log",
    });
    const ctx = await getContext();
    expect(ctx).toContain("PROFILE");
    expect(ctx).toContain("# ROUTER");
    expect(ctx).toContain("a described note");
    expect(ctx).toContain("today log");
    expect(ctx).toContain("older log");
    expect(ctx).not.toContain("2026-07-23.md"); // missing days are simply absent
    vi.useRealTimers();
  });

  it("digests a day that would blow the budget, and says how to open it", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-24T20:30:00Z"));
    const huge = `# Log\n\n## 09:00 · ops, aurora\n\n${"x".repeat(9000)}`;
    corpusOf({ "profile.md": "P", "log/2026-07-24.md": huge, "log/2026-07-23.md": "# Log\n\n## 08:00 · small\n\nshort day" });
    const ctx = await getContext();
    expect(ctx).not.toContain("x".repeat(9000));
    expect(ctx).toContain("ops, aurora");
    expect(ctx).toContain("brain_read log/2026-07-24.md");
    // The oversized day must not hide the small one behind it.
    expect(ctx).toContain("short day");
    vi.useRealTimers();
  });

  it("reports its own size and commit so the cost is never invisible", async () => {
    corpusOf({ "profile.md": "P" });
    const ctx = await getContext();
    expect(ctx).toMatch(/brain @deadbeefcafe · 1 notes routed/);
    expect(ctx).toMatch(/~\d+ tokens/);
  });
});

/**
 * These used to assert which files getContext happened to fetch. getContext no longer fetches per
 * file — it reads the corpus once — so the assertions now target `lastNDates`, which is where the
 * date arithmetic actually lives. Same coverage, aimed at the code that can be wrong.
 */
describe("lastNDates across DST boundaries", () => {
  it("spring-forward: does not skip the day after the DST jump", () => {
    vi.useFakeTimers();
    // 00:30 America/Los_Angeles — first hour after local midnight following the Mar 8 spring-forward
    vi.setSystemTime(new Date("2026-03-09T07:30:00Z"));
    expect(lastNDates(7)).toEqual([
      "2026-03-09",
      "2026-03-08",
      "2026-03-07",
      "2026-03-06",
      "2026-03-05",
      "2026-03-04",
      "2026-03-03",
    ]);
    vi.useRealTimers();
  });

  it("fall-back: does not duplicate today or drop the oldest day", () => {
    vi.useFakeTimers();
    // 23:30 America/Los_Angeles on Nov 1 — last hour of the fall-back day
    vi.setSystemTime(new Date("2026-11-02T07:30:00Z"));
    expect(lastNDates(7)).toEqual([
      "2026-11-01",
      "2026-10-31",
      "2026-10-30",
      "2026-10-29",
      "2026-10-28",
      "2026-10-27",
      "2026-10-26",
    ]);
    vi.useRealTimers();
  });
});


describe("writeNote", () => {
  it("create fails when file exists", async () => {
    mGet.mockResolvedValue({ path: "notes/a.md", content: "x", sha: "s1" });
    await expect(writeNote("notes/a.md", "y", "create")).rejects.toThrow(/already exists/);
  });

  it("replace fails when file missing", async () => {
    mGet.mockResolvedValue(null);
    await expect(writeNote("notes/a.md", "y", "replace")).rejects.toThrow(/does not exist/);
  });

  it("append concatenates and regenerates index without an extra commit when unchanged", async () => {
    mGet.mockImplementation(async (p: string) =>
      p === "notes/a.md"
        ? { path: p, content: "old", sha: "s1" }
        : p === "INDEX.md"
          ? { path: p, content: "# INDEX\n\n_Auto-generated by cortex on every write — do not edit by hand._\n\n## Root\n- profile.md\n\n## notes\n- notes/a.md", sha: "s2" }
          : // every path listTree() returns must be readable, or the rich-index
            // rebuild correctly refuses to run — see "refuses to rebuild" below
            p === "profile.md"
            ? { path: p, content: "# Profile\n\nboot file", sha: "s3" }
            : null
    );
    mList.mockResolvedValue(["profile.md", "notes/a.md", "INDEX.md"]);
    const res = await writeNote("notes/a.md", "new", "append");
    expect(res).toEqual({ path: "notes/a.md", commitSha: "c0" });
    const appendCall = mPut.mock.calls.find(([p]) => p === "notes/a.md")!;
    expect(appendCall[1]).toBe("old\n\nnew");
    // INDEX content unchanged for this tree → no INDEX put
    expect(mPut.mock.calls.filter(([p]) => p === "INDEX.md")).toHaveLength(0);
  });

  describe("edit mode — the staleness fix", () => {
    // The failure this mode retires: corrections were appended, so the stale claim stayed
    // standing above the new truth, verbatim and quotable. These tests hold the two properties
    // that make in-place editing safe to trust: it refuses ambiguity loudly, and it never
    // mangles a replacement that happens to look like a substitution pattern.
    const note = { path: "notes/a.md", content: "The port is 3000.\n\nThe host is prod.", sha: "s1" };
    beforeEach(() => {
      mGet.mockImplementation(async (p: string) => (p === "notes/a.md" ? { ...note } : null));
      mList.mockResolvedValue(["notes/a.md"]);
    });

    it("splices the one match and commits as an edit", async () => {
      const res = await writeNote("notes/a.md", "The port is 3310.", "edit", "The port is 3000.");
      expect(res.commitSha).toBe("c0");
      const call = mPut.mock.calls.find(([p]) => p === "notes/a.md")!;
      expect(call[1]).toBe("The port is 3310.\n\nThe host is prod.");
      expect(call[2]).toBe("brain: edit notes/a.md");
    });

    it("refuses zero matches with instructions, not a silent append", async () => {
      await expect(
        writeNote("notes/a.md", "x", "edit", "The port is 9999.")
      ).rejects.toThrow(/not found in notes\/a\.md — read the note first/);
      expect(mPut).not.toHaveBeenCalled();
    });

    it("refuses an ambiguous match and names the count", async () => {
      mGet.mockResolvedValue({ ...note, content: "same line\n\nsame line" });
      await expect(writeNote("notes/a.md", "x", "edit", "same line")).rejects.toThrow(
        /appears 2 times/
      );
      expect(mPut).not.toHaveBeenCalled();
    });

    it("refuses edit without find, and edit of a missing file", async () => {
      await expect(writeNote("notes/a.md", "x", "edit")).rejects.toThrow(/needs `find`/);
      mGet.mockResolvedValue(null);
      await expect(writeNote("notes/a.md", "x", "edit", "y")).rejects.toThrow(/does not exist/);
    });

    it("does not interpret $-patterns in the replacement", async () => {
      // String.replace would turn $& into the matched text and $' into the tail — and a
      // correction quoting shell or regex is the median note in this corpus, not an edge case.
      await writeNote("notes/a.md", "costs $& and then $' more.", "edit", "The port is 3000.");
      const call = mPut.mock.calls.find(([p]) => p === "notes/a.md")!;
      expect(call[1]).toBe("costs $& and then $' more.\n\nThe host is prod.");
    });

    it("re-applies against fresh content on a conflict retry, and re-checks uniqueness", async () => {
      const res = await writeNote("notes/a.md", "NEW", "edit", "The port is 3000.");
      expect(res.commitSha).toBe("c0");
      const refresher = mPut.mock.calls.find(([p]) => p === "notes/a.md")![4] as
        | ((f: { content: string } | null) => string)
        | undefined;
      expect(refresher).toBeTypeOf("function");
      // Fresh content still has one match → splice against the FRESH text.
      expect(refresher!({ content: "prefix\n\nThe port is 3000." })).toBe("prefix\n\nNEW");
      // A concurrent write removed the target → the retry fails loudly instead of guessing.
      expect(() => refresher!({ content: "someone replaced everything" })).toThrow(/not found/);
      expect(() => refresher!(null)).toThrow(/disappeared mid-write/);
    });
  });

  it("create writes INDEX when the tree gains a file", async () => {
    mGet.mockImplementation(async (p: string) =>
      p === "INDEX.md" ? { path: p, content: "# INDEX (stale)", sha: "s2" } : null
    );
    mList.mockResolvedValue(["profile.md", "notes/new.md", "INDEX.md"]);
    await writeNote("notes/new.md", "body", "create");
    expect(mPut.mock.calls.some(([p]) => p === "INDEX.md")).toBe(true);
  });

  it("rejects invalid path before any API call", async () => {
    await expect(writeNote("evil/../x.md", "b", "create")).rejects.toThrow(/Invalid brain path/);
    expect(mGet).not.toHaveBeenCalled();
  });

  it("DATA-LOSS REGRESSION: append's merge callback re-derives from a concurrent write instead of dropping it", async () => {
    mGet.mockImplementation(async (p: string) =>
      p === "notes/a.md" ? { path: p, content: "old", sha: "s1" } : null
    );
    mList.mockResolvedValue(["profile.md", "notes/a.md"]);
    await writeNote("notes/a.md", "mine", "append");
    const appendCall = mPut.mock.calls.find(([p]) => p === "notes/a.md")!;
    const merge = appendCall[4] as (fresh: unknown) => string;
    expect(typeof merge).toBe("function");
    // Simulate: between our read and our write, someone else appended "concurrent entry".
    const result = merge({ path: "notes/a.md", content: "old\n\nconcurrent entry", sha: "s2" });
    expect(result).toContain("concurrent entry");
    expect(result).toContain("mine");
  });

  it("passes no merge callback for create/replace (replace semantics, no re-derivation)", async () => {
    mGet.mockImplementation(async (p: string) =>
      p === "notes/a.md" ? { path: p, content: "old", sha: "s1" } : null
    );
    mList.mockResolvedValue(["profile.md", "notes/a.md"]);
    await writeNote("notes/a.md", "replaced", "replace");
    const call = mPut.mock.calls.find(([p]) => p === "notes/a.md")!;
    expect(call[4]).toBeUndefined();
  });
});

describe("capture", () => {
  it("creates today's log with header when absent", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-24T20:30:00Z"));
    mGet.mockResolvedValue(null);
    mList.mockResolvedValue(["profile.md", "INDEX.md"]);
    await capture("first thought", ["relay"]);
    const call = mPut.mock.calls.find(([p]) => p === "log/2026-07-24.md")!;
    expect(call[1]).toBe("# Log 2026-07-24\n\n## 13:30 · relay\n\nfirst thought\n");
    vi.useRealTimers();
  });

  it("appends an entry when today's log exists", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-24T20:30:00Z"));
    mGet.mockImplementation(async (p: string) =>
      p === "log/2026-07-24.md"
        ? { path: p, content: "# Log 2026-07-24\n\n## 09:00\n\nearlier\n", sha: "s" }
        : null
    );
    mList.mockResolvedValue([]);
    await capture("second thought");
    const call = mPut.mock.calls.find(([p]) => p === "log/2026-07-24.md")!;
    expect(call[1]).toBe(
      "# Log 2026-07-24\n\n## 09:00\n\nearlier\n\n## 13:30\n\nsecond thought\n"
    );
    vi.useRealTimers();
  });

  it("DATA-LOSS REGRESSION: capture's merge callback re-derives from a concurrent entry instead of dropping it", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-24T20:30:00Z"));
    mGet.mockImplementation(async (p: string) =>
      p === "log/2026-07-24.md"
        ? { path: p, content: "# Log 2026-07-24\n\n## 09:00\n\nearlier\n", sha: "s" }
        : null
    );
    mList.mockResolvedValue([]);
    await capture("second thought");
    const call = mPut.mock.calls.find(([p]) => p === "log/2026-07-24.md")!;
    const merge = call[4] as (fresh: unknown) => string;
    expect(typeof merge).toBe("function");
    const result = merge({
      path: "log/2026-07-24.md",
      content: "# Log 2026-07-24\n\n## 09:00\n\nearlier\n\n## 09:05\n\nconcurrent entry\n",
      sha: "s2",
    });
    expect(result).toContain("concurrent entry");
    expect(result).toContain("second thought");
    vi.useRealTimers();
  });
});

describe("regenerateIndex resilience (FIX C)", () => {
  it("writeNote still resolves with commitSha and carries indexWarning when index regeneration fails", async () => {
    mGet.mockResolvedValue(null);
    mList.mockRejectedValue(new Error("tree fetch boom"));
    const res = await writeNote("notes/a.md", "body", "create");
    expect(res.commitSha).toBe("c0");
    expect(res.path).toBe("notes/a.md");
    expect(res.indexWarning).toMatch(/tree fetch boom/);
  });

  it("capture still resolves with commitSha and carries indexWarning when index regeneration fails", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-24T20:30:00Z"));
    mGet.mockResolvedValue(null);
    mList.mockRejectedValue(new Error("tree fetch boom"));
    const res = await capture("a thought");
    expect(res.commitSha).toBe("c0");
    expect(res.indexWarning).toMatch(/tree fetch boom/);
    vi.useRealTimers();
  });

  it("writeNote carries no indexWarning when regeneration succeeds", async () => {
    // `create` checks the target does not exist, THEN the rebuild reads it back.
    // Mirror that ordering rather than making one call answer both.
    let written = false;
    mGet.mockImplementation(async (p: string) => {
      if (p === "notes/a.md") {
        if (!written) { written = true; return null; }   // pre-write existence check
        return { path: p, content: "# a\n\nsome real body text", sha: "s1" };
      }
      if (p === "profile.md") return { path: p, content: "# Profile\n\nboot file", sha: "s2" };
      return null;
    });
    mList.mockResolvedValue(["profile.md", "notes/a.md"]);
    const res = await writeNote("notes/a.md", "body", "create");
    expect(res.indexWarning).toBeUndefined();
  });

});

describe("readNote", () => {
  it("throws a clear error for missing notes", async () => {
    mGet.mockResolvedValue(null);
    await expect(readNote("notes/ghost.md")).rejects.toThrow(/not found/);
  });
});


/**
 * Two mutation tests, added because a review demonstrated that neither behaviour was pinned:
 * dropping the running total from the budget check, and reversing the day order, both left the
 * entire brain suite green. A budget nothing measures is a comment, and "newest first" that
 * nothing asserts is a coincidence.
 */
describe("getContext holds its ceiling and its ordering", () => {
  function seed(days: Record<string, number>) {
    const files = new Map<string, string>([["profile.md", "P"]]);
    for (const [d, size] of Object.entries(days)) {
      files.set(`log/${d}.md`, `# Log\n\n## 09:00 · ops\n\n${"y".repeat(size)}`);
    }
    __setCache({ files, sidecar: new Map(), sha: "deadbeefcafe0000", bytes: 0, fetchedAt: Date.now() });
  }

  // Mutation: `spent + text.length` -> `text.length`. Seven ordinary days each fit alone, so
  // without the running total all seven expand and the boot call is ~56 KB.
  it("bounds the WHOLE recent section, not each day against the budget separately", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-24T20:30:00Z"));
    seed(Object.fromEntries(
      ["2026-07-24", "2026-07-23", "2026-07-22", "2026-07-21", "2026-07-20", "2026-07-19", "2026-07-18"].map((d) => [d, 7_900])
    ));
    const ctx = await getContext();
    const recent = ctx.slice(ctx.indexOf("# RECENT"));
    expect(recent.length).toBeLessThan(20_000);
    expect(ctx).toMatch(/[1-3] days? expanded, [4-6] digested/);
    vi.useRealTimers();
  });

  // Mutation: `.reverse()` on the day list. Without this the operator boots into last week and
  // gets a one-line digest of the day they are actually working in.
  it("spends the budget on the NEWEST days, not the oldest", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-24T20:30:00Z"));
    seed({ "2026-07-24": 3_000, "2026-07-23": 3_000, "2026-07-22": 3_000, "2026-07-21": 3_000, "2026-07-20": 3_000 });
    const ctx = await getContext();
    expect(ctx).toContain("--- log/2026-07-24.md ---"); // today expanded
    expect(ctx).toContain("brain_read log/2026-07-20.md"); // the oldest digested
    expect(ctx).not.toContain("--- log/2026-07-20.md ---");
    vi.useRealTimers();
  });

  // The digest line replaces an oversized day, so it is the budget's own escape hatch. It used to
  // interpolate note-derived text with no ceiling: one huge tag on one heading produced a 200 KB
  // boot call from a day the budget had just declined to expand.
  it("bounds the digest line that stands in for an oversized day", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-24T20:30:00Z"));
    const files = new Map<string, string>([
      ["profile.md", "P"],
      ["log/2026-07-24.md", `# Log\n\n## 09:00 · ${"z".repeat(200_000)}\n\n${"y".repeat(9_000)}`],
    ]);
    __setCache({ files, sidecar: new Map(), sha: "deadbeefcafe0000", bytes: 0, fetchedAt: Date.now() });
    const ctx = await getContext();
    expect(ctx.length).toBeLessThan(15_000);
    expect(ctx).toContain("brain_read log/2026-07-24.md");
    vi.useRealTimers();
  });
});
