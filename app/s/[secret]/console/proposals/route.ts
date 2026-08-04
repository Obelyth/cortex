import { safeEqualStrings } from "@/lib/auth";
import { acceptProposal, dropProposal } from "@/lib/proposals";

/**
 * Accept or reject a guest proposal from the console — the human half of the same gate
 * brain_accept / brain_reject give the trusted model.
 *
 * Same discipline as the settings endpoint: a route handler, not a server action, so the secret
 * is re-proved on every request rather than trusted from a public bundle. This one matters more
 * — the settings endpoint changes which model reads, this one commits text into the brain.
 */
export const dynamic = "force-dynamic";

function bad(message: string, status = 400): Response {
  return Response.json({ error: message }, { status });
}

export async function POST(
  req: Request,
  ctx: { params: Promise<{ secret: string }> }
): Promise<Response> {
  const { secret } = await ctx.params;
  const expected = process.env.CONNECTOR_PATH_SECRET;
  if (!expected || !safeEqualStrings(secret, expected)) {
    return new Response(null, { status: 404 });
  }

  const origin = req.headers.get("origin");
  if (origin) {
    let from: string;
    try {
      from = new URL(origin).host;
    } catch {
      return bad("bad origin", 403);
    }
    const mine = new Set([req.headers.get("host"), new URL(req.url).host].filter(Boolean));
    if (!mine.has(from)) return bad("cross-origin request refused", 403);
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return bad("body must be JSON");
  }
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    return bad("body must be a JSON object");
  }
  const b = body as Record<string, unknown>;
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
