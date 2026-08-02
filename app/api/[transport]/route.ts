import { handler } from "@/lib/handler";

export const maxDuration = 60;

// mcp-handler never settles its response promise for HEAD (Next aliases HEAD to
// the exported GET), so the function would pin for the full 60s maxDuration.
// Short-circuit before the shared handler ever sees the request.
async function route(req: Request): Promise<Response> {
  if (req.method === "HEAD") return new Response(null, { status: 405 });
  return handler(req);
}

export { route as GET, route as POST, route as DELETE };
