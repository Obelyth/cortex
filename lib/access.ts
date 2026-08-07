/**
 * access — the note-level access log, the raw material for phase 4's temperatures.
 *
 * An OBSERVATION, never the product: nothing that reads notes may ever wait on, or fail because
 * of, the thing that merely observes the reading. Failures land in the server log and nowhere
 * else.
 *
 * There is deliberately NO mirror write-through here any more. The first cut upserted the
 * committed note into the mirror right after the git commit, and the review proved the shape
 * unfixable: a stalled upsert landing after a newer reconcile left a stale row under a current
 * head forever, invisible to every subsequent sync. The mirror now has exactly one writer — the
 * reconciler, through one atomic CAS-guarded apply — and a write is visible after the next read
 * heals the mirror, which costs that read one compare and one pinned-ref fetch. Freshness moved
 * a few hundred milliseconds; correctness stopped depending on which of two racing requests
 * stalled longer.
 */
import { after } from "next/server";
import { mirrorStore } from "./mirror";
import { currentSurface } from "./calls";

/**
 * Record that notes were actually SERVED to a caller. One row per note per call; listings do not
 * count, being handed the text does.
 *
 * Registered with the request lifecycle via after(), the same pattern lib/calls.ts uses for its
 * KV write and for the same reason: on a serverless instance, the last call before idle is the
 * COMMON case for a personal server, and a bare floating promise is dropped exactly there —
 * which for this table means phase 4's temperatures undercounting most real reads. Outside a
 * request scope (tests, scripts) after() throws, and fire-and-forget is the accepted deal.
 */
export function logNoteAccess(paths: string[], tool: string, mode: string): void {
  const store = mirrorStore();
  if (!store || paths.length === 0) return;
  const surface = currentSurface();
  const write = store
    .access(paths.map((path) => ({ path, tool, surface, mode })))
    .catch((e) => console.error(`[access] dropped ${paths.length} row(s): ${String(e)}`));
  try {
    after(write);
  } catch {
    /* no request scope — the write races the process, and a lost row is accepted */
  }
}
