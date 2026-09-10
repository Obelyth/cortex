import { z } from "zod";

export const CONFIGURATION_GROUPS = {
  notes: { label: "Notes", variables: ["BRAIN_REPO", "GITHUB_TOKEN"] },
  "reader-anthropic": { label: "Reader · Anthropic", variables: ["ANTHROPIC_API_KEY"] },
  "reader-openai": { label: "Reader · OpenAI", variables: ["OPENAI_API_KEY"] },
  "reader-google": { label: "Reader · Google", variables: ["GEMINI_API_KEY"] },
  mirror: { label: "Mirror & working state", variables: ["SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY"] },
  cache: { label: "Cache", variables: ["KV_REST_API_URL", "KV_REST_API_TOKEN"] },
  alerts: { label: "Alerts", variables: ["RESEND_API_KEY", "OPS_ALERT_TO", "OPS_ALERT_FROM"] },
} as const;

export type ConfigurationCapability = keyof typeof CONFIGURATION_GROUPS;
export type ConfigurationTarget = "production" | "preview";
export interface ConfigurationResult {
  state: "saved-pending-deployment" | "partial" | "uncertain";
  accepted: string[];
  failed: Array<{ name: string; code: string }>;
}
export interface ConfigurationRecord {
  capability: ConfigurationCapability;
  target: string;
  revision: number;
  status: "running" | "finished" | "uncertain";
  requestKey: string;
  result: ConfigurationResult | null;
  acknowledged: boolean;
  updatedAt: string;
}
export interface ConfigurationAdapterStatus {
  configured: boolean;
  projectId: string | null;
  teamId: string | null;
}

const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** Read the immutable 48-bit Unix-millisecond prefix without accepting another UUID version. */
export function requestKeyTimestamp(value: string): number | null {
  if (!UUID_V7.test(value)) return null;
  const millis = Number.parseInt(value.slice(0, 13).replace("-", ""), 16);
  return Number.isSafeInteger(millis) && millis >= 0 && millis <= 8_640_000_000_000_000 ? millis : null;
}

type FillRandom = (target: Uint8Array) => void;

