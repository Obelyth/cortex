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

  it("GET still delegates to the shared handler", async () => {
    const req = new Request("https://cortex.test/api/mcp", { method: "GET" });
    const res = await GET(req);
    expect(res.status).toBe(200);
    expect(mHandler).toHaveBeenCalledWith(req);
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
