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

// The learning family: store plumbing mocked, validation REAL — applyLearningPatch is the
// bounds gate these tests exercise, so replacing it would test the mock.
const learning = vi.hoisted(() => ({
  readLearning: vi.fn(),
  writeLearning: vi.fn(),
}));
vi.mock("../lib/learning", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/learning")>()),
  readLearning: learning.readLearning,
  writeLearning: learning.writeLearning,
}));

const guest = vi.hoisted(() => ({
  readGuestPolicy: vi.fn(),
  writeGuestPolicy: vi.fn(),
}));
vi.mock("../lib/guest", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/guest")>()),
  readGuestPolicy: guest.readGuestPolicy,
  writeGuestPolicy: guest.writeGuestPolicy,
}));

import * as saveRoute from "../app/s/[secret]/console/settings/save/route";
import { STAMP_COOKIE, stampValue } from "../lib/stamp";

const SECRET = "a".repeat(64);
const REVISION = "b".repeat(40);

function call(
  body: unknown,
  {
    secret = SECRET,
    origin = "https://cortex.test",
    cookie = "stamped",
  }: { secret?: string; origin?: string | null; cookie?: "stamped" | "none" | string } = {}
) {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (origin) headers.origin = origin;
  // Console writes come from a screen only a stamped device can load, so the default request
  // here carries the device stamp; a test drops or forges it to hold the deny line.
  if (cookie === "stamped") headers.cookie = `${STAMP_COOKIE}=${stampValue()}`;
  else if (cookie !== "none") headers.cookie = cookie;
  const req = new Request(`https://cortex.test/s/${secret}/console/settings`, {
    method: "POST",
    headers,
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
  return saveRoute.POST(req, { params: Promise.resolve({ secret }) });
}

function read(
  family: string,
  { secret = SECRET, cookie = "stamped" }: { secret?: string; cookie?: "stamped" | "none" } = {},
) {
  const headers: Record<string, string> = {};
  if (cookie === "stamped") headers.cookie = `${STAMP_COOKIE}=${stampValue()}`;
  const req = new Request(
    `https://cortex.test/s/${secret}/console/settings/save?family=${encodeURIComponent(family)}`,
    { headers },
  );
  return saveRoute.GET(req, { params: Promise.resolve({ secret }) });
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv("CONNECTOR_PATH_SECRET", SECRET);
  vi.stubEnv("CONSOLE_PASSCODE", "settings-suite passcode");
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
  learning.readLearning.mockResolvedValue({
    selection: { coaccessFloor: 6 },
    source: "store",
    conflicts: [],
  });
  learning.writeLearning.mockResolvedValue(undefined);
  guest.readGuestPolicy.mockResolvedValue({
    scope: ["projects/", "notes/private.md"],
    citations: false,
    dailyAsks: 50,
    maxK: 8,
    source: "store",
    usedToday: 0,
    revision: REVISION,
  });
  guest.writeGuestPolicy.mockImplementation(async (next) => ({...next,revision:"c".repeat(40)}));
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

  it("404s a stampless write — the leaked link alone reaches no console button", async () => {
    const res = await call({ defaultReader: "claude-opus-5" }, { cookie: "none" });
    expect(res.status).toBe(404);
    expect(await res.text()).toBe("");
    expect(settings.writeSettings).not.toHaveBeenCalled();
  });

  it("404s the pre-passcode cookie — a stamp that merely repeats the secret is not one", async () => {
    const res = await call(
      { defaultReader: "claude-opus-5" },
      { cookie: `${STAMP_COOKIE}=${SECRET}` }
    );
    expect(res.status).toBe(404);
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
    expect(await res.json()).toMatchObject({ error: "not an allowed reader model" });
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

  it("preserves the allowlisted local contradiction without asking the store to write", async () => {
    settings.readSettings.mockResolvedValue({
      defaultReader: "gemini-3.6-flash",
      disabledProviders: [],
      source: "store",
      conflicts: [],
    });
    const res = await call({ disabledProviders: ["google"] });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/change the default first/);
    expect(settings.writeSettings).not.toHaveBeenCalled();
  });

  it("maps an upstream reader-store failure to a fixed safe response", async () => {
    settings.writeSettings.mockRejectedValue(
      new Error("UPSTREAM_SECRET_SENTINEL command=[SET, cortex:settings, private-payload]")
    );
    const res = await call({ defaultReader: "claude-opus-5" });
    const text = await res.text();
    expect(res.status).toBe(503);
    expect(text).toMatch(/reader settings store did not confirm/i);
    expect(text).not.toContain("UPSTREAM_SECRET_SENTINEL");
    expect(text).not.toContain("private-payload");
  });

  it("dedupes a provider list rather than storing it twice", async () => {
    await call({ disabledProviders: ["google", "google", "openai"] });
    expect(settings.writeSettings).toHaveBeenCalledWith(
      expect.objectContaining({ disabledProviders: ["google", "openai"] })
    );
  });

  it("refuses a reader read-modify-write when the current settings are unreachable", async () => {
    settings.readSettings.mockResolvedValue({
      defaultReader: null,
      disabledProviders: [],
      source: "unreachable",
      conflicts: [],
    });
    const res = await call({ defaultReader: "claude-opus-5" });
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ error: expect.stringContaining("not saved") });
    expect(settings.writeSettings).not.toHaveBeenCalled();
  });

  it.each([
    { defaultReader: "claude-opus-5", learning: { ansCache: false } },
    { learning: { ansCache: false }, guest: { citations: true } },
    { disabledProviders: ["google"], guest: { citations: true } },
  ])("rejects a request that mixes settings families instead of silently choosing one", async (body) => {
    const res = await call(body);
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: expect.stringContaining("one settings family") });
    expect(settings.readSettings).not.toHaveBeenCalled();
    expect(learning.readLearning).not.toHaveBeenCalled();
    expect(guest.readGuestPolicy).not.toHaveBeenCalled();
    expect(settings.writeSettings).not.toHaveBeenCalled();
    expect(learning.writeLearning).not.toHaveBeenCalled();
    expect(guest.writeGuestPolicy).not.toHaveBeenCalled();
  });
});