/** Generate the browser-owned idempotency key; no fallback to Math.random is permitted. */
export function newConfigurationRequestKey(
  now = Date.now(),
  fill: FillRandom = (target) => crypto.getRandomValues(target),
): string {
  if (!Number.isSafeInteger(now) || now < 0 || now > 0xffffffffffff) throw new Error("request clock unavailable");
  const bytes = new Uint8Array(16);
  fill(bytes);
  let timestamp = now;
  for (let index = 5; index >= 0; index--) {
    bytes[index] = timestamp % 256;
    timestamp = Math.floor(timestamp / 256);
  }
  bytes[6] = 0x70 | (bytes[6] & 0x0f);
  bytes[8] = 0x80 | (bytes[8] & 0x3f);
  const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export const configurationCapabilitySchema = z.enum(Object.keys(CONFIGURATION_GROUPS) as [ConfigurationCapability, ...ConfigurationCapability[]]);
export const configurationTargetSchema = z.enum(["production", "preview"]);
export const configurationRequestKeySchema = z.string().refine((value) => requestKeyTimestamp(value) !== null, "UUIDv7 request key required");

const allVariables = new Set(Object.values(CONFIGURATION_GROUPS).flatMap((group) => group.variables as readonly string[]));
export const configurationResultSchema = z.strictObject({
  state: z.enum(["saved-pending-deployment", "partial", "uncertain"]),
  accepted: z.array(z.string().refine((name) => allVariables.has(name), "unknown variable")).max(8),
  failed: z.array(z.strictObject({
    name: z.string().refine((name) => allVariables.has(name), "unknown variable"),
    code: z.enum(["provider_rejected", "completion_unconfirmed"]),
  })).max(8),
}).superRefine((value, ctx) => {
  if (new Set([...value.accepted, ...value.failed.map((failure) => failure.name)]).size !== value.accepted.length + value.failed.length) {
    ctx.addIssue({ code: "custom", message: "duplicate result variable" });
  }
  if (value.state === "saved-pending-deployment" && value.failed.length > 0) ctx.addIssue({ code: "custom", message: "saved result cannot contain failures" });
  if (value.state === "partial" && (value.failed.length === 0 || value.failed.some((failure) => failure.code !== "provider_rejected"))) {
    ctx.addIssue({ code: "custom", message: "partial result requires provider rejection" });
  }
  if (value.state === "uncertain" && (value.accepted.length > 0 || value.failed.length === 0 || value.failed.some((failure) => failure.code !== "completion_unconfirmed"))) {
    ctx.addIssue({ code: "custom", message: "uncertain result must leave every completion unconfirmed" });
  }
});

export const configurationRecordSchema = z.strictObject({
  capability: configurationCapabilitySchema,
  target: z.string().regex(/^vercel:prj_[A-Za-z0-9]{1,100}:(?:personal|team_[A-Za-z0-9]{1,100}):(production|preview)$/),
  revision: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  status: z.enum(["running", "finished", "uncertain"]),
  requestKey: configurationRequestKeySchema,
  result: configurationResultSchema.nullable(),
  acknowledged: z.boolean(),
  updatedAt: z.iso.datetime({ offset: true }),
}).superRefine((value, ctx) => {
  if (value.result) {
    const allowed = new Set(CONFIGURATION_GROUPS[value.capability].variables as readonly string[]);
    const names = [...value.result.accepted, ...value.result.failed.map((failure) => failure.name)];
    for (const name of names) {
      if (!allowed.has(name)) ctx.addIssue({ code: "custom", message: "result variable belongs to another capability" });
    }
    if (new Set(names).size !== allowed.size || [...allowed].some((name) => !names.includes(name))) {
      ctx.addIssue({ code: "custom", message: "result must cover the complete capability" });
    }
  }
  if (value.status === "running" && (value.result !== null || value.acknowledged)) ctx.addIssue({ code: "custom", message: "running receipt cannot contain a result or acknowledgement" });
  if (value.status === "finished" && (!value.result || value.result.state === "uncertain" || value.acknowledged)) ctx.addIssue({ code: "custom", message: "finished receipt requires a confirmed result" });
  if (value.status === "uncertain" && value.result?.state !== "uncertain" && value.result !== null) ctx.addIssue({ code: "custom", message: "uncertain receipt has invalid result" });
});

export const configurationAdapterStatusSchema = z.strictObject({
  configured: z.boolean(),
  projectId: z.string().regex(/^prj_[A-Za-z0-9]{1,100}$/).nullable(),
  teamId: z.string().regex(/^team_[A-Za-z0-9]{1,100}$/).nullable(),
}).refine((value) => value.projectId !== null || value.teamId === null, "team requires project");

export const configurationStatusResponseSchema = z.strictObject({
  adapter: configurationAdapterStatusSchema,
  records: z.array(configurationRecordSchema).max(32),
  store: z.enum(["unconfigured"]).optional(),
});

export const configurationSaveResponseSchema = z.strictObject({ record: configurationRecordSchema });
export const configurationAcknowledgedRecordSchema = configurationRecordSchema.refine(
  (record) => record.status === "uncertain" && record.acknowledged,
  "acknowledgment requires an uncertain acknowledged receipt",
);
export const configurationAcknowledgementSchema = z.strictObject({
  acknowledged: z.literal(true),
  record: configurationAcknowledgedRecordSchema,
  warning: z.string().min(1).max(500),
});

export const configurationErrorResponseSchema = z.strictObject({
  code: z.enum(["invalid", "adapter_required", "ingress_required", "key_conflict", "stale", "active", "expired", "capacity", "schema_required", "unavailable"]),
  error: z.string().min(1).max(500),
  migration: z.string().max(200).optional(),
});
