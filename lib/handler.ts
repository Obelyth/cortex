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

export const handler = withMcpAuth(mcpHandler, verifyToken, { required: true });
