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
      "log/2026-07-24.md": "# Log\n\n## 09:00 · aurora\n\ntoday log",
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
    const huge = `# Log\n\n## 09:00 · aurora, beacon\n\n${"x".repeat(9000)}`;
    corpusOf({
      "profile.md": "P",
      "log/2026-07-24.md": huge,
      "log/2026-07-23.md": "# Log\n\n## 08:00 · small\n\nshort day",
    });
    const ctx = await getContext();
    expect(ctx).not.toContain("x".repeat(9000));
    expect(ctx).toContain("aurora, beacon");
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
    await capture("first thought", ["beacon"]);
    const call = mPut.mock.calls.find(([p]) => p === "log/2026-07-24.md")!;
    expect(call[1]).toBe("# Log 2026-07-24\n\n## 13:30 · beacon\n\nfirst thought\n");
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

