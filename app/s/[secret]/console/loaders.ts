import { cache } from "react";
import { health } from "@/lib/health";
import { watchItems } from "@/lib/inbox";
import { listProposals } from "@/lib/proposals";

/**
 * The console's shared per-request loaders.
 *
 * The shell and the screen beneath it both need the same two things, and Next renders them as
 * independent server components — so every console page view ran health() twice (a GitHub head
 * lookup, a sync_state read and, on a cold instance, a full corpus load, all of it repeated)
 * and listProposals() twice (two Upstash round trips). Two of the four calls were pure
 * duplicates; React's cache() collapses them to one execution per request.
 *
 * Wrapped HERE rather than in lib/, because these are console concerns: lib/health.ts and
 * lib/proposals.ts are also called from the MCP tool handlers, which have no React request
 * scope and must keep calling the plain functions.
 */
export const consoleHealth = cache(health);

/** Wrapped in a zero-arg lambda so cache() keys on "the console's proposal read" rather than on
 *  a `now` that differs by a millisecond between the layout and the page — which would miss. */
export const consoleProposals = cache(() => listProposals());

/**
 * The mechanical watch items, shared by the badge, the overview rail and the attention queue so
 * the three surfaces cannot count differently within one request. The catch is deliberate and
 * logged: a derived watch list going absent is its documented degraded state (the store-backed
 * check already goes silently absent on its own), but a console screen refusing to render
 * because of one would have its priorities backwards.
 */
export const consoleWatch = cache(() =>
  watchItems().catch((e) => {
    console.error(`[inbox] watch items unavailable — the queue renders without them: ${String(e)}`);
    return [];
  })
);
