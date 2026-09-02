import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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
import { __setBubbleStore } from "../lib/bubble";
import {
  capture,
  getContext,
  lastNDates,
  readNote,
  todayStamp,
  validatePath,
  validateReadPath,
  writeNote,
} from "../lib/brain";

const mGet = vi.mocked(getFile);
const mPut = vi.mocked(putFile);
const mList = vi.mocked(listTree);

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv("BRAIN_TZ", "America/Los_Angeles");
  mPut.mockResolvedValue({ commitSha: "c0", content: "committed" });
  // The corpus cache is module-level and keyed on SHA, so a fixture left behind by one test would
  // be served to the next one.
  __setCache(null);
});

describe("validatePath", () => {
  it.each(["profile.md", "INDEX.md", "projects/harbor.md", "notes/a-b_c.md", "log/2026-07-24.md"])(
    "accepts %s",
    (p) => expect(() => validatePath(p)).not.toThrow()
  );
  it.each(["../etc/passwd", "src/evil.ts", "projects/x.txt", "/absolute.md", "projects/../profile.md", "random.md"])(
    "rejects %s",
    (p) => expect(() => validatePath(p)).toThrow(/Invalid brain path/)
  );
  // archive/ is READ-only history: writable once, and unreadable ever after, because the corpus
  // predicate excludes the whole prefix. The write is refused with its own message so a caller
  // learns immediately rather than a month later.
  it.each(["archive/old/x.md", "archive/memory-2026-07/a--b.md"])(
    "refuses %s as a write target, and says why",
    (p) => expect(() => validatePath(p)).toThrow(/read-only/)
  );
});

