/**
 * The per-instance ask ceiling, shared by the run handler (which spends) and the screen (which
 * says `7 of 60 on this instance` before the first ask).
 *
 * Pinned to globalThis, not a module-level counter, for the reason lib/calls.ts gives: Next
 * bundles route handlers and pages separately, so a module-scoped `let` is instantiated twice
 * in one process — the handler would count and the page would forever read zero. Per-instance,
 * resets on cold start; named so nobody mistakes it for the KV budget the guest door meters.
 */
export const PROCESS_CEILING = 60;

const g = globalThis as typeof globalThis & { __cortexAskSpent?: number };

/** Asks this instance has answered since it started. */
export function spentThisInstance(): number {
  return g.__cortexAskSpent ?? 0;
}

/** Count one more; returns the new total. */
export function spendOne(): number {
  g.__cortexAskSpent = spentThisInstance() + 1;
  return g.__cortexAskSpent;
}

/** Test seam. */
export function __resetCeiling(): void {
  g.__cortexAskSpent = 0;
}
