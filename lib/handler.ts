import { createMcpHandler, withMcpAuth } from "mcp-handler";
import { verifyToken } from "@/lib/auth";
import { registerTools } from "@/lib/tools";

const mcpHandler = createMcpHandler(
  (server) => {
    registerTools(server);
  },
  { serverInfo: { name: "cortex", version: "1.0.0" } },
  {
    basePath: "/api",
    maxDuration: 60,
    disableSse: true,
    verboseLogs: false,
  }
);

const authed = withMcpAuth(mcpHandler, verifyToken, { required: true });

/**
 * mcp-handler's withMcpAuth always advertises RFC 9728 resource_metadata on 401/403.
 * Cursor treats that as OAuth discovery and can ignore a configured Authorization header
 * (bearer-only Cortex has no OAuth server). Strip the hint so header-capable clients
 * (Cursor, Gemini CLI, Codex) stay on static bearer auth.
 */
export function stripOAuthHints(res: Response): Response {
  if (res.status !== 401 && res.status !== 403) return res;
  const www = res.headers.get("WWW-Authenticate");
  if (!www?.includes("resource_metadata=")) return res;
  const headers = new Headers(res.headers);
  headers.set("WWW-Authenticate", 'Bearer realm="cortex"');
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
}

export async function handler(req: Request): Promise<Response> {
  return stripOAuthHints(await authed(req));
}
