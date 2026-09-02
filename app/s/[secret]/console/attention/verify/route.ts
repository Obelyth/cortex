import { readNoteRaw, writeNote, validatePath } from "@/lib/brain";
import { applyDecays, applyReverify } from "@/lib/frontmatter";
import { stampVerified, DATED_ENTRY } from "@/lib/health";
import { bad, gateConsolePost } from "../../post-gate";

/**
 * The three honest answers to "this note's verification stamp is stale", as buttons.
 *
 * The inbox used to be able to state a problem and nothing else, so the only way to clear an item
 * was to open an editor, find the stamp, and retype a date — which is why seven of them sat there.
 * An inbox you cannot act on is a list of complaints.
 *
 * WHY NONE OF THE ACTIONS IS "DISMISS". A dismiss button would be the obvious extra, and it is
 * the one that must not exist: it clears the symptom, changes nothing in the brain, and the
 * finding returns tomorrow having taught you to click past it. Every action here writes to the
 * brain and is recorded as a commit, so the inbox emptying means something changed.
 *
 *   checked   The operator attests the page's claims are still true, and the stamp moves to today.
 *             This is a CLAIM, made by a person, which is why the button says so — pressing it
 *             without reading the note puts a false statement into the brain under their name, and
 *             no wording here can prevent that. It can at least refuse to look like a dismiss.
 *
 *   settled   The note records something that happened rather than something that is true now, so
 *             it stops being watched. `decays: false` in frontmatter, portable with the note, no
 *             database entry that a fresh clone would lose.
 *
 *   queue     The operator asks the nightly groundskeeper to re-verify the page, instead of doing
 *             it by hand. `reverify: <today>` in frontmatter — a commit, like the others, and
 *             honestly NOT a resolution: the item stays in the queue wearing a "queued" badge
 *             until the groundskeeper consumes the marker and (when the page checks out) moves
 *             the stamp. This console never executes anything on the operator's machines; it
 *             writes a request into the corpus and the machine that holds the credentials reads
 *             it there.
 *
 * A route handler rather than a server action, matching the proposals endpoint: the secret is
 * re-proved on every request instead of being trusted from a bundle the browser already has.
 */
export const dynamic = "force-dynamic";

// The stamp rewrite lives in lib/health.ts, beside the function the inbox reads it with. Two
// definitions would drift the moment either was touched, and the failure would be silent: the
// queue reads a page's LAST stamp, so a button that rewrote the first would commit a change,
// report success, clear nothing, and falsify a dated section's record on the way past.

export async function POST(
  req: Request,
  ctx: { params: Promise<{ secret: string }> }
): Promise<Response> {
  const gate = await gateConsolePost(req, ctx.params);
  if ("deny" in gate) return gate.deny;
  const b = gate.body;

  if (typeof b.path !== "string" || !b.path) return bad("path is required");
  if (b.action !== "checked" && b.action !== "settled" && b.action !== "queue") {
    return bad('action must be "checked", "settled" or "queue"');
  }
  // The same validator the write tools use. A console button is still a write path, and a path
  // that reaches this handler has come from a browser.
  try {
    validatePath(b.path);
  } catch (e) {
    return bad(e instanceof Error ? e.message : "invalid path");
  }
  // A day log is a dated record: the health check excludes it from every clock (DATED_ENTRY, the
  // diary doctrine), so no queue item can honestly point here and every one of these actions
  // would be a write nothing ever reads. It happened: on 2026-08-17 a press landed a `reverify:`
  // block on log/2026-08-17.md — frontmatter on a note that by convention carries none — which
  // broke the router's description invariant while the request itself went nowhere. Refuse
  // loudly instead of committing a marker to a page no check will ever visit.
  if (DATED_ENTRY.test(b.path)) {
    return bad(
      `${b.path} is a day log — a dated record that is never on the verification clock, so there is nothing here to check, settle or queue.`
    );
  }

  let current: string;
  try {
    // RAW, never readNote(). This is a read-modify-write: readNote() redacts for egress, so
    // reading through it saved the redaction into the brain and destroyed two real lines on
    // 2026-08-17. See readNoteRaw()'s comment for the incident and the general rule.
    current = await readNoteRaw(b.path);
  } catch (e) {
    return bad(e instanceof Error ? e.message : "could not read the note");
  }

  // Today in the deployment's own day-boundary, so a late-evening click does not stamp
  // tomorrow's date on the note.
  const today = new Date().toLocaleDateString("en-CA", {
    timeZone: process.env.BRAIN_TZ || "UTC",
  });

  let next: string;
  if (b.action === "settled") {
    next = applyDecays(current, false);
  } else if (b.action === "queue") {
    // Idempotent by applyReverify's own rule: a note already carrying a request keeps its
    // original date, and the no-op falls through to the changed:false report below.
    next = applyReverify(current, today);
  } else {
    const stamped = stampVerified(current, today);
    if (stamped === null) {
      // Refused rather than appended. This endpoint exists to refresh a stamp the note already
      // makes; inventing one would be this console asserting a claim the note never made.
      return bad(
        `${b.path} has no "_Facts last verified_" stamp to refresh. Add one in the note, or mark it as settled history.`
      );
    }
    next = stamped;
  }

  if (next === current) {
    // Already in the requested state. Reported as a no-op instead of a commit, because a save
    // that changed nothing should not return a SHA that implies it did.
    return Response.json({ ok: true, action: b.action, changed: false });
  }

  try {
    const res = await writeNote(b.path, next, "replace");
    return Response.json({ ok: true, action: b.action, changed: true, sha: res.commitSha });
  } catch (e) {
    return bad(e instanceof Error ? e.message : "the write failed");
  }
}
