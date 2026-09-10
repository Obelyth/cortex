import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../lib/handler", () => ({ handler: vi.fn() }));

import { handler } from "../lib/handler";
import { GET, POST, DELETE } from "../app/api/[transport]/route";

const mHandler = vi.mocked(handler);

beforeEach(() => {
  vi.resetAllMocks();
  mHandler.mockResolvedValue(new Response("ok", { status: 200 }));
});

describe("main transport route HEAD short-circuit (FIX E)", () => {
  it("HEAD returns 405 immediately and never invokes the shared handler", async () => {
    const req = new Request("https://cortex.test/api/mcp", { method: "HEAD" });
    const res = await GET(req);
    expect(res.status).toBe(405);
    expect(mHandler).not.toHaveBeenCalled();
  });

  // WAS: "GET still delegates to the shared handler" — the companion assertion proving the HEAD
  // fix had not caught GET by accident. It has now, deliberately. Streamable HTTP's GET is the
  // channel for server-initiated messages and this server sends none, so mcp-handler held the
  // request open until the platform killed it at 60s: 622 times between 2026-08-12 and
  // 2026-09-02. Refusing it is not a regression on a stream that never delivered anything.
  it("GET is refused too — the notification stream this server never writes to", async () => {
    const req = new Request("https://cortex.test/api/mcp", { method: "GET" });
    const res = await GET(req);
    expect(res.status).toBe(405);
    expect(mHandler).not.toHaveBeenCalled();
  });

  it("POST and DELETE also delegate to the shared handler", async () => {
    const postReq = new Request("https://cortex.test/api/mcp", { method: "POST" });
    const delReq = new Request("https://cortex.test/api/mcp", { method: "DELETE" });
    await POST(postReq);
    await DELETE(delReq);
    expect(mHandler).toHaveBeenCalledWith(postReq);
    expect(mHandler).toHaveBeenCalledWith(delReq);
  });
});
