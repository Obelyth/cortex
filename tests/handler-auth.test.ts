import { beforeEach, describe, expect, it, vi } from "vitest";
import { guestHandler, handler, stripOAuthHints } from "../lib/handler";

/**
 * Cortex is bearer-only. The OAuth-discovery hint mcp-handler adds to a 401 sends
 * header-capable clients (Cursor, Gemini CLI, Codex) off to find an authorization server that
 * does not exist, and they abandon the bearer they were configured with on the way.
 *
 * The tests that matter here are the ones proving this is a NARROW rewrite: it must not touch a
 * success, must not touch a 401 that carries no hint, and must not alter status or body. A
 * response-rewriting wrapper sitting in front of the auth gate is exactly the kind of code that
 * quietly becomes a bypass, so its blast radius is pinned rather than described.
 */
describe("stripOAuthHints", () => {
  const withHint = (status: number) =>
    new Response(JSON.stringify({ error: "invalid_token" }), {
      status,
      headers: {
        "Content-Type": "application/json",
        "WWW-Authenticate":
          'Bearer error="invalid_token", error_description="No authorization provided", resource_metadata="https://cortex.test/.well-known/oauth-protected-resource"',
      },
    });

  it("strips resource_metadata from a 401 so a header client stays on bearer", async () => {
    const out = stripOAuthHints(withHint(401));
    expect(out.status).toBe(401);
    expect(out.headers.get("WWW-Authenticate")).toBe('Bearer realm="cortex"');
    // The body still explains the refusal; only the discovery invitation is gone.
    expect(await out.json()).toEqual({ error: "invalid_token" });
    expect(out.headers.get("Content-Type")).toBe("application/json");
  });

  it("strips it from a 403 too", () => {
    expect(stripOAuthHints(withHint(403)).headers.get("WWW-Authenticate")).toBe(
      'Bearer realm="cortex"'
    );
  });

  it("returns success responses untouched, by identity", () => {
    // Identity, not equality: a wrapper that rebuilt every 200 would be re-streaming the whole
    // corpus through an extra Response for no reason.
    const res = new Response("ok", { status: 200 });
    expect(stripOAuthHints(res)).toBe(res);
  });

  it("returns a 401 with no OAuth hint untouched, by identity", () => {
    const res = new Response("nope", {
      status: 401,
      headers: { "WWW-Authenticate": 'Bearer realm="cortex"' },
    });
    expect(stripOAuthHints(res)).toBe(res);
  });

  it("leaves a 401 with no WWW-Authenticate header at all alone", () => {
    const res = new Response("nope", { status: 401 });
    expect(stripOAuthHints(res)).toBe(res);
  });

  it("never turns a refusal into an acceptance", () => {
    // The one thing this function must never do, stated as a test rather than a comment.
    for (const status of [401, 403]) {
      expect(stripOAuthHints(withHint(status)).status).toBe(status);
    }
    expect(stripOAuthHints(new Response("", { status: 500 })).status).toBe(500);
  });
});

/**
 * The behavioural half, and the reason it exists: this change puts a response-rewriting wrapper
 * IN FRONT of the auth gate, and the structural guard in hard-surface.test.ts can only see that
 * withMcpAuth is still called somewhere in the file — not that the exported handler still routes
 * through it. Every other route test mocks lib/handler wholesale, so nothing was proving the
 * real thing still refuses. Both doors are exercised against the real handler, unmocked.
 */
describe("both doors still refuse an unauthenticated request", () => {
  beforeEach(() => {
    vi.stubEnv("MCP_TOKEN", "a-real-configured-token");
  });

  const call = (h: typeof handler) =>
    h(
      new Request("https://cortex.test/api/mcp", {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
      })
    );

  it("401s with no Authorization header", async () => {
    expect((await call(handler)).status).toBe(401);
    expect((await call(guestHandler)).status).toBe(401);
  });

  it("401s on a wrong bearer, and advertises no OAuth discovery when it does", async () => {
    const res = await handler(
      new Request("https://cortex.test/api/mcp", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          authorization: "Bearer not-the-configured-token",
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
      })
    );
    expect(res.status).toBe(401);
    // The whole point of the port: a refused request must not send the client hunting for an
    // authorization server that does not exist.
    expect(res.headers.get("WWW-Authenticate") ?? "").not.toContain("resource_metadata");
  });
});
