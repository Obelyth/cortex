import { safeEqualStrings } from "@/lib/auth";
import { STAMP_COOKIE, readCookie, stampIsValid } from "@/lib/stamp";
import {readBoundedJson,type JsonBodyFailure} from "@/lib/bounded-json";

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

/**
 * The secret + device-stamp half of the write gate, on its own: no body parse, no origin
 * check. A GET that reads on behalf of a device (the notices feed) needs exactly this much —
 * it has no body to parse and no origin to police, since a same-origin GET carries no CSRF
 * risk a POST does. `gateConsolePost` below composes this with the two checks a write still
 * needs, so the secret/stamp logic has one definition either way.
 */
export async function requireSecretOnly(
  req: Request,
  params: Promise<{ secret: string }>
): Promise<{ stamp: string } | { deny: Response }> {
  const { secret } = await params;
  const expected = process.env.CONNECTOR_PATH_SECRET;
  if (!expected || !safeEqualStrings(secret, expected)) {
    // The same empty 404 as every other gate here: nothing lives at this path.
    return { deny: new Response(null, { status: 404 }) };
  }

  // The device stamp, second (see lib/stamp.ts): every console screen is behind a stamped
  // device, so a stampless request is a leaked link being replayed, not a person. Same empty
  // 404 — a gate here must not be softer than the read gate in front of the page itself.
  const stamp = readCookie(req.headers.get("cookie"), STAMP_COOKIE);
  if (!stampIsValid(stamp)) {
    return { deny: new Response(null, { status: 404 }) };
  }

  return { stamp: stamp! };
}

export async function gateConsolePost(
  req: Request,
  params: Promise<{ secret: string }>,
  options:{maxBytes?:number;bodyFailure?:(reason:JsonBodyFailure)=>Response}={}
): Promise<{ body: Record<string, unknown>; stamp: string } | { deny: Response }> {
  const gate = await requireSecretOnly(req, params);
  if ("deny" in gate) return gate;
  const { stamp } = gate;

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

  const parsed=await readBoundedJson(req,options.maxBytes);
  if("failure" in parsed){const reason=parsed.failure;return{deny:options.bodyFailure?.(reason)??bad(reason==="too_large"?"request exceeds 65,536 bytes":reason==="timeout"?"body read timed out":reason==="not_object"?"body must be a JSON object":"body must be JSON",reason==="too_large"?413:reason==="timeout"?408:400)};}
  return { body:parsed.body, stamp };
}
