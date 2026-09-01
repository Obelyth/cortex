import { safeEqualStrings } from "@/lib/auth";
import { health } from "@/lib/health";

/**
 * The verification queue, as JSON — the groundskeeper's view of the inbox.
 *
 * The nightly run and the console MUST share one opinion of "which stamps are stale": the
 * groundskeeper recomputing its own from the clone is a second definition, and two definitions
 * of the same check is the drift this codebase keeps paying to delete (see lib/health.ts's own
 * header). So the machine that does the verifying reads the queue from the same health() the
 * inbox renders, over the same path secret it already holds for the healthcheck.
 *
 * Two lists, in draining order:
 *
 *   queued   stale notes the operator explicitly asked about (`reverify:` in frontmatter),
 *            oldest request first — these are requests, so all of them get drained.
 *   stale    the rest of the stale-stamp findings, oldest stamp first — the groundskeeper
 *            fills its bounded discretionary slots from the top of this list.
 *
 * Deliberately ONLY the verification loop. The watch-tier checks (superseded-link,
 * coaccess-gap, correction-chain) are judgment edits with their own resolutions; when they
 * grow an automated consumer it gets its own surface, not a ride on this one.
 *
 * GET with no body and no side effects, so the write gate's origin/JSON demands do not apply;
 * the secret check is the same fail-closed 404 every other gate here returns.
 *
 * DELIBERATELY EXEMPT from the device stamp the human console requires. This is a machine
 * door: the groundskeeper's inboxqueue.sh reads it nightly from the Mac with the path secret
 * and no cookie jar, and a passcode is exactly the thing a launchd job cannot type. What it
 * serves is stale-stamp metadata — paths and ages, never note content. Tightening this route
 * means teaching that script the stamp first; do not "fix" the asymmetry from this side.
 */
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET(
  _req: Request,
  ctx: { params: Promise<{ secret: string }> }
): Promise<Response> {
  const { secret } = await ctx.params;
  const expected = process.env.CONNECTOR_PATH_SECRET;
  if (!expected || !safeEqualStrings(secret, expected)) {
    // The same empty 404 as every other gate here: nothing lives at this path.
    return new Response(null, { status: 404 });
  }

  const h = await health();
  const queued = h.stale
    .filter((s) => s.queued !== undefined)
    .sort((a, b) => a.queued!.localeCompare(b.queued!) || b.age - a.age)
    .map((s) => ({ path: s.path, requested: s.queued!, verified: s.verified, age: s.age }));
  // h.stale is already oldest-stamp-first (age descending).
  const stale = h.stale
    .filter((s) => s.queued === undefined)
    .map((s) => ({ path: s.path, verified: s.verified, age: s.age }));

  return Response.json({ sha: h.sha, queued, stale });
}
