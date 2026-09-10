import { afterEach, describe, expect, it, vi } from "vitest";
import {
  abortAfter,
  budgetFor,
  deadlineIn,
  DeadlineExceeded,
  githubBudgetMs,
  GITHUB_MIN_MS,
  isDeadlineExceeded,
  mirrorBudgetMs,
  MIRROR_MIN_MS,
  PLATFORM_WALL_MS,
  raceDeadline,
  readerBudgetMs,
  READER_MIN_MS,
  READER_REPLY_MARGIN_MS,
  READER_TIMEOUT_MS,
  REQUEST_WALL_MS,
  WALL_SAFETY_MARGIN_MS,
} from "../lib/deadline";
import { REQUEST_TIMEOUT_MS } from "../lib/github";
import { MIRROR_DEADLINE_MS, TARBALL_RESERVE_MS } from "../lib/corpus";
import { openaiReader } from "../lib/reader";
import { ask, render } from "../lib/ask";
import type { Corpus } from "../lib/corpus";
import type { Reader } from "../lib/ask";

/**
 * Issue #180: the stage ceilings inside one connector call did not compose under the 60 s
 * function wall — GitHub 15 s + mirror 20 s + reader 45 s = 80 s — so a merely slow call was
 * killed by the platform. What these tests pin is the arithmetic that replaced those constants:
 * one deadline per request, and every stage spending min(its own cap, what is left).
 */

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("the deadline arithmetic", () => {
  it("fixes the request wall five seconds under the route's maxDuration", () => {
    expect(PLATFORM_WALL_MS).toBe(60_000);
    expect(WALL_SAFETY_MARGIN_MS).toBe(5_000);
    expect(REQUEST_WALL_MS).toBe(55_000);
    // The tarball reserve is one GitHub round trip; corpus.ts carries the literal because half
    // the suite mocks ./github wholesale, so the equality is pinned here instead.
    expect(TARBALL_RESERVE_MS).toBe(REQUEST_TIMEOUT_MS);
  });

  it("measures from an absolute instant, not from a budget copied at the start", () => {
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    const d = deadlineIn(10_000);
    expect(d.remaining()).toBe(10_000);
    expect(d.elapsed()).toBe(0);
    vi.advanceTimersByTime(4_000);
    expect(d.remaining()).toBe(6_000);
    expect(d.elapsed()).toBe(4_000);
    vi.advanceTimersByTime(60_000);
    // Never negative: a stage that reads a spent deadline sees zero, not a nonsense budget.
    expect(d.remaining()).toBe(0);
    expect(d.elapsed()).toBe(64_000);
  });

  it("gives every stage min(its cap, what is left), and nothing below its minimum", () => {
    // remaining → [github, mirror (after the tarball reserve), reader (after the reply margin)]
    const table: Array<[number, number, number, number]> = [
      [REQUEST_WALL_MS, REQUEST_TIMEOUT_MS, MIRROR_DEADLINE_MS, READER_TIMEOUT_MS], // fresh: every cap
      [40_000, 15_000, 20_000, 37_000], // reader: 40 − 3 margin, under its 45 s cap
      [30_000, 15_000, 15_000, 27_000], // mirror: 30 − 15 reserve
      [20_000, 15_000, 5_000, 17_000],
      [16_500, 15_000, 0, 13_500], // mirror: 1.5 s left after the reserve is under MIRROR_MIN_MS
      [10_000, 10_000, 0, 7_000],
      [8_000, 8_000, 0, 5_000], // reader: exactly its minimum still runs
      [7_999, 7_999, 0, 0], // reader: one ms under the minimum does not start
      [1_000, 1_000, 0, 0],
      [999, 0, 0, 0], // github: under GITHUB_MIN_MS does not start
      [0, 0, 0, 0],
    ];
    for (const [remaining, github, mirror, reader] of table) {
      expect(githubBudgetMs(REQUEST_TIMEOUT_MS, remaining), `github @${remaining}`).toBe(github);
      expect(mirrorBudgetMs(MIRROR_DEADLINE_MS, remaining, TARBALL_RESERVE_MS), `mirror @${remaining}`).toBe(mirror);
      expect(readerBudgetMs(remaining), `reader @${remaining}`).toBe(reader);
    }
    expect(GITHUB_MIN_MS).toBe(1_000);
    expect(MIRROR_MIN_MS).toBe(2_000);
    expect(READER_MIN_MS).toBe(5_000);
    expect(READER_REPLY_MARGIN_MS).toBe(3_000);
    expect(budgetFor(10, -5)).toBe(0);
  });

  it("composes: the worst slow path still lands inside the wall", () => {
    // Head 15 s, mirror race 20 s, tarball 15 s, then the reader with what is left less the
    // margin: 55 − 50 − 3 = 2 s, under the reader's minimum, so the reader is not started and
    // the reply says so — but the call returns at ~50 s, inside the wall, instead of being killed
    // at 80 s. Move any one stage to its healthy speed and the reader gets a real budget.
    let spent = 0;
    const gh1 = githubBudgetMs(REQUEST_TIMEOUT_MS, REQUEST_WALL_MS - spent); spent += gh1;
    const mirror = mirrorBudgetMs(MIRROR_DEADLINE_MS, REQUEST_WALL_MS - spent, TARBALL_RESERVE_MS); spent += mirror;
    const tarball = githubBudgetMs(REQUEST_TIMEOUT_MS, REQUEST_WALL_MS - spent); spent += tarball;
    expect([gh1, mirror, tarball]).toEqual([15_000, 20_000, 15_000]);
    expect(readerBudgetMs(REQUEST_WALL_MS - spent)).toBe(0);
    expect(spent).toBeLessThan(REQUEST_WALL_MS);
    // A healthy head lookup (200 ms) and a mirror that loses its race still leave 17 s of reader.
    expect(readerBudgetMs(REQUEST_WALL_MS - 200 - 20_000 - 15_000)).toBe(16_800);
  });
});

