import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The guest door is the one place in this system where a party the operator does not control touches
 * his brain. Everything here is a boundary test: what it may reach, what it may not, and what
 * happens when the two secrets are confused for each other.
 */

vi.mock("../lib/handler", () => ({
  handler: vi.fn(),
  guestHandler: vi.fn(),
}));

import { handler, guestHandler } from "../lib/handler";
import { GET as guestGet, POST as guestPost } from "../app/api/g/[secret]/[transport]/route";
import { POST as trustedPost } from "../app/api/s/[secret]/[transport]/route";

const mGuest = vi.mocked(guestHandler);
const mTrusted = vi.mocked(handler);
const GUEST = "g".repeat(64);
const TRUSTED = "c".repeat(64);

function call(secret: string, transport = "mcp") {
  const req = new Request(`https://cortex.test/api/g/${secret}/${transport}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", method: "tools/list", id: 1 }),
  });
  return guestPost(req, { params: Promise.resolve({ secret, transport }) });
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv("GUEST_PATH_SECRET", GUEST);
  vi.stubEnv("CONNECTOR_PATH_SECRET", TRUSTED);
  vi.stubEnv("MCP_TOKEN", "real-bearer-token");
  mGuest.mockResolvedValue(new Response("ok", { status: 200 }));
  mTrusted.mockResolvedValue(new Response("ok", { status: 200 }));
});

describe("guest door routing", () => {
  it("lands on the guest handler, never the trusted one", async () => {
    const res = await call(GUEST);
    expect(res.status).toBe(200);
    expect(mGuest).toHaveBeenCalledOnce();
    expect(mTrusted).not.toHaveBeenCalled();
    const synthetic = mGuest.mock.calls[0][0] as Request;
    expect(new URL(synthetic.url).pathname).toBe("/api/mcp");
    expect(synthetic.headers.get("authorization")).toBe("Bearer real-bearer-token");
  });

  it("404s on the wrong secret, a missing secret, and a non-mcp transport", async () => {
    expect((await call("x".repeat(64))).status).toBe(404);
    expect((await call(GUEST, "sse")).status).toBe(404);
    vi.stubEnv("GUEST_PATH_SECRET", "");
    expect((await call(GUEST)).status).toBe(404);
    expect(mGuest).not.toHaveBeenCalled();
  });

  it("does NOT accept the trusted connector secret", async () => {
    // The guest path must not be a second way in for the trusted credential, and more
    // importantly the trusted path must never serve the reduced toolset by accident.
    expect((await call(TRUSTED)).status).toBe(404);
    expect(mGuest).not.toHaveBeenCalled();
  });

  it("refuses to serve at all when the two secrets are configured the same", async () => {
    // A shared secret means revoking the guest revokes the operator. That is a misconfiguration to
    // fail on, not a shortcut to honour.
    vi.stubEnv("GUEST_PATH_SECRET", TRUSTED);
    expect((await call(TRUSTED)).status).toBe(404);
    expect(mGuest).not.toHaveBeenCalled();
  });

  it("405s HEAD instead of pinning the function for 60s", async () => {
    const req = new Request(`https://cortex.test/api/g/${GUEST}/mcp`, { method: "HEAD" });
    const res = await guestGet(req, { params: Promise.resolve({ secret: GUEST, transport: "mcp" }) });
    expect(res.status).toBe(405);
    expect(mGuest).not.toHaveBeenCalled();
  });

  it("leaves the trusted door reaching the trusted handler", async () => {
    // The guest door must be additive. Nothing about the operator's own access changes.
    const req = new Request(`https://cortex.test/api/s/${TRUSTED}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", method: "tools/list", id: 1 }),
    });
    await trustedPost(req, { params: Promise.resolve({ secret: TRUSTED, transport: "mcp" }) });
    expect(mTrusted).toHaveBeenCalledOnce();
    expect(mGuest).not.toHaveBeenCalled();
  });
});

describe("the two toolsets", () => {
  /** Register against a stub server and collect the tool names it was handed. */
  async function toolsFor(guest: boolean): Promise<string[]> {
    const { registerTools } = await import("../lib/tools");
    const names: string[] = [];
    const server = { registerTool: (name: string) => void names.push(name) };
    registerTools(server as never, { guest });
    return names.sort();
  }

  it("gives a guest the mediated ask and the proposal, and nothing else at all", async () => {
    // Shared context ON ASK, not openly shared. Two tools, both mediated: one asks a question
    // The operator's reader answers, one leaves something for the operator to accept.
    expect(await toolsFor(true)).toEqual(["brain_ask", "brain_propose"]);
  });

  it("never hands a guest the corpus in bulk", async () => {
    // The load-bearing one, and the one an earlier version of this file got backwards. Each of
    // these returns private note text directly, and brain_corpus returns the ENTIRE brain in a
    // single call — the most exposure this server can produce, disguised as a cheap tool
    // because it calls no model. brain_handoff belongs on this list: a bundle is the most
    // current, least filtered view of what the operator is doing on a project.
    const t = await toolsFor(true);
    for (const bulk of ["brain_corpus", "brain_read", "brain_context", "brain_handoff"]) {
      expect(t, `guest must not see ${bulk}`).not.toContain(bulk);
    }
    // And every one of them is still there for the operator's own doors.
    const trusted = await toolsFor(false);
    for (const bulk of ["brain_corpus", "brain_read", "brain_context", "brain_handoff"]) {
      expect(trusted).toContain(bulk);
    }
  });

  it("keeps every write and review tool off the guest door", async () => {
    const t = await toolsFor(true);
    for (const forbidden of ["brain_write", "brain_capture", "brain_accept", "brain_reject", "brain_proposals"]) {
      expect(t, `guest must not see ${forbidden}`).not.toContain(forbidden);
    }
  });

  it("gives the trusted door the review tools a guest can never reach", async () => {
    const t = await toolsFor(false);
    for (const name of ["brain_write", "brain_capture", "brain_proposals", "brain_accept", "brain_reject"]) {
      expect(t).toContain(name);
    }
    expect(t).not.toContain("brain_propose");
  });

  it("gives both doors a tool called brain_ask, but not the same one", async () => {
    // Same name so a guest client needs no special casing; different registration, because the
    // guest one is scoped, metered, capped and citation-free.
    expect(await toolsFor(true)).toContain("brain_ask");
    expect(await toolsFor(false)).toContain("brain_ask");
  });

  it("does not merely refuse the write tools to a guest — it never lists them", async () => {
    // A tool that appears and then errors teaches a foreign model to keep trying, and tells it
    // exactly what exists to be attacked.
    const guest = await toolsFor(true);
    const trusted = await toolsFor(false);
    expect(guest.length).toBeLessThan(trusted.length);
  });
});
