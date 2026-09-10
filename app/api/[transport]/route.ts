import { handler } from "@/lib/handler";
import { withSurface } from "@/lib/calls";

export const maxDuration = 60;

// mcp-handler never settles its response promise for HEAD (Next aliases HEAD to
// the exported GET), so the function would pin for the full 60s maxDuration.
// Short-circuit before the shared handler ever sees the request.
// THE GET NOTIFICATION STREAM IS ANSWERED, NOT HELD. MCP's Streamable HTTP lets a client open
// GET for server-initiated messages; mcp-handler keeps that request open waiting for some, and
// this server has none to send. Every tool result comes back on the POST that asked for it, so
// holding an empty stream only consumes the function duration. A 405 is the explicit answer for
// a server that does not stream, and HEAD is short-circuited for the same reason.
async function route(req: Request): Promise<Response> {
  if (req.method === "HEAD" || req.method === "GET") return new Response(null, { status: 405 });
  // The door is the surface. Marked here rather than read from a header, which a client
  // holding the token could set to log itself under the other door.
  return withSurface("terminal", () => handler(req));
}

export { route as GET, route as POST, route as DELETE };
