/**
 * One deadline per request.
 *
 * Every stage of a connector call used to carry its own fixed ceiling — GitHub 15 s, the mirror
 * race 20 s, the reader 45 s — and each was chosen against a picture of the OTHER stages being
 * fast. Summed blind they come to 80 s under a 60 s function wall, so a call that was merely slow
 * at every stage was killed by the platform: the caller got a gateway page instead of JSON-RPC
 * and the call log, written only after the tool resolved, never heard of it (72 kills in one
 * day, issue #180). This file is the arithmetic those stages now share: an absolute instant fixed
 * once at the door, and a `remaining()` every stage spends from. No stage may start with less than
 * it needs, and the last one — the reader — gives back a margin for the verification and the
 * reply that follow it.
 *
 * Dependency-free on purpose: the console's browser bundle reads the stamp vocabulary from here,
 * and the timers are `setTimeout`-backed rather than `AbortSignal.timeout` so a test can drive
 * every ceiling with fake timers.
 */

/** The route segment's `maxDuration`, in ms. Every MCP door declares 60. */
export const PLATFORM_WALL_MS = 60_000;
/** Kept back from the wall for serialising the reply and flushing `after()` work. */
export const WALL_SAFETY_MARGIN_MS = 5_000;
/** What one request may spend on its own work, measured from the door. */
export const REQUEST_WALL_MS = PLATFORM_WALL_MS - WALL_SAFETY_MARGIN_MS;

/** The reader's own cap — never more than this, even with the whole budget left. */
export const READER_TIMEOUT_MS = 45_000;
/** Held back from the reader's budget for citation verification and rendering the reply. */
export const READER_REPLY_MARGIN_MS = 3_000;
/** A reader given less than this is a reader that cannot finish; it is not started. */
export const READER_MIN_MS = 5_000;
/** Below this the mirror is not worth racing — the tarball serves directly. */
export const MIRROR_MIN_MS = 2_000;
/** A GitHub round trip with less than this left is not attempted. */
export const GITHUB_MIN_MS = 1_000;

/** The call-log stamp a started-only row collapses to once the platform wall has passed. */
export const CUT_STAMP = "CUT OFF";
/** The stamp a call carries between its started row and its final row. */
export const STARTED_STAMP = "STARTED";
/** The stamp a tool carries when the request deadline stopped it before it could answer —
 *  a brain_ask whose corpus did not load in budget included. (A reader that ran out of time is
 *  different: ask() answers UNVERIFIED and says so, and the log carries that stamp.) */
export const TIMED_OUT_STAMP = "TIMED OUT";

export interface Deadline {
  /** Absolute epoch ms — the instant work must have stopped by. */
  readonly at: number;
  /** Whole ms left, never negative. */
  remaining(): number;
  /** Whole ms spent since the deadline was created. */
  elapsed(): number;
}

/** A deadline `ms` from `now`. Absolute from the start, so a stage that reads it after
 *  something slow sees the truth rather than a budget copied before the slowness. */
export function deadlineIn(ms = REQUEST_WALL_MS, now = Date.now()): Deadline {
  const at = now + ms;
  return {
    at,
    remaining: () => Math.max(0, at - Date.now()),
    elapsed: () => Math.max(0, Date.now() - now),
  };
}

/** A stage's budget: its own cap, or what is left, whichever is smaller — never negative. */
export function budgetFor(capMs: number, remainingMs: number): number {
  return Math.max(0, Math.min(capMs, remainingMs));
}

/**
 * What the reader may spend: its cap, or what is left after the reply's margin. Zero means the
 * reader must not start — the caller answers honestly instead. Pure, so the table test can pin
 * the arithmetic without a clock.
 */
export function readerBudgetMs(remainingMs: number): number {
  const ms = budgetFor(READER_TIMEOUT_MS, remainingMs - READER_REPLY_MARGIN_MS);
  return ms >= READER_MIN_MS ? ms : 0;
}

/** What the mirror race may spend: its cap, or what is left after the tarball's own reserve —
 *  so losing the race still leaves the fallback a turn. Zero means skip the mirror. */
export function mirrorBudgetMs(capMs: number, remainingMs: number, reserveMs: number): number {
  const ms = budgetFor(capMs, remainingMs - reserveMs);
  return ms >= MIRROR_MIN_MS ? ms : 0;
}

/** What one GitHub round trip may spend. Zero means do not start it. */
export function githubBudgetMs(capMs: number, remainingMs: number): number {
  const ms = budgetFor(capMs, remainingMs);
  return ms >= GITHUB_MIN_MS ? ms : 0;
}

/**
 * The request deadline stopped a stage. `started` says whether the stage ran at all — a reader
 * cut off mid-call and a reader never reached are different sentences in the reply — and
 * `budgetMs` is what it was given. Thrown, not returned, so the stage's own error handling keeps
 * its shape; callers that want to answer honestly catch this one class.
 */
export class DeadlineExceeded extends Error {
  override readonly name = "DeadlineExceeded";
  constructor(
    readonly stage: "github" | "mirror" | "reader" | "corpus",
    readonly budgetMs: number,
    readonly started: boolean,
    message?: string
  ) {
    super(
      message ??
        (started
          ? `${stage}: no response within ${Math.round(budgetMs / 1000)}s`
          : `${stage}: not started — ${Math.round(budgetMs / 1000)}s left is under its minimum`)
    );
  }
}

export function isDeadlineExceeded(e: unknown): e is DeadlineExceeded {
  return e instanceof DeadlineExceeded || (e instanceof Error && e.name === "DeadlineExceeded");
}

/**
 * A signal that aborts after `ms`, with the same `TimeoutError` reason `AbortSignal.timeout`
 * produces — so every existing `e.name === "TimeoutError"` check keeps working — but driven by
 * `setTimeout`, which fake timers can advance. Unref'd: a timer for a request that already
 * finished must not hold the process open. `clear()` is for callers that are done with the
 * signal before it fires; fetch callers leave it, because the body read rides the signal too.
 */
export function abortAfter(ms: number): { signal: AbortSignal; clear: () => void } {
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort(new DOMException(`The operation was aborted due to timeout (${ms}ms)`, "TimeoutError"));
  }, ms);
  timer.unref?.();
  return { signal: controller.signal, clear: () => clearTimeout(timer) };
}

/**
 * `work` or `onTimeout()` rejected, whichever comes first. The loser keeps running — a race
 * cannot cancel a promise — which is the existing contract of the mirror race this replaces.
 */
export async function raceDeadline<T>(work: Promise<T>, ms: number, onTimeout: () => Error): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(onTimeout()), ms);
    timer.unref?.();
  });
  try {
    return await Promise.race([work, deadline]);
  } finally {
    clearTimeout(timer);
  }
}

/** Seconds with one decimal, the console's unit: `12.3 s`. */
export function secondsLabel(ms: number): string {
  return `${(ms / 1000).toFixed(1)} s`;
}