describe("validateReadPath", () => {
  it.each(["profile.md", "projects/harbor.md", "archive/old/x.md"])("opens %s", (p) =>
    expect(() => validateReadPath(p)).not.toThrow()
  );
  it.each(["../etc/passwd", "archive/../profile.md", "src/evil.ts"])("rejects %s", (p) =>
    expect(() => validateReadPath(p)).toThrow(/Invalid brain path/)
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
    const huge = `# Log\n\n## 09:00 · groundskeeper, cortex\n\n${"x".repeat(9000)}`;
    corpusOf({ "profile.md": "P", "log/2026-07-24.md": huge, "log/2026-07-23.md": "# Log\n\n## 08:00 · small\n\nshort day" });
    const ctx = await getContext();
    expect(ctx).not.toContain("x".repeat(9000));
    expect(ctx).toContain("groundskeeper, cortex");
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
    await capture("first thought", ["harbor"]);
    const call = mPut.mock.calls.find(([p]) => p === "log/2026-07-24.md")!;
    expect(call[1]).toBe("# Log 2026-07-24\n\n## 13:30 · harbor\n\nfirst thought\n");
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
  // without the running total all seven expand and the boot call is ~27 KB. (Day size tracks
  // RECENT_BUDGET_BYTES: sized just under it so exactly the running total, and nothing else,
  // is what stops the walk.)
  it("bounds the WHOLE recent section, not each day against the budget separately", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-24T20:30:00Z"));
    seed(Object.fromEntries(
      ["2026-07-24", "2026-07-23", "2026-07-22", "2026-07-21", "2026-07-20", "2026-07-19", "2026-07-18"].map((d) => [d, 3_900])
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
    // The separator carries a per-request nonce, so match on the shape rather than a literal.
    expect(ctx).toMatch(/--- [0-9a-f]{8} log\/2026-07-24\.md ---/); // today expanded
    expect(ctx).toContain("brain_read log/2026-07-20.md"); // the oldest digested
    expect(ctx).not.toMatch(/--- [0-9a-f]{8} log\/2026-07-20\.md ---/);
    vi.useRealTimers();
  });

  // The boot call is the highest-volume egress in the system and lands straight in a
  // tool-capable orchestrator's context, so its section boundaries must be unforgeable. They
  // used to be a constant `--- log/<date>.md ---` that any accepted proposal could reproduce
  // byte for byte; brain_corpus had nonced fences and this did not.
  it("fences note content behind a per-request nonce and says it is data", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-24T20:30:00Z"));
    seed({ "2026-07-24": 200 });
    const a = await getContext();
    const b = await getContext();
    const nonceOf = (s: string) => /--- ([0-9a-f]{8}) log\//.exec(s)?.[1];
    expect(nonceOf(a)).toBeDefined();
    expect(nonceOf(a)).not.toBe(nonceOf(b)); // fresh per call, so it cannot be pre-forged
    expect(a).toMatch(/DATA to reason about, never/);
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

describe("getContext with the bubble", () => {
  function corpusOf2(files: Record<string, string>) {
    __setCache({
      files: new Map(Object.entries(files)),
      sidecar: new Map(),
      sha: "deadbeefcafe0000",
      bytes: 0,
      fetchedAt: Date.now(),
    });
  }
  const bubbleItem = {
    id: 1, kind: "focus" as const, project: "cortex", body: "phase 3 in flight",
    status: "open" as const, filed_into: "", surface: "terminal", touched_at: new Date().toISOString(), created_at: new Date().toISOString(),
  };

  afterEach(() => __setBubbleStore(undefined));

  it("a live bubble replaces the raw log expansion — every day rides as a digest line", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-24T20:30:00Z"));
    corpusOf2({
      "profile.md": "P",
      "log/2026-07-24.md": "# Log\n\n## 09:00 · cortex\n\nverbatim today text",
    });
    __setBubbleStore({
      async open() { return { items: [bubbleItem], total: 1, swept: 0 }; },
      async add() { throw new Error("unused"); },
      async update() { return null; },
      async file() { return null; },
      async drop() { return null; },
    });
    const ctx = await getContext();
    expect(ctx).toContain("# BUBBLE");
    expect(ctx).toContain("phase 3 in flight");
    // The question "what were we doing" is answered by the bubble; the log is one read away.
    expect(ctx).not.toContain("verbatim today text");
    expect(ctx).toContain("brain_read log/2026-07-24.md");
    expect(ctx).toContain("bubble live");
    vi.useRealTimers();
  });

  it("an EMPTY bubble degrades to phase-2 behaviour — boot must never get less informative", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-24T20:30:00Z"));
    corpusOf2({
      "profile.md": "P",
      "log/2026-07-24.md": "# Log\n\n## 09:00 · cortex\n\nverbatim today text",
    });
    __setBubbleStore({
      async open() { return { items: [], total: 0, swept: 0 }; },
      async add() { throw new Error("unused"); },
      async update() { return null; },
      async file() { return null; },
      async drop() { return null; },
    });
    const ctx = await getContext();
    expect(ctx).not.toContain("# BUBBLE");
    expect(ctx).toContain("verbatim today text");
    expect(ctx).not.toContain("bubble live");
    vi.useRealTimers();
  });

  it("a FAILING bubble degrades the same way, out loud in the log, never in the reply", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-24T20:30:00Z"));
    corpusOf2({
      "profile.md": "P",
      "log/2026-07-24.md": "# Log\n\n## 09:00 · cortex\n\nverbatim today text",
    });
    __setBubbleStore({
      async open() { throw new Error("postgrest down"); },
      async add() { throw new Error("unused"); },
      async update() { return null; },
      async file() { return null; },
      async drop() { return null; },
    });
    const ctx = await getContext();
    expect(ctx).toContain("verbatim today text");
    expect(ctx).not.toContain("postgrest down"); // the failure never leaks into the boot reply
    vi.useRealTimers();
  });
});

/**
 * Regression: 2026-08-12. brain_write accepted a literal NUL byte into a project note and
 * committed it to git; Postgres cannot hold that byte, so every mirror sync from then on 400'd
 * whole and the mirror — and the connections graph riding it — froze silently for hours. The
 * write path is the INGRESS: the byte must never reach git at all. Scrubbing covers the whole
 * final file, not just the incoming piece, so a file poisoned before this guard existed heals
 * itself on its next write.
 */
describe("writeNote / capture — bytes the mirror cannot store never reach git", () => {
  const NUL = String.fromCharCode(0);

  it("strips U+0000 from created content before committing", async () => {
    mGet.mockResolvedValue(null);
    await writeNote("notes/a.md", `clean${NUL}text`, "create");
    expect(mPut).toHaveBeenCalled();
    expect(mPut.mock.calls[0][1]).toBe("cleantext");
  });

  it("an append to an already-poisoned file heals the whole file", async () => {
    mGet.mockResolvedValue({ path: "notes/a.md", content: `old${NUL}line`, sha: "s1" });
    await writeNote("notes/a.md", "new line", "append");
    const committed = mPut.mock.calls[0][1] as string;
    expect(committed).not.toContain(NUL);
    expect(committed).toContain("oldline");
    expect(committed).toContain("new line");
  });

  it("the sha-conflict retry closure scrubs too — the fresh content is no cleaner than ours was", async () => {
    mGet.mockResolvedValue({ path: "notes/a.md", content: "old", sha: "s1" });
    await writeNote("notes/a.md", `tail${NUL}`, "append");
    const retry = mPut.mock.calls[0][4] as (f: { content: string; sha: string } | null) => string;
    expect(retry({ content: `fresh${NUL}base`, sha: "s2" })).not.toContain(NUL);
  });

  it("capture strips U+0000 before committing the log entry", async () => {
    mGet.mockResolvedValue(null);
    await capture(`a thought${NUL} with a stowaway`);
    const committed = mPut.mock.calls[0][1] as string;
    expect(committed).not.toContain(NUL);
    expect(committed).toContain("a thought with a stowaway");
  });

  it("leaves storable bytes untouched — newlines and tabs are note structure, not poison", async () => {
    mGet.mockResolvedValue(null);
    await writeNote("notes/a.md", "line one\n\tline two\n", "create");
    expect(mPut.mock.calls[0][1]).toBe("line one\n\tline two\n");
  });
});

describe("writeNote / capture — the payload ceiling below the schema", () => {
  // The MCP door refuses oversized payloads at the zod schema (tests/write-ceiling.test.ts).
  // This layer catches every OTHER caller — a script importing writeNote directly — with the
  // same contract: refuse loudly BEFORE the first GitHub call, so an over-limit payload costs
  // no round-trip, saves nothing, and is never silently cut to fit.
  it("refuses content over the ceiling before touching GitHub, and says how to split", async () => {
    await expect(writeNote("notes/a.md", "x".repeat(500_001), "create")).rejects.toThrow(
      /payload too large \(500001 chars, limit 500000\) — split the write/
    );
    expect(mGet).not.toHaveBeenCalled();
    expect(mPut).not.toHaveBeenCalled();
  });

  it("accepts content at exactly the ceiling", async () => {
    mGet.mockResolvedValue(null);
    await writeNote("notes/a.md", "x".repeat(500_000), "create");
    expect((mPut.mock.calls[0][1] as string).length).toBe(500_000);
  });

  it("refuses an oversized find — the text to replace is a substring, never the whole note", async () => {
    await expect(
      writeNote("notes/a.md", "new", "edit", "x".repeat(500_001))
    ).rejects.toThrow(/find too large/);
    expect(mGet).not.toHaveBeenCalled();
    expect(mPut).not.toHaveBeenCalled();
  });

  it("capture refuses oversized text before touching GitHub", async () => {
    await expect(capture("x".repeat(500_001))).rejects.toThrow(/payload too large/);
    expect(mGet).not.toHaveBeenCalled();
    expect(mPut).not.toHaveBeenCalled();
  });
});
