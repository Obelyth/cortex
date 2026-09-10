import { createHmac } from "node:crypto";
import { z } from "zod";
import { providerFetch, providerJson, type ProviderFetch } from "./console-job-output";
import {
  CONFIGURATION_GROUPS,
  configurationCapabilitySchema,
  configurationRequestKeySchema,
  configurationTargetSchema,
  type ConfigurationCapability,
  type ConfigurationRecord,
  type ConfigurationResult,
  type ConfigurationTarget,
} from "./console-configuration-contract";
import {
  ConfigurationStoreError,
  environmentTarget,
  type ConfigurationStore,
} from "./console-configuration-store";

export { CONFIGURATION_GROUPS } from "./console-configuration-contract";
export type { ConfigurationCapability, ConfigurationRecord, ConfigurationResult, ConfigurationTarget } from "./console-configuration-contract";
export interface ConfigurationSaveRequest {
  capability: ConfigurationCapability;
  target: ConfigurationTarget;
  expectedRevision: number;
  requestKey: string;
  values: Record<string, string>;
}
type Environment = Readonly<Record<string, string | undefined>>;
export interface ConfigurationDependencies {
  env: Environment;
  store: ConfigurationStore;
  fetcher?: ProviderFetch;
}

const ACTIVE_PREREQUISITES: Record<ConfigurationCapability, readonly string[]> = {
  notes: ["BRAIN_REPO", "GITHUB_TOKEN"],
  "reader-anthropic": ["ANTHROPIC_API_KEY"],
  "reader-openai": ["OPENAI_API_KEY"],
  "reader-google": ["GEMINI_API_KEY"],
  mirror: ["SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY"],
  cache: ["KV_REST_API_URL", "KV_REST_API_TOKEN"],
  // OPS_ALERT_FROM has a real mailer default; it remains part of a complete replacement
  // form, but it is not an active-process prerequisite.
  alerts: ["RESEND_API_KEY", "OPS_ALERT_TO"],
};

export type ConfigurationPresence = Record<ConfigurationCapability, { configured: boolean; missing: string[] }>;
export type ConfigurationOperationalEvidence = Record<ConfigurationCapability, { state: "observed" | "unavailable" | "unknown"; detail: string }>;

export function configurationPresence(env: Environment): ConfigurationPresence {
  return Object.fromEntries((Object.keys(CONFIGURATION_GROUPS) as ConfigurationCapability[]).map((capability) => {
    const missing = ACTIVE_PREREQUISITES[capability].filter((name) => !env[name]?.trim());
    return [capability, { configured: missing.length === 0, missing }];
  })) as ConfigurationPresence;
}

export function configurationOperationalEvidence(input: {
  presence: ConfigurationPresence;
  activeProvider: "anthropic" | "openai" | "google" | null;
  readerResolutionFailed: boolean;
  mirrorState: "off" | "missing" | "empty" | "unavailable" | "built";
  cacheEntries: number | null;
}): ConfigurationOperationalEvidence {
  const unknown = (detail: string) => ({ state: "unknown" as const, detail });
  const evidence: ConfigurationOperationalEvidence = {
    notes: unknown("repository access is not probed on this page"),
    "reader-anthropic": unknown("provider is not selected; no model call was made"),
    "reader-openai": unknown("provider is not selected; no model call was made"),
    "reader-google": unknown("provider is not selected; no model call was made"),
    mirror: unknown("working-state service is not configured"),
    cache: unknown("answer-cache service is not configured"),
    alerts: unknown("mail delivery is not probed on this page"),
  };
  const readers = {
    "reader-anthropic": "anthropic",
    "reader-openai": "openai",
    "reader-google": "google",
  } as const;
  for (const [capability, provider] of Object.entries(readers) as Array<[keyof typeof readers, typeof readers[keyof typeof readers]]>) {
    if (!input.presence[capability].configured) evidence[capability] = unknown("process configuration is missing");
    else if (input.readerResolutionFailed) evidence[capability] = { state: "unavailable", detail: "current reader resolution failed" };
    else if (input.activeProvider === provider) evidence[capability] = { state: "observed", detail: "selected by current reader resolution; provider not contacted" };
  }
  if (input.presence.mirror.configured) {
    evidence.mirror = input.mirrorState === "built" || input.mirrorState === "empty"
      ? { state: "observed", detail: `working-state read completed · ${input.mirrorState}` }
      : input.mirrorState === "unavailable" || input.mirrorState === "missing"
        ? { state: "unavailable", detail: `working-state probe ${input.mirrorState}` }
        : unknown("working-state service was not observed");
  }
  if (input.presence.cache.configured) {
    evidence.cache = input.cacheEntries === null
      ? { state: "unavailable", detail: "answer-cache read unavailable" }
      : { state: "observed", detail: `answer-cache read completed · ${input.cacheEntries} ${input.cacheEntries === 1 ? "entry" : "entries"}` };
  }
  return evidence;
}

