import { safeText } from "./frontmatter";

/** Shared by the two proposal consoles; a missing response never proves a write rolled back.
 *  Everything the body carries into a sentence is foreign — the path is guest-authored, the
 *  warnings are whatever the store said — so it is clipped and passed through safeText first. */
export type ProposalAction = "accept" | "reject" | "cancel";
export async function submitProposalDecision(url: string, id: string, action: ProposalAction): Promise<{ success: boolean; message: string }> {
  try {
    const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id, action }) });
    const body = await res.json();
    if (!res.ok) {
      if (typeof body?.error !== "string") throw new Error("missing outcome");
      return { success: false, message: safeText(body.error, 300) };
    }
    if (action === "reject" && body?.ok === true) return { success: true, message: body.found ? "Proposal rejected." : "No pending proposal found." };
    if (!["committed", "canceled"].includes(body?.outcome) || typeof body.path !== "string" || typeof body.commitSha !== "string") throw new Error("missing outcome");
    const path = safeText(body.path, 160), sha = safeText(body.commitSha, 64);
    const message = body.outcome === "canceled"
      ? `Canceled acceptance for ${path} (cancellation receipt ${sha}). The target note was preserved.`
      : `Committed ${path} (commit ${sha}).`;
    const warning = (label: string, value: unknown) => typeof value === "string" && value ? ` ${label}: ${safeText(value, 200)}.` : "";
    return { success: true, message: message + warning("Index warning", body.indexWarning) + warning("Queue warning", body.cleanupWarning) };
  } catch {
    return { success: false, message: action !== "reject"
      ? `The response was not received; this may already be committed or canceled. Retry ${action === "cancel" ? "cancellation" : "acceptance"} with the same proposal id ${id} to resolve the outcome.`
      : "The response was not received. Refresh the queue to check whether rejection completed." };
  }
}
