import { acceptProposal, cancelProposal, dropProposal } from "@/lib/proposals";
import { ProposalOutcomeUncertain } from "@/lib/proposal-git";
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

const privateResponse = (res: Response) => { res.headers.set("Cache-Control", "no-store"); return res; };

export async function POST(
  req: Request,
  ctx: { params: Promise<{ secret: string }> }
): Promise<Response> {
  const gate = await gateConsolePost(req, ctx.params);
  if ("deny" in gate) return privateResponse(gate.deny);
  const b = gate.body;
  if (typeof b.id !== "string" || !b.id) return privateResponse(bad("id is required"));
  if (b.action !== "accept" && b.action !== "reject" && b.action !== "cancel") {
    return privateResponse(bad('action must be "accept", "reject", or "cancel"'));
  }

  try {
    if (b.action === "reject") {
      const gone = await dropProposal(b.id);
      return privateResponse(Response.json({ ok: true, action: "reject", found: gone }));
    }
    const res = await (b.action === "cancel" ? cancelProposal(b.id) : acceptProposal(b.id));
    return privateResponse(Response.json({ ok: true, action: b.action, ...res }));
  } catch (e) {
    const uncertain = e instanceof ProposalOutcomeUncertain;
    return privateResponse(Response.json({ error: e instanceof Error ? e.message : String(e),
      ...(uncertain ? { outcome: "uncertain" } : {}) }, { status: uncertain ? 503 : 409 }));
  }
}