export type ConfigurationErrorCode = "invalid" | "adapter_required" | "ingress_required" | "key_conflict" | "stale" | "active" | "expired" | "capacity" | "schema_required" | "unavailable";
export class ConfigurationError extends Error {
  constructor(public readonly code: ConfigurationErrorCode) { super(code); }
}

const requestSchema = z.strictObject({
  capability: configurationCapabilitySchema,
  target: configurationTargetSchema,
  expectedRevision: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  requestKey: configurationRequestKeySchema,
  values: z.record(z.string(), z.string()).refine((value) => Object.keys(value).length <= 8),
});

function nonempty(value: string): boolean {
  return value.length > 0 && Buffer.byteLength(value, "utf8") <= 8_192 && !/[\u0000-\u001f\u007f]/.test(value);
}
function httpsUrl(value: string): boolean {
  if (!nonempty(value)) return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password && !url.hash;
  } catch { return false; }
}
function email(value: string): boolean { return value.length <= 320 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value); }
function sender(value: string): boolean {
  const match = /^(?:[^<>\r\n]{1,200}\s<)?([^<>\s@]+@[^<>\s@]+\.[^<>\s@]+)>?$/.exec(value);
  return value.length <= 320 && Boolean(match);
}
function validVariable(name: string, value: string): boolean {
  if (!nonempty(value)) return false;
  if (name === "BRAIN_REPO") return /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/.test(value);
  if (name === "SUPABASE_URL" || name === "KV_REST_API_URL") return httpsUrl(value);
  if (name === "OPS_ALERT_TO") return email(value);
  if (name === "OPS_ALERT_FROM") return sender(value);
  return true;
}

export function parseConfigurationRequest(raw: unknown): ConfigurationSaveRequest {
  const parsed = requestSchema.safeParse(raw);
  if (!parsed.success) throw new ConfigurationError("invalid");
  const names = CONFIGURATION_GROUPS[parsed.data.capability].variables as readonly string[];
  const actual = Object.keys(parsed.data.values);
  if (actual.length !== names.length || actual.some((name) => !names.includes(name))) throw new ConfigurationError("invalid");
  for (const name of names) if (!validVariable(name, parsed.data.values[name])) throw new ConfigurationError("invalid");
  return parsed.data;
}

export interface ConfigurationAdapter {
  projectId: string;
  teamId: string | null;
  write(names: readonly string[], values: Record<string, string>, target: ConfigurationTarget): Promise<ConfigurationResult>;
}

function providerIdentity(env: Environment): { token: string; projectId: string; teamId: string | null } {
  const token = env.CORTEX_VERCEL_TOKEN?.trim();
  const projectId = env.CORTEX_VERCEL_PROJECT_ID?.trim();
  const teamId = env.CORTEX_VERCEL_TEAM_ID?.trim() || null;
  if (!token || !projectId || !/^prj_[A-Za-z0-9]{1,100}$/.test(projectId) || (teamId && !/^team_[A-Za-z0-9]{1,100}$/.test(teamId))) {
    throw new ConfigurationError("adapter_required");
  }
  return { token, projectId, teamId };
}