describe("the learning patch", () => {
  it("folds the one knob sent into the current selection — a stale tab cannot revert the rest", async () => {
    const res = await call({ learning: { ansCache: false } });
    expect(res.status).toBe(200);
    expect(learning.writeLearning).toHaveBeenCalledWith({ coaccessFloor: 6, ansCache: false });
    // A learning patch must never touch the reader settings family.
    expect(settings.writeSettings).not.toHaveBeenCalled();
    expect(settings.readSettings).not.toHaveBeenCalled();
  });

  it("null hands a knob back to env-and-code defaults", async () => {
    const res = await call({ learning: { coaccessFloor: null } });
    expect(res.status).toBe(200);
    expect(learning.writeLearning).toHaveBeenCalledWith({});
  });

  it("refuses an unknown knob and an out-of-bounds value before the store", async () => {
    expect((await call({ learning: { ansCasche: true } })).status).toBe(400);
    expect((await call({ learning: { coaccessFloor: 1 } })).status).toBe(400);
    expect((await call({ learning: { ansCacheTtlDays: 31 } })).status).toBe(400);
    expect((await call({ learning: { handoffBudget: "big" } })).status).toBe(400);
    expect((await call({ learning: [1] })).status).toBe(400);
    expect(learning.writeLearning).not.toHaveBeenCalled();
  });

  it("refuses to merge onto a fallback — an unreadable store must not be overwritten with defaults", async () => {
    learning.readLearning.mockResolvedValue({ selection: {}, source: "unreachable", conflicts: [] });
    const res = await call({ learning: { ansCache: false } });
    expect(res.status).toBe(503);
    expect((await res.json()).error).toMatch(/not saved/);
    expect(learning.writeLearning).not.toHaveBeenCalled();
  });

  it("maps an upstream learning-store failure to a fixed safe response", async () => {
    learning.writeLearning.mockRejectedValue(new Error("UPSTREAM_SECRET_SENTINEL learning-command"));
    const res = await call({ learning: { ansCache: false } });
    const text = await res.text();
    expect(res.status).toBe(503);
    expect(text).toMatch(/learning settings store did not confirm/i);
    expect(text).not.toContain("UPSTREAM_SECRET_SENTINEL");
  });
});

