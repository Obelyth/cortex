import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CONFIGURATION_GROUPS,
  configurationOperationalEvidence,
  configurationPresence,
  requestConfiguration,
  type ConfigurationDependencies,
  type ConfigurationRecord,
} from "../lib/console-configuration";
import type {
  ConfigurationAdmission,
  ConfigurationStore,
} from "../lib/console-configuration-store";
import { newConfigurationRequestKey } from "../lib/console-configuration-contract";

const secret = "synthetic-secret-that-must-never-return";
const env = {
  CONNECTOR_PATH_SECRET: "connector-secret",
  CONSOLE_PASSCODE: "console-passcode",
  CORTEX_VERCEL_TOKEN: "synthetic-management-token",
  CORTEX_VERCEL_PROJECT_ID: "prj_fixture",
  CORTEX_VERCEL_TEAM_ID: "team_fixture",
};

function values(capability: keyof typeof CONFIGURATION_GROUPS): Record<string, string> {
  return Object.fromEntries(CONFIGURATION_GROUPS[capability].variables.map((name) => [name, `${secret}-${name}`]));
}

function memoryStore(): ConfigurationStore {
  let record: ConfigurationRecord | null = null;
  let fingerprint = "";
  let claim = "";
  return {
    async admit(input: ConfigurationAdmission) {
      if (record?.requestKey === input.requestKey) {
        return input.fingerprint === fingerprint
          ? { outcome: "replay", record }
          : { outcome: "key_conflict" };
      }
      if (record && ["running", "uncertain"].includes(record.status) && !record.acknowledged) {
        return { outcome: "active" };
      }
      if (input.expectedRevision !== (record?.revision ?? 0)) return { outcome: "stale" };
      fingerprint = input.fingerprint;
      claim = randomUUID();
      record = {
        capability: input.capability,
        target: input.target,
        revision: input.expectedRevision,
        status: "running",
        requestKey: input.requestKey,
        result: null,
        acknowledged: false,
        updatedAt: "2026-09-08T23:00:00.000Z",
      };
      return { outcome: "admitted", record, claimToken: claim };
    },
    async publish(input) {
      if (!record || input.claimToken !== claim || input.requestKey !== record.requestKey) {
        return { outcome: "stale", record: record! };
      }
      record = {
        ...record,
        status: input.result.state === "uncertain" ? "uncertain" : "finished",
        revision: input.result.state === "uncertain" ? record.revision : record.revision + 1,
        result: input.result,
      };
      return { outcome: "published", record };
    },
    async list() { return record ? [record] : []; },
    async getRequest(requestKey) { return record?.requestKey === requestKey ? record : null; },
    async acknowledge() {
      if (!record) return { outcome: "not_unresolved" };
      record = { ...record, status: "uncertain", acknowledged: true };
      return { outcome: "acknowledged", record };
    },
  };
}

function deps(fetcher: ConfigurationDependencies["fetcher"]): ConfigurationDependencies {
  return { env, store: memoryStore(), fetcher };
}

afterEach(() => vi.restoreAllMocks());