export function configurationAdapter(env: Environment, fetcher: ProviderFetch = fetch): ConfigurationAdapter {
  const identity = providerIdentity(env);
  return {
    projectId: identity.projectId,
    teamId: identity.teamId,
    async write(names, values, target) {
      const query = `upsert=true${identity.teamId ? `&teamId=${encodeURIComponent(identity.teamId)}` : ""}`;
      const body = names.map((key) => ({ key, value: values[key], type: "sensitive", target: [target] }));
      let response: Response;
      try {
        response = await providerFetch(
          `https://api.vercel.com/v10/projects/${encodeURIComponent(identity.projectId)}/env?${query}`,
          { method: "POST", headers: { Authorization: `Bearer ${identity.token}`, "Content-Type": "application/json" }, body: JSON.stringify(body) },
          fetcher,
        );
      } catch {
        return { state: "uncertain", accepted: [], failed: names.map((name) => ({ name, code: "completion_unconfirmed" })) };
      }
      if (!response.ok) {
        return response.status >= 500 || response.status === 429
          ? { state: "uncertain", accepted: [], failed: names.map((name) => ({ name, code: "completion_unconfirmed" })) }
          : { state: "partial", accepted: [], failed: names.map((name) => ({ name, code: "provider_rejected" })) };
      }
      let raw: unknown;
      try { raw = await providerJson(response); }
      catch { return { state: "uncertain", accepted: [], failed: names.map((name) => ({ name, code: "completion_unconfirmed" })) }; }
      const envelope = z.object({ created: z.union([z.object({ key: z.string() }).passthrough(), z.array(z.object({ key: z.string() }).passthrough()).max(8)]).optional(), failed: z.array(z.object({ error: z.object({ envVarKey: z.string().optional(), key: z.string().optional() }).passthrough() }).passthrough()).max(8) }).passthrough().safeParse(raw);
      if (!envelope.success) return { state: "uncertain", accepted: [], failed: names.map((name) => ({ name, code: "completion_unconfirmed" })) };
      const created = envelope.data.created === undefined ? [] : Array.isArray(envelope.data.created) ? envelope.data.created : [envelope.data.created];
      const reportedNames = [...created.map((item) => item.key), ...envelope.data.failed.map((item) => item.error.envVarKey ?? item.error.key ?? "")];
      if (reportedNames.length !== names.length || new Set(reportedNames).size !== names.length || reportedNames.some((name) => !names.includes(name))) {
        return { state: "uncertain", accepted: [], failed: names.map((name) => ({ name, code: "completion_unconfirmed" })) };
      }
      const accepted = names.filter((name) => created.some((item) => item.key === name));
      const failedNames = names.filter((name) => envelope.data.failed.some((item) => (item.error.envVarKey ?? item.error.key) === name));
      if (new Set([...accepted, ...failedNames]).size !== names.length || accepted.some((name) => !names.includes(name))) {
        return { state: "uncertain", accepted: [], failed: names.map((name) => ({ name, code: "completion_unconfirmed" })) };
      }
      return failedNames.length
        ? { state: "partial", accepted: [...accepted], failed: failedNames.map((name) => ({ name, code: "provider_rejected" })) }
        : { state: "saved-pending-deployment", accepted: [...accepted], failed: [] };
    },
  };
}

function fingerprintKey(env: Environment): string {
  const connector = env.CONNECTOR_PATH_SECRET?.trim();
  const passcode = env.CONSOLE_PASSCODE?.trim();
  if (!connector || !passcode) throw new ConfigurationError("unavailable");
  return `cortex-configuration\0${connector}\0${passcode}`;
}

function fingerprint(request: ConfigurationSaveRequest, fullTarget: string, env: Environment): string {
  const ordered = CONFIGURATION_GROUPS[request.capability].variables.map((name) => [name, request.values[name]]);
  return createHmac("sha256", fingerprintKey(env)).update(JSON.stringify({
    capability: request.capability,
    target: fullTarget,
    expectedRevision: request.expectedRevision,
    values: ordered,
  })).digest("hex");
}