describe("the guest patch", () => {
  it("returns the authoritative conflict without writing another settings family", async () => {
    const {GuestPolicyConflict}=await import("../lib/guest");
    const current={scope:["notes/private.md"],citations:false,dailyAsks:50,maxK:8,revision:"c".repeat(40)};
    guest.writeGuestPolicy.mockRejectedValue(new GuestPolicyConflict(current));
    const res=await call({guest:{scope:["projects/"],expectedRevision:REVISION}});
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({code:"conflict",family:"guest",current});
    expect(settings.writeSettings).not.toHaveBeenCalled();
    expect(learning.writeLearning).not.toHaveBeenCalled();
  });

  it("removes one exact-note grant without erasing its folder or another exact grant", async () => {
    guest.readGuestPolicy.mockResolvedValue({
      scope: ["projects/", "projects/one.md", "notes/two.md"],
      citations: false,
      dailyAsks: 50,
      maxK: 8,
      source: "store",
      usedToday: 0,
    });
    const res = await call({ guest: { scope: ["projects/", "notes/two.md"], expectedRevision: REVISION } });
    expect(res.status).toBe(200);
    expect(guest.writeGuestPolicy).toHaveBeenCalledWith({
      scope: ["projects/", "notes/two.md"],
      citations: false,
      dailyAsks: 50,
      maxK: 8,
    }, REVISION);
    expect(settings.readSettings).not.toHaveBeenCalled();
  });

  it("rejects an empty guest scope before asking the store to write", async () => {
    const res = await call({ guest: { scope: [] } });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/at least one allowed path/i);
    expect(guest.writeGuestPolicy).not.toHaveBeenCalled();
  });

  it("maps an upstream guest-store failure to a fixed safe response", async () => {
    guest.writeGuestPolicy.mockRejectedValue(new Error("UPSTREAM_SECRET_SENTINEL guest-command"));
    const res = await call({ guest: { citations: true, expectedRevision: REVISION } });
    const text = await res.text();
    expect(res.status).toBe(503);
    expect(text).toMatch(/guest policy store did not confirm/i);
    expect(text).not.toContain("UPSTREAM_SECRET_SENTINEL");
  });
});

describe("fresh Settings reconciliation reads", () => {
  it("gates independently before reading and returns no body for a bad secret", async () => {
    expect(saveRoute.GET).toBeTypeOf("function");
    const res = await read("reader", { secret: "b".repeat(64) });
    expect(res.status).toBe(404);
    expect(await res.text()).toBe("");
    expect(settings.readSettings).not.toHaveBeenCalled();
  });

  it.each([
    ["reader", "reader"],
    ["learning", "learning"],
    ["guest", "guest"],
  ] as const)("returns a minimal no-store %s snapshot for receipt reconciliation", async (family, expected) => {
    expect(saveRoute.GET).toBeTypeOf("function");
    const res = await read(family);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toContain("no-store");
    expect(await res.json()).toMatchObject({ family: expected, current: expect.any(Object) });
  });

  it("does not turn an unreadable family fallback into an authoritative snapshot", async () => {
    guest.readGuestPolicy.mockResolvedValue({
      scope: ["projects/"], citations: false, dailyAsks: 50, maxK: 8,
      source: "unreachable", usedToday: null,
    });
    const res = await read("guest");
    const text = await res.text();
    expect(res.status).toBe(503);
    expect(res.headers.get("cache-control")).toContain("no-store");
    expect(text).not.toContain("projects/");
  });
});
