import { safeEqualStrings } from "@/lib/auth";
import { STAMP_COOKIE, readCookie, stampIsValid } from "@/lib/stamp";

/**
 * The shared plumbing of every console write endpoint: prove the secret, prove the device
 * stamp, refuse cross-origin, demand a JSON object. It existed as a hand-copied block in the settings and proposals routes
 * — two definitions of the console's write gate is one definition too many, and the copy is
 * how they drift. The duplication gate on the customer repo caught it; extraction is the fix
 * the finding deserved, not a suppression.
 *
 * Returns either the parsed body or the Response to send back — the caller stays a plain
 * route handler with its own semantics and its own refusal texts past this point.
 */
export function bad(message: string, status = 400): Response {
  return Response.json({ error: message }, { status });
}

export async function gateConsolePost(
  req: Request,
  params: Promise<{ secret: string }>
): Promise<{ body: Record<string, unknown> } | { deny: Response }> {
  const { secret } = await params;
  const expected = process.env.CONNECTOR_PATH_SECRET;
  if (!expected || !safeEqualStrings(secret, expected)) {
    // The same empty 404 as every other gate here: nothing lives at this path.
    return { deny: new Response(null, { status: 404 }) };
  }

  // The device stamp, second (see lib/stamp.ts): every console write is a button on a screen
  // only stamped devices can load, so a stampless POST is a leaked link being replayed, not a
  // person. Same empty 404 — a write gate must not be softer than the read gate above it.
  if (!stampIsValid(readCookie(req.headers.get("cookie"), STAMP_COOKIE))) {
    return { deny: new Response(null, { status: 404 }) };
  }

  // Same-origin only. Matched against the Host header OR the request URL, because neither is
  // reliably both — Host is absent on a synthesised Request, and req.url behind a custom
  // domain can carry the deployment host rather than the one the browser typed.
  const origin = req.headers.get("origin");
  if (origin) {
    let from: string;
    try {
      from = new URL(origin).host;
    } catch {
      return { deny: bad("bad origin", 403) };
    }
    const mine = new Set([req.headers.get("host"), new URL(req.url).host].filter(Boolean));
    if (!mine.has(from)) return { deny: bad("cross-origin request refused", 403) };
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return { deny: bad("body must be JSON") };
  }
  // Arrays are objects; an array body carries none of the expected fields and would otherwise
  // sail through as a no-op write that reports success.
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    return { deny: bad("body must be a JSON object") };
  }
  return { body: body as Record<string, unknown> };
}