function mapStoreError(error: unknown): never {
  if (error instanceof ConfigurationStoreError) {
    if (error.code === "schema_required") throw new ConfigurationError("schema_required");
    throw new ConfigurationError("unavailable");
  }
  throw new ConfigurationError("unavailable");
}

function sameReceipt(record: ConfigurationRecord, request: ConfigurationSaveRequest, fullTarget: string): boolean {
  return record.requestKey === request.requestKey && record.capability === request.capability && record.target === fullTarget;
}

export async function requestConfiguration(raw: unknown, deps: ConfigurationDependencies): Promise<ConfigurationRecord> {
  const request = parseConfigurationRequest(raw);
  const adapter = configurationAdapter(deps.env, deps.fetcher);
  const fullTarget = environmentTarget(adapter.projectId, adapter.teamId, request.target);
  let admission;
  try {
    admission = await deps.store.admit({
      requestKey: request.requestKey,
      fingerprint: fingerprint(request, fullTarget, deps.env),
      capability: request.capability,
      target: fullTarget,
      expectedRevision: request.expectedRevision,
    });
  } catch (error) { mapStoreError(error); }
  if (admission.outcome !== "admitted" && admission.outcome !== "replay") throw new ConfigurationError(admission.outcome);
  if (!sameReceipt(admission.record, request, fullTarget)) throw new ConfigurationError("unavailable");
  if (admission.outcome === "replay") return admission.record;
  const names = CONFIGURATION_GROUPS[request.capability].variables as readonly string[];
  const result = await adapter.write(names, request.values, request.target);
  try {
    const published = (await deps.store.publish({ capability: request.capability, target: fullTarget, requestKey: request.requestKey, claimToken: admission.claimToken, result })).record;
    if (!sameReceipt(published, request, fullTarget)) throw new ConfigurationError("unavailable");
    return published;
  } catch {
    const recovered = await deps.store.getRequest(request.requestKey).catch(() => null);
    if (recovered && !sameReceipt(recovered, request, fullTarget)) throw new ConfigurationError("unavailable");
    if (recovered?.result) return recovered;
    if (recovered?.status === "running") {
      const uncertain: ConfigurationResult = {
        state: "uncertain",
        accepted: [],
        failed: names.map((name) => ({ name, code: "completion_unconfirmed" })),
      };
      try {
        const finalized = (await deps.store.publish({
          capability: request.capability,
          target: fullTarget,
          requestKey: request.requestKey,
          claimToken: admission.claimToken,
          result: uncertain,
        })).record;
        if (!sameReceipt(finalized, request, fullTarget)) throw new ConfigurationError("unavailable");
        return finalized;
      } catch {
        const finalRead = await deps.store.getRequest(request.requestKey).catch(() => null);
        if (finalRead && sameReceipt(finalRead, request, fullTarget) && finalRead.result) return finalRead;
      }
    }
    throw new ConfigurationError("unavailable");
  }
}

export function configurationProviderStatus(env: Environment): { configured: boolean; projectId: string | null; teamId: string | null } {
  try {
    const identity = providerIdentity(env);
    return { configured: true, projectId: identity.projectId, teamId: identity.teamId };
  } catch {
    const project = env.CORTEX_VERCEL_PROJECT_ID?.trim() || "";
    const team = env.CORTEX_VERCEL_TEAM_ID?.trim() || "";
    const identityValid = /^prj_[A-Za-z0-9]{1,100}$/.test(project) && (!team || /^team_[A-Za-z0-9]{1,100}$/.test(team));
    return {
      configured: false,
      projectId: identityValid ? project : null,
      teamId: identityValid && team ? team : null,
    };
  }
}

export function configurationIngressAvailable(env: Environment): boolean {
  return env.VERCEL === "1" && (env.VERCEL_ENV === "production" || env.VERCEL_ENV === "preview");
}
