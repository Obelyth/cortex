import { guestHandler } from "@/lib/handler";
import { safeEqualStrings } from "@/lib/auth";
import { withSurface } from "@/lib/calls";

export const maxDuration = 60;

/**
 * The guest door.
 *
 * Same shape as the connector alias — a path secret rewritten onto the bearer-gated handler —
 * but it lands on `guestHandler`, whose toolset can read everything and write nothing. Hand this
 * URL to an assistant you do not control: it gets the brain, and the brain does not get it.
 *
 * `GUEST_PATH_SECRET` is its own credential and MUST NOT equal `CONNECTOR_PATH_SECRET`. The
 * check below refuses that configuration outright rather than quietly serving the reduced
 * toolset at both paths — a shared secret would mean revoking the guest's access revokes
 * The operator's, which is exactly the coupling this door exists to avoid.
 *
 * 404 (not 401) on any mismatch — nothing advertises that anything lives here.
 */
async function guest(
  req: Request,
  ctx: { params: Promise<{ secret: string; transport: string }> }
): Promise<Response> {
  // mcp-handler never settles its response promise for HEAD, so the function would pin for the
  // full 60s maxDuration. Short-circuit before anything else.
  if (req.method === "HEAD") return new Response(null, { status: 405 });
  const { secret, transport } = await ctx.params;
  const expected = process.env.GUEST_PATH_SECRET;
  const token = process.env.MCP_TOKEN;
  if (!expected || !token || transport !== "mcp" || !safeEqualStrings(secret, expected)) {
    return new Response(null, { status: 404 });
  }
  // A guest secret that equals the trusted one is a misconfiguration, not a shortcut.
  const trusted = process.env.CONNECTOR_PATH_SECRET;
  if (trusted && safeEqualStrings(expected, trusted)) {
    return new Response(null, { status: 404 });
  }

  const url = new URL(req.url);
  url.pathname = "/api/mcp";
  const headers = new Headers(req.headers);
  headers.set("authorization", `Bearer ${token}`);
  const synthetic = new Request(url, {
    method: req.method,
    headers,
    body: req.method === "GET" || req.method === "HEAD" ? undefined : req.body,
    // @ts-expect-error duplex is required by undici for streamed bodies and not yet in lib.dom types
    duplex: "half",
  });
  return withSurface("guest", () => guestHandler(synthetic));
}

export { guest as GET, guest as POST, guest as DELETE };
