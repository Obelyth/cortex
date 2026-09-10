// The clock's door for the ops ledger. Bearer CRON_SECRET only — Vercel sends it automatically
// on cron invocations. Wrong or missing auth is an empty 404, like the rest of the gated surface.
import { safeEqualStrings } from "@/lib/auth";
import { opsStore } from "@/lib/ops";
import { mailer } from "@/lib/mail";
import { runSweep } from "@/lib/sweep";
import { dateUndatedNotes, lastCommitDateOf, noteDater, REQUEST_TIMEOUT_MS as MIRROR_TIMEOUT_MS } from "@/lib/mirror";
import { REQUEST_TIMEOUT_MS as GITHUB_TIMEOUT_MS } from "@/lib/github";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/** Five seconds below the platform wall. Everything here is measured against this one absolute
 * instant, never against a budget copied at the start and read after something slow. */
const REQUEST_DEADLINE_MS = 55_000;
/** The sweep's own share. The ledger is what this door exists for, so it goes first. */
const SWEEP_BUDGET_MS = 30_000;
/** What one reply, or one request overrunning its timeout by a beat, is allowed to cost. */
const SLACK_MS = 5_000;
/** Dating stops taking new paths after this much of its own time, whatever the deadline says. */
const DATING_BUDGET_MS = 25_000;
const DATING_PER_TICK = 20;
/**
 * Dating is three kinds of request, each with its own ceiling: the undated read and the write ride
 * the mirror's timeout; the commit lookup rides GitHub's, which is longer. A path costs one lookup
 * and one write at worst, and a tick's first path also costs the read. Dating starts only with
 * room for that first path plus slack for the sweep's overshoot and the reply; before each further
 * path it checks for room for that path plus the reply. It is a chore — a tick that skips it loses
 * nothing the next tick does not pick up — so the reservation errs toward waiting.
 */
const DATING_PATH_MS = GITHUB_TIMEOUT_MS + MIRROR_TIMEOUT_MS + SLACK_MS;
const DATING_RESERVE_MS = MIRROR_TIMEOUT_MS + DATING_PATH_MS + SLACK_MS;

function authorized(req: Request): boolean {
  const expected = process.env.CRON_SECRET?.trim();
  if (!expected || expected.length < 16) return false;
  const m = /^Bearer\s+(.+)$/i.exec(req.headers.get("authorization") ?? "");
  return !!m && safeEqualStrings(m[1].trim(), expected);
}

export async function GET(req: Request): Promise<Response> {
  if (!authorized(req)) return new Response(null, { status: 404 });
  const deadline = Date.now() + REQUEST_DEADLINE_MS;
  const store = opsStore();
  if (!store) return Response.json({ error: "ops ledger not configured" }, { status: 503 });
  // The bare origin, never `/s/<CONNECTOR_PATH_SECRET>/…`: a mail sits in an inbox forever and
  // gets forwarded, and the console secret must not ride along in it. The operator's stamped
  // device is redirected from the root to the board, so one extra hop is the whole cost.
  const base = `${new URL(req.url).origin}/`;
  try {
    const sweep = await runSweep(store, mailer(), new Date(), base, Math.min(deadline, Date.now() + SWEEP_BUDGET_MS));
    // The clock's second job, AFTER the first: date the notes a full sync left undated
    // (lib/mirror.ts, the dater). The ledger's sweep is what this door exists for, so it runs
    // first and its result is what the response carries even if dating never gets a turn.
    const dater = noteDater();
    const started = Date.now();
    const outOfTime = () => Date.now() - started > DATING_BUDGET_MS || Date.now() + DATING_PATH_MS > deadline;
    const dating =
      dater && process.env.GITHUB_TOKEN
        ? deadline - Date.now() < DATING_RESERVE_MS
          ? { deferred: "request budget" }
          : await dateUndatedNotes(dater, lastCommitDateOf, DATING_PER_TICK, outOfTime).catch(() => ({
              error: "note dating unavailable",
            }))
        : null;
    return Response.json({ ...sweep, dating });
  } catch {
    return Response.json({ error: "ops sweep unavailable; pending delivery requires recheck" }, { status: 502 });
  }
}
export const POST = GET;
