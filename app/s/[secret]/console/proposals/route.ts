import { acceptProposal, dropProposal } from "@/lib/proposals";
import { bad, gateConsolePost } from "../post-gate";

/**
 * Accept or reject a guest proposal from the console — the human half of the same gate
 * brain_accept / brain_reject give the trusted model.
 *
 * Same discipline as the settings endpoint: a route handler, not a server action, so the secret
 * is re-proved on every request rather than trusted from a public bundle. This one matters more
 * — the settings endpoint changes which model reads, this one commits text into the brain.
 */
export const dynamic = "force-dynamic";

export async function POST(
  req: Request,
  ctx: { params: Promise<{ secret: string }> }
): Promise<Response> {
  const gate = await gateConsolePost(req, ctx.params);
  if ("deny" in gate) return gate.deny;
  const b = gate.body;
  if (typeof b.id !== "string" || !b.id) return bad("id is required");
  if (b.action !== "accept" && b.action !== "reject") {
    return bad('action must be "accept" or "reject"');
  }

  try {
    if (b.action === "reject") {
      const gone = await dropProposal(b.id);
      return Response.json({ ok: true, action: "reject", found: gone });
    }
    const res = await acceptProposal(b.id);
    return Response.json({ ok: true, action: "accept", path: res.path, commitSha: res.commitSha });
  } catch (e) {
    // A failed accept leaves the proposal pending on purpose — the message says what went
    // wrong, and the row is still there to try again.
    return bad(e instanceof Error ? e.message : String(e), 409);
  }
}
