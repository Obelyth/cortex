import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { STAMP_COOKIE, stampValue } from "../lib/stamp";
import { __setConsoleConfigurationStore, ConfigurationStoreError, type ConfigurationStore } from "../lib/console-configuration-store";
import { GET, POST } from "../app/s/[secret]/console/settings/configuration/route";
import { newConfigurationRequestKey } from "../lib/console-configuration-contract";

const secretPath = "s".repeat(64);
const requestKey = newConfigurationRequestKey();
const fullTarget = "vercel:prj_fixture:personal:production";
const baseRecord = {
  capability: "reader-openai" as const,
  target: fullTarget,
  revision: 0,
  status: "running" as const,
  requestKey,
  result: null,
  acknowledged: false,
  updatedAt: "2026-09-08T23:00:00.000Z",
};
let providerPosts: number;
let deployments: number;

function store(): ConfigurationStore {
  let record = { ...baseRecord };
  return {
    admit: async () => ({ outcome: "admitted", record, claimToken: randomUUID() }),
    publish: async (input) => {
      record = { ...record, status: input.result.state === "uncertain" ? "uncertain" : "finished", revision: input.result.state === "uncertain" ? 0 : 1, result: input.result } as never;
      return { outcome: "published", record };
    },
    list: async (filter) => !filter?.target || filter.target === record.target ? [record] : [],
    getRequest: async () => record,
    acknowledge: async () => ({ outcome: "acknowledged", record: { ...record, status: "uncertain", revision: record.revision + 1, acknowledged: true } }),
  };
}

