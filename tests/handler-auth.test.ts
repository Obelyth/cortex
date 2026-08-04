import { describe, expect, it } from "vitest";
import { stripOAuthHints } from "../lib/handler";

describe("stripOAuthHints", () => {
  it("strips resource_metadata from 401 WWW-Authenticate so Cursor stays on bearer", () => {
    const res = new Response(JSON.stringify({ error: "invalid_token" }), {
      status: 401,
      headers: {
        "Content-Type": "application/json",
        "WWW-Authenticate":
          'Bearer error="invalid_token", error_description="No authorization provided", resource_metadata="https://cortex.test/.well-known/oauth-protected-resource"',
      },
    });
    const out = stripOAuthHints(res);
    expect(out.status).toBe(401);
    expect(out.headers.get("WWW-Authenticate")).toBe('Bearer realm="cortex"');
    expect(out.headers.get("WWW-Authenticate")).not.toContain("resource_metadata");
  });

  it("leaves successful responses alone", () => {
    const res = new Response("ok", { status: 200 });
    expect(stripOAuthHints(res)).toBe(res);
  });

  it("leaves 401s without OAuth hints alone", () => {
    const res = new Response("nope", {
      status: 401,
      headers: { "WWW-Authenticate": 'Bearer realm="cortex"' },
    });
    expect(stripOAuthHints(res)).toBe(res);
  });
});
