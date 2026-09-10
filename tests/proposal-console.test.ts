import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { stampValue, STAMP_COOKIE } from "../lib/stamp";
import { ProposalOutcomeUncertain } from "../lib/proposal-git";

const accept = vi.hoisted(() => vi.fn());
const cancel = vi.hoisted(() => vi.fn());
vi.mock("../lib/proposals", () => ({ acceptProposal: accept, cancelProposal: cancel, dropProposal: vi.fn() }));
import { POST } from "../app/s/[secret]/console/proposals/route";

beforeEach(() => { vi.stubEnv("CONNECTOR_PATH_SECRET", "test-secret"); vi.stubEnv("CONSOLE_PASSCODE", "synthetic-passcode"); accept.mockReset(); cancel.mockReset(); });
afterEach(() => vi.unstubAllEnvs());
function request(secret = "test-secret", stamped = true, action = "accept") {
  return new Request(`https://test.invalid/s/${secret}/console/proposals`, { method: "POST", headers: {
    "content-type": "application/json", origin: "https://test.invalid",
    ...(stamped ? { cookie: `${STAMP_COOKIE}=${stampValue()}` } : {}),
  }, body: JSON.stringify({ id: "abc", action }) });
}
it("authenticates cancellation and preserves the terminal outcome plus cleanup warning", async () => {
  cancel.mockResolvedValue({ outcome: "canceled", path: "notes/idea.md", commitSha: "cancel123", cleanupWarning: "queue unavailable" });
  const res = await POST(request("test-secret", true, "cancel"), { params: Promise.resolve({ secret: "test-secret" }) });
  expect(res.status).toBe(200);
  expect(await res.json()).toMatchObject({ outcome: "canceled", commitSha: "cancel123", cleanupWarning: "queue unavailable" });
  expect(res.headers.get("cache-control")).toContain("no-store");
  for (const [secret, stamped] of [["wrong", true], ["test-secret", false]] as const) {
    cancel.mockClear();
    const denied = await POST(request(secret, stamped, "cancel"), { params: Promise.resolve({ secret }) });
    expect(denied.status).toBe(404); expect(cancel).not.toHaveBeenCalled();
  }
});
it("preserves committed state, original SHA and both follow-up warnings", async () => {
  accept.mockResolvedValue({ outcome: "committed", path: "notes/idea.md", commitSha: "abc123", indexWarning: "index unavailable", cleanupWarning: "queue unavailable" });
  const res = await POST(request(), { params: Promise.resolve({ secret: "test-secret" }) });
  expect(res.status).toBe(200);
  expect(await res.json()).toMatchObject({ outcome: "committed", commitSha: "abc123", indexWarning: "index unavailable", cleanupWarning: "queue unavailable" });
  expect(res.headers.get("cache-control")).toContain("no-store");
});
it("reports uncertain outcomes explicitly, without implying rollback", async () => {
  accept.mockRejectedValue(new ProposalOutcomeUncertain("receipt unavailable"));
  const res = await POST(request(), { params: Promise.resolve({ secret: "test-secret" }) });
  expect(res.status).toBe(503);
  expect(await res.json()).toMatchObject({ outcome: "uncertain", error: expect.stringContaining("same proposal id") });
});
it.each([["wrong", true], ["test-secret", false]])("keeps secret/device auth before the write", async (secret, stamped) => {
  const res = await POST(request(String(secret), Boolean(stamped)), { params: Promise.resolve({ secret: String(secret) }) });
  expect(res.status).toBe(404); expect(accept).not.toHaveBeenCalled();
});
