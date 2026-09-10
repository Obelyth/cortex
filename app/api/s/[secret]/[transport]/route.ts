import { handler } from "@/lib/handler";
import { safeEqualStrings } from "@/lib/auth";
import { withSurface } from "@/lib/calls";

export const maxDuration = 60;

// Secret-URL alias for clients that cannot send an Authorization header
// (claude.ai custom connectors without the request-header beta). Validates
// the path secret, then invokes the normal bearer-gated handler with a
// synthetic request targeting /api/mcp. 404 (not 401) on any mismatch —
// don't advertise that anything lives here.
// THE GET NOTIFICATION STREAM IS ANSWERED, NOT HELD. MCP's Streamable HTTP lets a client open
// GET for server-initiated messages; mcp-handler keeps that request open waiting for some, and
// this server has none to send. Every tool result comes back on the POST that asked for it, so
// holding an empty stream only consumes the function duration. A 405 is the explicit answer for
// a server that does not stream, and HEAD is short-circuited for the same reason.
async function aliased(
  req: Request,
  ctx: { params: Promise<{ secret: string; transport: string }> }
): Promise<Response> {
  const { secret, transport } = await ctx.params;
  const expected = process.env.CONNECTOR_PATH_SECRET;
  const token = process.env.MCP_TOKEN;
  if (!expected || !token || transport !== "mcp" || !safeEqualStrings(secret, expected)) {
    return new Response(null, { status: 404 });
  }
  // AFTER THE SECRET, NOT BEFORE IT. mcp-handler never settles its response promise for HEAD,
  // and answers GET by holding a notification stream this server never writes to. Both are
  // refused, but only once the path has proved itself:
  // answering 405 above the check would tell an unauthenticated prober that this route exists,
  // which is the one thing a secret in the path is for. A wrong secret still 404s for every
  // method, and 405 here is not a regression on a stream that was being killed anyway — it is
  // the same answer in a millisecond instead of a minute.
  if (req.method === "HEAD" || req.method === "GET") return new Response(null, { status: 405 });

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
  // The door is the surface — marked here, where the rewrite happens.
  return withSurface("connector", () => handler(synthetic));
}

export { aliased as GET, aliased as POST, aliased as DELETE };
