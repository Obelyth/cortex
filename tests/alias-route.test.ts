import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../lib/handler", () => ({ handler: vi.fn() }));

import { handler } from "../lib/handler";
import { POST as aliased } from "../app/api/s/[secret]/[transport]/route";

const mHandler = vi.mocked(handler);
const SECRET = "a".repeat(64);

function call(secret: string, transport = "mcp") {
  const req = new Request(`https://cortex.test/api/s/${secret}/${transport}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", method: "tools/list", id: 1 }),
  });
  return aliased(req, { params: Promise.resolve({ secret, transport }) });
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv("CONNECTOR_PATH_SECRET", SECRET);
  vi.stubEnv("MCP_TOKEN", "real-bearer-token");
  mHandler.mockResolvedValue(new Response("ok", { status: 200 }));
});

describe("secret-URL alias route", () => {
  it("invokes the core handler with /api/mcp URL and injected bearer", async () => {
    const res = await call(SECRET);
    expect(res.status).toBe(200);
    expect(mHandler).toHaveBeenCalledOnce();
    const synthetic = mHandler.mock.calls[0][0] as Request;
    expect(new URL(synthetic.url).pathname).toBe("/api/mcp");
    expect(synthetic.headers.get("authorization")).toBe("Bearer real-bearer-token");
    expect(synthetic.method).toBe("POST");
  });

  it("404s on wrong secret without touching the handler", async () => {
    expect((await call("b".repeat(64))).status).toBe(404);
    expect(mHandler).not.toHaveBeenCalled();
  });

  it("404s on non-mcp transport", async () => {
    expect((await call(SECRET, "sse")).status).toBe(404);
    expect(mHandler).not.toHaveBeenCalled();
  });

  it("fails closed when env unset", async () => {
    vi.stubEnv("CONNECTOR_PATH_SECRET", "");
    expect((await call(SECRET)).status).toBe(404);
    vi.stubEnv("CONNECTOR_PATH_SECRET", SECRET);
    vi.stubEnv("MCP_TOKEN", "");
    expect((await call(SECRET)).status).toBe(404);
    expect(mHandler).not.toHaveBeenCalled();
  });

  it("forwards the body through to the handler", async () => {
    await call(SECRET);
    const synthetic = mHandler.mock.calls[0][0] as Request;
    expect(await synthetic.text()).toContain("tools/list");
  });

  it("HEAD returns 405 immediately and never invokes the shared handler (mcp-handler hangs on HEAD for 60s)", async () => {
    const req = new Request(`https://cortex.test/api/s/${SECRET}/mcp`, { method: "HEAD" });
    const res = await aliased(req, { params: Promise.resolve({ secret: SECRET, transport: "mcp" }) });
    expect(res.status).toBe(405);
    expect(mHandler).not.toHaveBeenCalled();
  });
});
