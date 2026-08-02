import { handler } from "@/lib/handler";
import { safeEqualStrings } from "@/lib/auth";

export const maxDuration = 60;

// Secret-URL alias for clients that cannot send an Authorization header
// (claude.ai custom connectors without the request-header beta). Validates
// the path secret, then invokes the normal bearer-gated handler with a
// synthetic request targeting /api/mcp. 404 (not 401) on any mismatch —
// don't advertise that anything lives here.
async function aliased(
  req: Request,
  ctx: { params: Promise<{ secret: string; transport: string }> }
): Promise<Response> {
  // mcp-handler never settles its response promise for HEAD, so the function
  // would pin for the full 60s maxDuration. Short-circuit before anything else.
  if (req.method === "HEAD") return new Response(null, { status: 405 });
  const { secret, transport } = await ctx.params;
  const expected = process.env.CONNECTOR_PATH_SECRET;
  const token = process.env.MCP_TOKEN;
  if (!expected || !token || transport !== "mcp" || !safeEqualStrings(secret, expected)) {
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
  return handler(synthetic);
}

export { aliased as GET, aliased as POST, aliased as DELETE };
