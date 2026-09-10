import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  __setConsoleConfigurationStore,
  consoleConfigurationStore,
  ConfigurationStoreError,
} from "../lib/console-configuration-store";
import { newConfigurationRequestKey } from "../lib/console-configuration-contract";

const requestKey = newConfigurationRequestKey();
const target = "vercel:prj_fixture:personal:production";
const record = {
  capability: "reader-openai",
  target,
  revision: 0,
  status: "running",
  request_key: requestKey,
  result: null,
  acknowledged: false,
  updated_at: "2026-09-08T23:00:00.000Z",
};

beforeEach(() => {
  __setConsoleConfigurationStore(undefined);
  vi.stubEnv("SUPABASE_URL", "https://store.synthetic.invalid");
  vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "synthetic-service-role");
});
afterEach(() => { __setConsoleConfigurationStore(undefined); vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

describe("configuration PostgREST adapter", () => {
  it("calls the exact admission RPC with value-free immutable identity fields", async () => {
    const seen: Array<{ url: string; body: unknown }> = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      seen.push({ url, body: JSON.parse(String(init?.body)) });
      return Response.json({ outcome: "admitted", record, claimToken: "11111111-1111-4111-8111-111111111111" });
    }));
    const result = await consoleConfigurationStore()!.admit({ requestKey, fingerprint: "a".repeat(64), capability: "reader-openai", target, expectedRevision: 0 });
    expect(result.outcome).toBe("admitted");
    expect(seen).toEqual([{
      url: "https://store.synthetic.invalid/rest/v1/rpc/console_configuration_admit",
      body: { request_key: requestKey, input_fingerprint: "a".repeat(64), capability_name: "reader-openai", target_name: target, expected_revision: 0 },
    }]);
    expect(JSON.stringify(seen)).not.toContain("OPENAI_API_KEY");
  });

  it("keeps mutation transport loss uncertain and maps a missing RPC to one-time schema setup", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("private upstream transport"); }));
    await expect(consoleConfigurationStore()!.admit({ requestKey, fingerprint: "a".repeat(64), capability: "reader-openai", target, expectedRevision: 0 })).rejects.toEqual(new ConfigurationStoreError("uncertain"));
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ code: "PGRST202", message: "raw private database message" }, { status: 404 })));
    await expect(consoleConfigurationStore()!.list()).rejects.toEqual(new ConfigurationStoreError("schema_required"));
  });

  it("rejects malformed, secret-bearing, or oversized ledger responses", async () => {
    for (const response of [
      () => Response.json([{ ...record, value: "PROVIDER_SECRET_SENTINEL" }]),
      () => new Response(JSON.stringify({ padding: "x".repeat(129 * 1024) }), { headers: { "content-type": "application/json" } }),
    ]) {
      vi.stubGlobal("fetch", vi.fn(async () => response()));
      await expect(consoleConfigurationStore()!.list()).rejects.toEqual(new ConfigurationStoreError("malformed"));
    }
  });

  it("treats a malformed mutation response as uncertain because the database may have committed", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ outcome: "admitted", record: { ...record, value: "secret" }, claimToken: "11111111-1111-4111-8111-111111111111" })));
    await expect(consoleConfigurationStore()!.admit({ requestKey, fingerprint: "a".repeat(64), capability: "reader-openai", target, expectedRevision: 0 })).rejects.toEqual(new ConfigurationStoreError("uncertain"));
  });

  it.each([
    ["running", false],
    ["uncertain", false],
  ] as const)("rejects a contradictory %s acknowledgment receipt", async (status, acknowledged) => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ outcome: "acknowledged", record: { ...record, status, acknowledged } })));
    await expect(consoleConfigurationStore()!.acknowledge({ capability: "reader-openai", target, requestKey })).rejects.toEqual(new ConfigurationStoreError("uncertain"));
  });
});