function call(method: "GET" | "POST", body?: unknown, options: { https?: boolean; origin?: string; stamp?: boolean; secret?: string } = {}) {
  const protocol = options.https === false ? "http" : "https";
  const selectedSecret = options.secret ?? secretPath;
  return new Request(`${protocol}://console.invalid/s/${selectedSecret}/console/settings/configuration`, {
    method,
    headers: {
      ...(method === "POST" ? { origin: options.origin ?? `${protocol}://console.invalid`, "content-type": "application/json" } : {}),
      ...(options.stamp === false ? {} : { cookie: `${STAMP_COOKIE}=${stampValue()}` }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}
const ctx = { params: Promise.resolve({ secret: secretPath }) };

beforeEach(() => {
  providerPosts = 0;
  deployments = 0;
  __setConsoleConfigurationStore(store());
  vi.stubEnv("CONNECTOR_PATH_SECRET", secretPath);
  vi.stubEnv("CONSOLE_PASSCODE", "synthetic-passcode");
  vi.stubEnv("CORTEX_VERCEL_TOKEN", "synthetic-management-token");
  vi.stubEnv("CORTEX_VERCEL_PROJECT_ID", "prj_fixture");
  vi.stubEnv("CORTEX_VERCEL_TEAM_ID", "");
  vi.stubEnv("VERCEL", "1");
  vi.stubEnv("VERCEL_ENV", "preview");
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    if (url.includes("/deployments")) deployments++;
    if (url.includes("/env?")) providerPosts++;
    return Response.json({ created: [{ key: "OPENAI_API_KEY", value: "UPSTREAM_SECRET_SENTINEL" }], failed: [] }, { status: 201 });
  }));
});
afterEach(() => { __setConsoleConfigurationStore(undefined); vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.useRealTimers(); });

describe("guarded capability configuration route", () => {
  it("saves a complete group through HTTPS and returns only a minimal pending-deployment receipt", async () => {
    const response = await POST(call("POST", {
      action: "save",
      capability: "reader-openai",
      target: "production",
      expectedRevision: 0,
      requestKey,
      values: { OPENAI_API_KEY: "browser-secret-sentinel" },
    }), ctx);
    const text = await response.text();
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store, max-age=0");
    expect(JSON.parse(text)).toMatchObject({ record: { capability: "reader-openai", revision: 1, result: { state: "saved-pending-deployment" } } });
    expect(text).not.toMatch(/browser-secret-sentinel|UPSTREAM_SECRET_SENTINEL|synthetic-management-token/);
    expect(providerPosts).toBe(1);
    expect(deployments).toBe(0);
  });

  it.each([
    ["wrong secret", {}, 404, { params: Promise.resolve({ secret: "x".repeat(64) }) }],
    ["missing stamp", { stamp: false }, 404, ctx],
    ["cross origin", { origin: "https://other.invalid" }, 403, ctx],
    ["plain HTTP", { https: false }, 400, ctx],
  ])("refuses %s before store/provider mutation", async (_label, options, status, context) => {
    const response = await POST(call("POST", { action: "save", capability: "reader-openai", target: "production", expectedRevision: 0, requestKey, values: { OPENAI_API_KEY: "browser-secret" } }, options), context);
    expect(response.status).toBe(status);
    expect(providerPosts).toBe(0);
  });

  it("requires the supported Vercel ingress flags for secret entry and ignores a spoofed forwarding header", async () => {
    vi.stubEnv("VERCEL", "");
    vi.stubEnv("VERCEL_ENV", "");
    const request = call("POST", { action: "save", capability: "reader-openai", target: "production", expectedRevision: 0, requestKey, values: { OPENAI_API_KEY: "browser-secret" } });
    request.headers.set("x-forwarded-proto", "https");
    const response = await POST(request, ctx);
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ code: "ingress_required" });
    expect(providerPosts).toBe(0);
  });

  it("refuses unknown or mixed variables without provider access", async () => {
    const response = await POST(call("POST", {
      action: "save", capability: "reader-openai", target: "production", expectedRevision: 0, requestKey,
      values: { OPENAI_API_KEY: "browser-secret", GEMINI_API_KEY: "browser-secret" },
    }), ctx);
    expect(response.status).toBe(400);
    expect(providerPosts).toBe(0);
  });

  it("returns the fixed provider identity and value-free durable status on a fresh no-store read", async () => {
    const response = await GET(call("GET"), ctx);
    const text = await response.text();
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store, max-age=0");
    expect(JSON.parse(text)).toEqual({
      adapter: { configured: true, projectId: "prj_fixture", teamId: null },
      records: [baseRecord],
    });
    expect(text).not.toContain("synthetic-management-token");
  });

  it.each([
    "?capability=reader-openai",
    "?capability=reader-openai&target=staging",
    "?capability=arbitrary&target=production",
    "?target=production&extra=1",
    // A fixed, well-formed v7 rather than the module's fresh one: a title that changes every
    // run cannot be filtered with -t and has no flake history.
    "?requestKey=01920000-0000-7000-8000-000000000000",
    "?capability=reader-openai&target=production&requestKey=not-a-uuidv7",
  ])("rejects an invalid status query without reading the store: %s", async (query) => {
    const selected = store();
    selected.list = vi.fn(selected.list);
    selected.getRequest = vi.fn(selected.getRequest);
    __setConsoleConfigurationStore(selected);
    const request = call("GET");
    const response = await GET(new Request(`${request.url}${query}`, { headers: request.headers }), ctx);
    expect(response.status).toBe(400);
    expect(selected.list).not.toHaveBeenCalled();
    expect(selected.getRequest).not.toHaveBeenCalled();
  });

  it("filters fresh status to the fixed current project and exact requested target", async () => {
    const selected = store();
    selected.list = vi.fn(selected.list);
    __setConsoleConfigurationStore(selected);
    const request = call("GET");
    const response = await GET(new Request(`${request.url}?capability=reader-openai&target=production`, { headers: request.headers }), ctx);
    expect(response.status).toBe(200);
    expect(selected.list).toHaveBeenCalledWith({ capability: "reader-openai", target: fullTarget });
  });

  it("reads one retained request only when its capability and fixed target identity match", async () => {
    const selected = store();
    selected.getRequest = vi.fn(selected.getRequest);
    selected.list = vi.fn(selected.list);
    __setConsoleConfigurationStore(selected);
    const request = call("GET");
    const response = await GET(new Request(`${request.url}?capability=reader-openai&target=production&requestKey=${requestKey}`, { headers: request.headers }), ctx);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ adapter: { configured: true, projectId: "prj_fixture", teamId: null }, records: [baseRecord] });
    expect(selected.getRequest).toHaveBeenCalledWith(requestKey);
    expect(selected.list).not.toHaveBeenCalled();
  });

  it("fails closed when an exact receipt belongs to another immutable identity", async () => {
    const selected = store();
    selected.getRequest = async () => ({ ...baseRecord, capability: "reader-google" });
    __setConsoleConfigurationStore(selected);
    const request = call("GET");
    const response = await GET(new Request(`${request.url}?capability=reader-openai&target=production&requestKey=${requestKey}`, { headers: request.headers }), ctx);
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ code: "unavailable", error: "configuration service unavailable · no provider write was confirmed" });
  });

  it("fails closed when the store returns a valid receipt outside the requested identity", async () => {
    const selected = store();
    selected.list = async () => [{ ...baseRecord, capability: "reader-google" }];
    __setConsoleConfigurationStore(selected);
    const request = call("GET");
    const response = await GET(new Request(`${request.url}?capability=reader-openai&target=production`, { headers: request.headers }), ctx);
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ code: "unavailable", error: "configuration service unavailable · no provider write was confirmed" });
  });

  it("loads only both current-project targets when no status filter is supplied", async () => {
    const selected = store();
    selected.list = vi.fn(selected.list);
    __setConsoleConfigurationStore(selected);
    expect((await GET(call("GET"), ctx)).status).toBe(200);
    expect(selected.list).toHaveBeenCalledTimes(2);
    expect(selected.list).toHaveBeenCalledWith({ target: "vercel:prj_fixture:personal:production" });
    expect(selected.list).toHaveBeenCalledWith({ target: "vercel:prj_fixture:personal:preview" });
  });

  it("names the one-time adapter and schema prerequisites without exposing credentials", async () => {
    vi.stubEnv("CORTEX_VERCEL_TOKEN", "");
    const unavailable = await POST(call("POST", { action: "save", capability: "reader-openai", target: "production", expectedRevision: 0, requestKey, values: { OPENAI_API_KEY: "browser-secret" } }), ctx);
    expect(unavailable.status).toBe(503);
    expect(await unavailable.json()).toMatchObject({ code: "adapter_required", error: expect.stringContaining("CORTEX_VERCEL_TOKEN") });
    const missing = store();
    missing.admit = async () => { throw new ConfigurationStoreError("schema_required"); };
    __setConsoleConfigurationStore(missing);
    vi.stubEnv("CORTEX_VERCEL_TOKEN", "synthetic-management-token");
    const schema = await POST(call("POST", { action: "save", capability: "reader-openai", target: "production", expectedRevision: 0, requestKey, values: { OPENAI_API_KEY: "browser-secret" } }), ctx);
    expect(schema.status).toBe(503);
    expect(await schema.json()).toMatchObject({ code: "schema_required", migration: expect.stringMatching(/console_configuration\.sql$/) });
    expect(providerPosts).toBe(0);
  });

  it("explicitly acknowledges the exact unresolved receipt without claiming cancellation", async () => {
    vi.stubEnv("VERCEL", "");
    vi.stubEnv("VERCEL_ENV", "");
    vi.stubEnv("CORTEX_VERCEL_TOKEN", "");
    const response = await POST(call("POST", { action: "acknowledge-unresolved", capability: "reader-openai", target: "production", requestKey }), ctx);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ acknowledged: true, record: { requestKey, acknowledged: true, status: "uncertain" }, warning: expect.stringMatching(/may still complete/i) });
    expect(providerPosts).toBe(0);
  });

  it("does not confirm an acknowledgment for a different durable receipt", async () => {
    const selected = store();
    selected.acknowledge = async () => ({ outcome: "acknowledged", record: { ...baseRecord, requestKey: newConfigurationRequestKey(), status: "uncertain", acknowledged: true } });
    __setConsoleConfigurationStore(selected);
    const response = await POST(call("POST", { action: "acknowledge-unresolved", capability: "reader-openai", target: "production", requestKey }), ctx);
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: "stale" });
    expect(providerPosts).toBe(0);
  });

  it.each([
    ["running and unacknowledged", { status: "running" as const, acknowledged: false, revision: 1 }],
    ["uncertain but unacknowledged", { status: "uncertain" as const, acknowledged: false, revision: 1 }],
    ["unchanged revision", { status: "uncertain" as const, acknowledged: true, revision: 0 }],
  ])("does not confirm an acknowledgment whose receipt is %s", async (_label, contradiction) => {
    const selected = store();
    selected.acknowledge = async () => ({ outcome: "acknowledged", record: { ...baseRecord, ...contradiction } });
    __setConsoleConfigurationStore(selected);
    const response = await POST(call("POST", { action: "acknowledge-unresolved", capability: "reader-openai", target: "production", requestKey }), ctx);
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: "stale" });
    expect(providerPosts).toBe(0);
  });

  it("bounds the secret-bearing request body before provider access", async () => {
    const response = await POST(call("POST", { action: "save", padding: "x".repeat(66_000) }), ctx);
    expect(response.status).toBe(413);
    expect(providerPosts).toBe(0);
  });

  it("stops waiting for an incomplete request body before any provider access", async () => {
    vi.useFakeTimers();
    const stream = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new TextEncoder().encode('{"action":"save"')); } });
    const request = new Request(`https://console.invalid/s/${secretPath}/console/settings/configuration`, {
      method: "POST",
      headers: { origin: "https://console.invalid", "content-type": "application/json", cookie: `${STAMP_COOKIE}=${stampValue()}` },
      body: stream,
      duplex: "half",
    } as RequestInit & { duplex: "half" });
    const pending = POST(request, ctx);
    await vi.advanceTimersByTimeAsync(8_001);
    const response = await pending;
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: expect.stringContaining("timed out") });
    expect(providerPosts).toBe(0);
  });

  it.each(["expired", "capacity"] as const)("maps the %s admission refusal to fixed safe guidance", async (outcome) => {
    const selected = store();
    selected.admit = async () => ({ outcome });
    __setConsoleConfigurationStore(selected);
    const response = await POST(call("POST", { action: "save", capability: "reader-openai", target: "production", expectedRevision: 0, requestKey, values: { OPENAI_API_KEY: "browser-secret" } }), ctx);
    expect(response.status).toBe(outcome === "expired" ? 409 : 503);
    expect(await response.json()).toMatchObject({ code: outcome });
    expect(providerPosts).toBe(0);
  });
});
