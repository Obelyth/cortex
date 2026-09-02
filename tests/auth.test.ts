import { beforeEach, describe, expect, it, vi } from "vitest";
import { safeEqualStrings, verifyToken } from "../lib/auth";

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

  it("fails closed on a whitespace-only MCP_TOKEN", async () => {
    // The `.trim()` in verifyToken exists ONLY for this case, and nothing held the line: "" is
    // falsy so every other test here passes with or without it, which makes it look redundant
    // and one refactor away from deletion. A padded env var is one copy-paste into the Vercel
    // dashboard, and without the trim that padding becomes a valid credential for anyone who
    // sends the same whitespace as a bearer.
    for (const padded of ["   ", "\t", "\n  "]) {
      vi.stubEnv("MCP_TOKEN", padded);
      expect(await verifyToken(req, padded)).toBeUndefined();
      expect(await verifyToken(req, "")).toBeUndefined();
      expect(await verifyToken(req, undefined)).toBeUndefined();
    }
  });

  it("accepts a bearer whose padding differs from the configured secret", async () => {
    // The other half of the same trim: a client that sends "  token  " still authenticates.
    vi.stubEnv("MCP_TOKEN", "  s3cret-token-value  ");
    expect(await verifyToken(req, " s3cret-token-value ")).toMatchObject({ clientId: "operator" });
  });
});

describe("safeEqualStrings", () => {
  // timingSafeEqual THROWS on mismatched buffer lengths, so the length guard is the only thing
  // standing between an unequal-length comparison and a 500. Never exercised until now.
  it("returns false on unequal lengths instead of throwing", () => {
    expect(() => safeEqualStrings("short", "a-much-longer-value")).not.toThrow();
    expect(safeEqualStrings("short", "a-much-longer-value")).toBe(false);
    expect(safeEqualStrings("", "x")).toBe(false);
  });

  it("compares equal-length strings by value", () => {
    expect(safeEqualStrings("abc", "abc")).toBe(true);
    expect(safeEqualStrings("abc", "abd")).toBe(false);
    expect(safeEqualStrings("", "")).toBe(true);
  });

  it("is byte-wise, so multi-byte characters do not collide", () => {
    expect(safeEqualStrings("é", "e")).toBe(false);
  });
});