describe("the timers", () => {
  it("abortAfter fires on setTimeout with the TimeoutError reason existing checks expect", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const { signal, clear } = abortAfter(1_000);
    expect(signal.aborted).toBe(false);
    vi.advanceTimersByTime(999);
    expect(signal.aborted).toBe(false);
    vi.advanceTimersByTime(1);
    expect(signal.aborted).toBe(true);
    expect((signal.reason as Error).name).toBe("TimeoutError");
    clear(); // idempotent after firing
    const kept = abortAfter(500);
    kept.clear();
    vi.advanceTimersByTime(5_000);
    expect(kept.signal.aborted).toBe(false);
  });

  it("raceDeadline rejects with the caller's error and clears its timer when work wins", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const never = new Promise<string>(() => {});
    // The handler is attached BEFORE the clock moves: a rejection with nobody listening yet is
    // an unhandled rejection to Node, whatever the test does with it a tick later.
    const lost = raceDeadline(never, 2_000, () => new DeadlineExceeded("mirror", 2_000, true)).then(
      () => "resolved",
      (e: unknown) => e
    );
    await vi.advanceTimersByTimeAsync(2_000);
    const e = await lost;
    expect(isDeadlineExceeded(e) && e.stage === "mirror").toBe(true);
    const won = await raceDeadline(Promise.resolve("fast"), 2_000, () => new Error("unreachable"));
    expect(won).toBe("fast");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("names the stage and the budget, and tells 'never started' from 'cut off'", () => {
    expect(new DeadlineExceeded("reader", 17_000, true).message).toBe("reader: no response within 17s");
    expect(new DeadlineExceeded("github", 800, false).message).toBe("github: not started — 1s left is under its minimum");
    expect(isDeadlineExceeded(new Error("x"))).toBe(false);
    expect(isDeadlineExceeded(Object.assign(new Error("x"), { name: "DeadlineExceeded" }))).toBe(true);
  });
});

describe("the reader honours the budget it is handed", () => {
  it("a raw-fetch backend is cut off at the caller's budget, not at its 45 s cap", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    vi.stubEnv("OPENAI_API_KEY", "sk-test");
    let seen: AbortSignal | undefined;
    // A provider that never answers: the request ends only when the signal aborts it.
    vi.stubGlobal(
      "fetch",
      vi.fn(
        (_url: string, init: RequestInit) =>
          new Promise((_, reject) => {
            seen = init.signal!;
            seen.addEventListener("abort", () => reject(seen!.reason));
          })
      )
    );
    const out = openaiReader({ stable: "pack", question: "q" }, "gpt-5.6-sol", { timeoutMs: 12_000 });
    const settled = out.then(() => "resolved", (e: Error) => e);
    await vi.advanceTimersByTimeAsync(11_999);
    expect(seen?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    const e = await settled;
    expect(isDeadlineExceeded(e)).toBe(true);
    expect(String(e)).toMatch(/OpenAI request failed — no response within 12s/);
    expect((e as DeadlineExceeded).budgetMs).toBe(12_000);
    expect((e as DeadlineExceeded).started).toBe(true);
  });

  it("never exceeds its own cap even when handed more", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    vi.stubEnv("OPENAI_API_KEY", "sk-test");
    let seen: AbortSignal | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn(
        (_url: string, init: RequestInit) =>
          new Promise((_, reject) => {
            seen = init.signal!;
            seen.addEventListener("abort", () => reject(seen!.reason));
          })
      )
    );
    const out = openaiReader({ stable: "pack", question: "q" }, "gpt-5.6-sol", { timeoutMs: 600_000 }).catch((e: Error) => e);
    await vi.advanceTimersByTimeAsync(READER_TIMEOUT_MS);
    expect(seen?.aborted).toBe(true);
    expect(String(await out)).toMatch(/no response within 45s/);
  });
});