describe("capability-specific provider configuration", () => {
  it("reports current-process configuration as presence rather than verified readiness", () => {
    const presence = configurationPresence({
      BRAIN_REPO: "fixture/brain", GITHUB_TOKEN: "", ANTHROPIC_API_KEY: "set",
      SUPABASE_URL: "https://fixture.supabase.co", SUPABASE_SERVICE_ROLE_KEY: "set",
      KV_REST_API_URL: "https://fixture.upstash.io", KV_REST_API_TOKEN: "set",
      RESEND_API_KEY: "set", OPS_ALERT_TO: "ops@example.com", OPS_ALERT_FROM: "",
    });
    expect(presence.notes).toEqual({ configured: false, missing: ["GITHUB_TOKEN"] });
    expect(presence["reader-anthropic"]).toEqual({ configured: true, missing: [] });
    expect(presence.mirror).toEqual({ configured: true, missing: [] });
    expect(presence.cache).toEqual({ configured: true, missing: [] });
    expect(presence.alerts).toEqual({ configured: true, missing: [] });
    expect(JSON.stringify(presence)).not.toContain("fixture.supabase.co");
  });

  it("keeps configured outages and reader-resolution failure distinct from missing variables", () => {
    const presence = configurationPresence(Object.fromEntries(Object.values(CONFIGURATION_GROUPS).flatMap((group) => group.variables).map((name) => [name, "set"])));
    const evidence = configurationOperationalEvidence({
      presence,
      activeProvider: null,
      readerResolutionFailed: true,
      mirrorState: "unavailable",
      cacheEntries: null,
    });
    expect(evidence["reader-openai"]).toMatchObject({ state: "unavailable", detail: expect.stringMatching(/resolution/i) });
    expect(evidence.mirror).toMatchObject({ state: "unavailable" });
    expect(evidence.cache).toMatchObject({ state: "unavailable" });
    expect(evidence.notes).toMatchObject({ state: "unknown" });
    expect(evidence.alerts).toMatchObject({ state: "unknown" });
  });

  it("defines only the complete approved groups with their actual runtime variable names", () => {
    expect(Object.fromEntries(Object.entries(CONFIGURATION_GROUPS).map(([id, group]) => [id, group.variables]))).toEqual({
      notes: ["BRAIN_REPO", "GITHUB_TOKEN"],
      "reader-anthropic": ["ANTHROPIC_API_KEY"],
      "reader-openai": ["OPENAI_API_KEY"],
      "reader-google": ["GEMINI_API_KEY"],
      mirror: ["SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY"],
      cache: ["KV_REST_API_URL", "KV_REST_API_TOKEN"],
      alerts: ["RESEND_API_KEY", "OPS_ALERT_TO", "OPS_ALERT_FROM"],
    });
    const names = Object.values(CONFIGURATION_GROUPS).flatMap((group) => group.variables);
    for (const excluded of ["CONNECTOR_PATH_SECRET", "CONSOLE_PASSCODE", "MCP_TOKEN", "CORTEX_VERCEL_TOKEN", "CORTEX_ACTIONS_TOKEN", "SUPABASE_DB_URL"]) {
      expect(names).not.toContain(excluded);
    }
  });

  it("writes one complete group to the fixed project as sensitive values without deploying", async () => {
    const posts: Array<{ url: string; init?: RequestInit }> = [];
    const fetcher = vi.fn(async (url: string, init?: RequestInit) => {
      posts.push({ url, init });
      return Response.json({
        created: [
          { key: "OPENAI_API_KEY", value: secret, type: "sensitive", target: ["production"] },
        ],
        failed: [],
      }, { status: 201 });
    });
    const result = await requestConfiguration({
      capability: "reader-openai",
      target: "production",
      expectedRevision: 0,
      requestKey: newConfigurationRequestKey(),
      values: { OPENAI_API_KEY: secret },
    }, deps(fetcher));

    expect(result.result).toEqual({ state: "saved-pending-deployment", accepted: ["OPENAI_API_KEY"], failed: [] });
    expect(posts).toHaveLength(1);
    expect(posts[0].url).toBe("https://api.vercel.com/v10/projects/prj_fixture/env?upsert=true&teamId=team_fixture");
    expect(JSON.parse(String(posts[0].init?.body))).toEqual([
      { key: "OPENAI_API_KEY", value: secret, type: "sensitive", target: ["production"] },
    ]);
    expect(posts.some((post) => post.url.includes("deployments"))).toBe(false);
    expect(JSON.stringify(result)).not.toContain(secret);
    expect(JSON.stringify(result)).not.toContain("synthetic-management-token");
  });

  it("normalizes a value-bearing partial provider response to names and safe codes only", async () => {
    const fetcher = vi.fn(async () => Response.json({
      created: { key: "BRAIN_REPO", value: secret },
      failed: [{ error: { envVarKey: "GITHUB_TOKEN", code: "RAW_PRIVATE_CODE", message: secret, value: secret } }],
    }, { status: 201 }));
    const result = await requestConfiguration({
      capability: "notes",
      target: "preview",
      expectedRevision: 0,
      requestKey: newConfigurationRequestKey(),
      values: { BRAIN_REPO: "fixture/brain", GITHUB_TOKEN: secret },
    }, deps(fetcher));

    expect(result.result).toEqual({
      state: "partial",
      accepted: ["BRAIN_REPO"],
      failed: [{ name: "GITHUB_TOKEN", code: "provider_rejected" }],
    });
    expect(JSON.stringify(result)).not.toContain(secret);
    expect(JSON.stringify(result)).not.toContain("RAW_PRIVATE_CODE");
  });

  it.each([
    ["unknown variable", { capability: "reader-openai", values: { OPENAI_API_KEY: secret, ARBITRARY: secret } }],
    ["mixed group", { capability: "reader-openai", values: { OPENAI_API_KEY: secret, GEMINI_API_KEY: secret } }],
    ["incomplete group", { capability: "mirror", values: { SUPABASE_URL: "https://fixture.supabase.co" } }],
  ])("rejects %s before admission or provider access", async (_label, sample) => {
    const store = memoryStore();
    store.admit = vi.fn(store.admit);
    const fetcher = vi.fn(async () => Response.json({}));
    await expect(requestConfiguration({
      capability: sample.capability as never,
      target: "production",
      expectedRevision: 0,
      requestKey: newConfigurationRequestKey(),
      values: sample.values,
    }, { env, store, fetcher })).rejects.toMatchObject({ code: "invalid" });
    expect(store.admit).not.toHaveBeenCalled();
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("bounds each value by UTF-8 bytes and refuses control-bearing secrets before admission", async () => {
    for (const value of ["é".repeat(4_097), "token\nsecond-line"]) {
      const store = memoryStore();
      store.admit = vi.fn(store.admit);
      await expect(requestConfiguration({ capability: "reader-openai", target: "production", expectedRevision: 0, requestKey: newConfigurationRequestKey(), values: { OPENAI_API_KEY: value } }, { env, store, fetcher: vi.fn() })).rejects.toMatchObject({ code: "invalid" });
      expect(store.admit).not.toHaveBeenCalled();
    }
  });

  it("returns uncertain and never reissues a provider write after a lost response", async () => {
    const store = memoryStore();
    const fetcher = vi.fn(async () => { throw new TypeError(`lost ${secret}`); });
    const request = {
      capability: "reader-google" as const,
      target: "production" as const,
      expectedRevision: 0,
      requestKey: newConfigurationRequestKey(),
      values: { GEMINI_API_KEY: secret },
    };
    const first = await requestConfiguration(request, { env, store, fetcher });
    const replay = await requestConfiguration(request, { env, store, fetcher });
    expect(first.result).toEqual({ state: "uncertain", accepted: [], failed: [{ name: "GEMINI_API_KEY", code: "completion_unconfirmed" }] });
    expect(replay).toEqual(first);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(first)).not.toContain(secret);
  });

  it("does not dispatch after a committed admission response is lost", async () => {
    const backing = memoryStore();
    let first = true;
    const original = backing.admit.bind(backing);
    backing.admit = async (input) => {
      const result = await original(input);
      if (first) { first = false; throw new (await import("../lib/console-configuration-store")).ConfigurationStoreError("uncertain"); }
      return result;
    };
    const fetcher = vi.fn(async () => Response.json({ created: [{ key: "OPENAI_API_KEY" }], failed: [] }, { status: 201 }));
    const request = { capability: "reader-openai" as const, target: "production" as const, expectedRevision: 0, requestKey: newConfigurationRequestKey(), values: { OPENAI_API_KEY: secret } };
    await expect(requestConfiguration(request, { env, store: backing, fetcher })).rejects.toMatchObject({ code: "unavailable" });
    const replay = await requestConfiguration(request, { env, store: backing, fetcher });
    expect(replay).toMatchObject({ status: "running", result: null, requestKey: request.requestKey });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it.each(["before commit", "after commit"] as const)("recovers a lost publication response %s without another provider write", async (timing) => {
    const backing = memoryStore();
    const original = backing.publish.bind(backing);
    let first = true;
    backing.publish = async (input) => {
      if (!first) return original(input);
      first = false;
      if (timing === "after commit") await original(input);
      throw new (await import("../lib/console-configuration-store")).ConfigurationStoreError("uncertain");
    };
    const fetcher = vi.fn(async () => Response.json({ created: [{ key: "OPENAI_API_KEY" }], failed: [] }, { status: 201 }));
    const result = await requestConfiguration({ capability: "reader-openai", target: "production", expectedRevision: 0, requestKey: newConfigurationRequestKey(), values: { OPENAI_API_KEY: secret } }, { env, store: backing, fetcher });
    expect(result.result?.state).toBe(timing === "after commit" ? "saved-pending-deployment" : "uncertain");
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("binds the expected revision into a retained request identity", async () => {
    const backing = memoryStore();
    const fetcher = vi.fn(async () => Response.json({ created: [{ key: "OPENAI_API_KEY" }], failed: [] }, { status: 201 }));
    const request = { capability: "reader-openai" as const, target: "production" as const, expectedRevision: 0, requestKey: newConfigurationRequestKey(), values: { OPENAI_API_KEY: secret } };
    await requestConfiguration(request, { env, store: backing, fetcher });
    await expect(requestConfiguration({ ...request, expectedRevision: 1 }, { env, store: backing, fetcher })).rejects.toMatchObject({ code: "key_conflict" });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("treats duplicate or foreign provider result names as unconfirmed", async () => {
    for (const created of [[{ key: "OPENAI_API_KEY" }, { key: "OPENAI_API_KEY" }], [{ key: "OPENAI_API_KEY" }, { key: "ARBITRARY" }]]) {
      const result = await requestConfiguration({ capability: "reader-openai", target: "production", expectedRevision: 0, requestKey: newConfigurationRequestKey(), values: { OPENAI_API_KEY: secret } }, deps(async () => Response.json({ created, failed: [] }, { status: 201 })));
      expect(result.result?.state).toBe("uncertain");
    }
  });
});
