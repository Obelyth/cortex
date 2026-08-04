import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The console's only write endpoint. It is reachable by anyone who has the secret URL, which is
 * exactly why it is a route handler rather than a server action — an action's id ships in a
 * public /_next/static chunk, and an action that mutated settings without re-proving the secret
 * would be a control anyone who fetched the bundle could reach. These tests hold that line.
 */

const settings = vi.hoisted(() => ({
  readSettings: vi.fn(),
  writeSettings: vi.fn(),
}));
vi.mock("../lib/settings", () => settings);

import { POST } from "../app/s/[secret]/console/settings/save/route";

const SECRET = "a".repeat(64);

function call(
  body: unknown,
  { secret = SECRET, origin = "https://cortex.test" }: { secret?: string; origin?: string | null } = {}
) {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (origin) headers.origin = origin;
  const req = new Request(`https://cortex.test/s/${secret}/console/settings`, {
    method: "POST",
    headers,
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
  return POST(req, { params: Promise.resolve({ secret }) });
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv("CONNECTOR_PATH_SECRET", SECRET);
  settings.readSettings.mockResolvedValue({
    defaultReader: "claude-sonnet-5",
    disabledProviders: [],
    source: "store",
    conflicts: [],
  });
  settings.writeSettings.mockImplementation(async (next: unknown) => ({
    ...(next as object),
    source: "store",
    conflicts: [],
  }));
});

describe("settings write endpoint", () => {
  it("404s on a wrong secret without writing anything", async () => {
    const res = await call({ defaultReader: "claude-opus-5" }, { secret: "b".repeat(64) });
    expect(res.status).toBe(404);
    expect(settings.writeSettings).not.toHaveBeenCalled();
  });

  it("404s when no secret is configured at all", async () => {
    vi.stubEnv("CONNECTOR_PATH_SECRET", "");
    expect((await call({ defaultReader: "claude-opus-5" })).status).toBe(404);
    expect(settings.writeSettings).not.toHaveBeenCalled();
  });

  it("refuses a cross-origin write", async () => {
    const res = await call({ defaultReader: "claude-opus-5" }, { origin: "https://evil.test" });
    expect(res.status).toBe(403);
    expect(settings.writeSettings).not.toHaveBeenCalled();
  });

  it("patches only the field it was sent, leaving the other alone", async () => {
    settings.readSettings.mockResolvedValue({
      defaultReader: "claude-sonnet-5",
      disabledProviders: ["google"],
      source: "store",
      conflicts: [],
    });
    const res = await call({ defaultReader: "claude-opus-5" });
    expect(res.status).toBe(200);
    // A stale tab that only knows about the default must not silently revert a provider switch
    // it never showed.
    expect(settings.writeSettings).toHaveBeenCalledWith({
      defaultReader: "claude-opus-5",
      disabledProviders: ["google"],
    });
  });

  it("accepts null to hand the choice back to the environment", async () => {
    await call({ defaultReader: null });
    expect(settings.writeSettings).toHaveBeenCalledWith({
      defaultReader: null,
      disabledProviders: [],
    });
  });

  it("rejects a model off the allowlist before it reaches the store", async () => {
    const res = await call({ defaultReader: "gpt-4" });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: expect.stringContaining("gpt-4") });
    expect(settings.writeSettings).not.toHaveBeenCalled();
  });

  it("rejects an unknown provider and a non-array provider list", async () => {
    expect((await call({ disabledProviders: ["mistral"] })).status).toBe(400);
    expect((await call({ disabledProviders: "google" })).status).toBe(400);
    expect(settings.writeSettings).not.toHaveBeenCalled();
  });

  it("rejects a body that is not a JSON object", async () => {
    expect((await call("not json")).status).toBe(400);
    expect((await call(["google"])).status).toBe(400);
  });

  it("passes a refusal from the settings layer through as a sentence", async () => {
    settings.writeSettings.mockRejectedValue(
      new Error("gemini-3.6-flash cannot be the default while google is off — change the default first")
    );
    const res = await call({ disabledProviders: ["google"] });
    expect(res.status).toBe(409);
    expect((await res.json()).error).toMatch(/change the default first/);
  });

  it("dedupes a provider list rather than storing it twice", async () => {
    await call({ disabledProviders: ["google", "google", "openai"] });
    expect(settings.writeSettings).toHaveBeenCalledWith(
      expect.objectContaining({ disabledProviders: ["google", "openai"] })
    );
  });
});