describe("ask() under the deadline", () => {
  const corpus: Corpus = {
    sha: "eaf0a03e4849aaaa",
    bytes: 200,
    fetchedAt: 0,
    files: new Map([
      ["projects/beacon.md", "**Production is still dark** (re-checked 2026-07-25). Both URLs still return 404."],
      ["projects/harbor.md", "The plates backlog went into a deleted database."],
    ]),
  };

  /** A reader that only ever returns by being cut off. */
  const stalled: Reader = (_p, _m, opts) =>
    new Promise((_, reject) => {
      setTimeout(() => reject(new DeadlineExceeded("reader", opts!.timeoutMs!, true)), opts!.timeoutMs!);
    });

  it("hands the reader min(cap, remaining − margin) and renders a cut-off as UNVERIFIED with the seconds", async () => {
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    const deadline = deadlineIn(20_000);
    const budgets: number[] = [];
    const spy: Reader = (p, m, opts) => {
      budgets.push(opts!.timeoutMs!);
      return stalled(p, m, opts);
    };
    const pending = ask("is beacon live", spy, { corpus, deadline });
    await vi.advanceTimersByTimeAsync(17_000);
    const r = await pending;
    expect(budgets).toEqual([17_000]);
    expect(r.protocol).toBe("timeout");
    expect(r.timeout).toMatchObject({ reached: true, budgetMs: 17_000, elapsedMs: 17_000 });
    expect(r.citation).toBeNull();
    expect(r.notInBrain).toBe(false);
    const text = render(r);
    // Narrowing put one note in the pack for this question; the stamp counts what was searched.
    expect(r.candidates).toEqual(["projects/beacon.md"]);
    expect(text).toMatch(/^UNVERIFIED — timed out: searched 1 notes; the reader was cut off after 17\.0 s, 17\.0 s into the request\./);
    expect(text).toContain("Treat this as unsearched, not as absence.");
    expect(text).toContain("(searched 1 candidate notes @eaf0a03e4849)");
  });

  it("does not start a reader it cannot finish, and says how much was left", async () => {
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    const deadline = deadlineIn(55_000);
    vi.advanceTimersByTime(49_000); // the corpus stages spent it
    let called = 0;
    const r = await ask("is beacon live", async () => { called++; return "{}"; }, { corpus, deadline });
    expect(called).toBe(0);
    expect(r.protocol).toBe("timeout");
    expect(r.timeout).toMatchObject({ reached: false, budgetMs: 0, elapsedMs: 49_000, remainingMs: 6_000 });
    expect(render(r)).toMatch(
      /^UNVERIFIED — timed out: searched 1 notes; the reader was not reached — 6\.0 s of the request budget remained after 49\.0 s, under the 5\.0 s a reader needs\./
    );
  });

  it("absorbs only the deadline's own signal — every other reader failure is still an error", async () => {
    const deadline = deadlineIn(55_000);
    await expect(
      ask("is beacon live", async () => { throw new Error("reader gpt: OpenAI returned 401"); }, { corpus, deadline })
    ).rejects.toThrow(/returned 401/);
    // A DeadlineExceeded from another stage is not the reader's to absorb either.
    await expect(
      ask("is beacon live", async () => { throw new DeadlineExceeded("github", 0, false); }, { corpus, deadline })
    ).rejects.toSatisfy((e: unknown) => isDeadlineExceeded(e) && e.stage === "github");
  });

  it("keeps the fast path byte-for-byte: a two-arity reader, no deadline, same verdict", async () => {
    const r = await ask(
      "is beacon live",
      async ({ stable }) => {
        const tag = stable.match(/FILE: projects\/beacon\.md \[tag: ([0-9a-z]+)\]/)![1];
        return JSON.stringify({ answer: "No — production is dark.", tag, quote: "Production is still dark" });
      },
      { corpus }
    );
    expect(r.protocol).toBe("answer");
    expect(r.timeout).toBeUndefined();
    expect(render(r)).toMatch(/^VERIFIED — this quote is verbatim in projects\/beacon\.md/);
  });
});
