import { createMcpHandler, withMcpAuth } from "mcp-handler";
import { verifyToken } from "@/lib/auth";
import { registerTools } from "@/lib/tools";

/**
 * Cortex authenticates with a static bearer and runs no OAuth server. mcp-handler's
 * withMcpAuth does not know that: it advertises RFC 9728 `resource_metadata` on every 401/403,
 * which is an invitation to go discover an authorization server. Header-capable clients that
 * implement the discovery flow — Cursor, Gemini CLI, Codex — take the invitation, abandon the
 * bearer they were configured with, and fail to connect at all. The server was never wrong
 * about the credential; it was advertising a door that does not exist.
 *
 * So the hint is stripped. This weakens nothing: it rewrites one response header on requests
 * that have ALREADY been refused, leaves status, body and every 2xx untouched, and no-ops when
 * there is no hint to remove. The bearer check itself is upstream and unchanged.
 *
 * The `error_description` mcp-handler puts in that header goes with it. That costs a line of
 * diagnostics on a bad token, and buys every non-Claude orchestrator being able to connect —
 * which is the point of the whole door.
 *
 * Ported from the Cursor-authored fix on Obelyth/cortex#2, which is where it was written and
 * not where it belongs: this repo is upstream, and the same bug is here.
 */
export function stripOAuthHints(res: Response): Response {
  if (res.status !== 401 && res.status !== 403) return res;
  const www = res.headers.get("WWW-Authenticate");
  if (!www?.includes("resource_metadata=")) return res;
  const headers = new Headers(res.headers);
  headers.set("WWW-Authenticate", 'Bearer realm="cortex"');
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
}

/**
 * Two handlers, because the guest door must not merely REFUSE the write tools — it must not
 * list them. A tool that appears and then errors teaches a foreign model to keep trying, and
 * tells it exactly what exists to be attacked. The guest's tools/list is the honest answer to
 * "what may I do here".
 */
function build(guest: boolean) {
  const mcpHandler = createMcpHandler(
    (server) => {
      registerTools(server, { guest });
    },
    { serverInfo: { name: guest ? "cortex (guest)" : "cortex", version: "1.0.0" } },
    {
      basePath: "/api",
      maxDuration: 60,
      disableSse: true,
      verboseLogs: false,
    }
  );
  const authed = withMcpAuth(mcpHandler, verifyToken, { required: true });
  // Both doors, not just the trusted one: a guest arrives on someone else's client, which is
  // exactly the population most likely to chase an OAuth hint that leads nowhere.
  return async (req: Request): Promise<Response> => stripOAuthHints(await authed(req));
}

export const handler = build(false);
export const guestHandler = build(true);
