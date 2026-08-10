import { beforeEach, describe, expect, it, vi } from "vitest";
import { verifyToken } from "../lib/auth";

const req = new Request("https://cortex.test/api/mcp");

beforeEach(() => {
  vi.stubEnv("MCP_TOKEN", "s3cret-token-value");
});

describe("verifyToken", () => {
  it("accepts the exact token", async () => {
    const info = await verifyToken(req, "s3cret-token-value");
    expect(info).toMatchObject({ clientId: "operator", scopes: ["brain"] });
  });

  it("rejects wrong token", async () => {
    expect(await verifyToken(req, "wrong")).toBeUndefined();
  });

  it("rejects missing token", async () => {
    expect(await verifyToken(req, undefined)).toBeUndefined();
  });

  it("rejects everything when MCP_TOKEN unset (fail closed)", async () => {
    vi.stubEnv("MCP_TOKEN", "");
    expect(await verifyToken(req, "s3cret-token-value")).toBeUndefined();
  });
});
