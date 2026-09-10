import { z } from "zod";
import {
  configurationAcknowledgedRecordSchema,
  configurationRecordSchema,
  configurationRequestKeySchema,
  configurationResultSchema,
  type ConfigurationCapability,
  type ConfigurationRecord,
  type ConfigurationResult,
  type ConfigurationTarget,
} from "./console-configuration-contract";

export interface ConfigurationAdmission {
  requestKey: string;
  fingerprint: string;
  capability: ConfigurationCapability;
  target: string;
  expectedRevision: number;
}

export type ConfigurationAdmissionResult =
  | { outcome: "admitted"; record: ConfigurationRecord; claimToken: string }
  | { outcome: "replay"; record: ConfigurationRecord }
  | { outcome: "key_conflict" | "stale" | "active" | "expired" | "capacity" };

export interface ConfigurationPublication {
  capability: ConfigurationCapability;
  target: string;
  requestKey: string;
  claimToken: string;
  result: ConfigurationResult;
}

export interface ConfigurationStore {
  admit(input: ConfigurationAdmission): Promise<ConfigurationAdmissionResult>;
  publish(input: ConfigurationPublication): Promise<{ outcome: "published" | "stale"; record: ConfigurationRecord }>;
  list(filter?: { capability?: ConfigurationCapability; target?: string }): Promise<ConfigurationRecord[]>;
  getRequest(requestKey: string): Promise<ConfigurationRecord | null>;
  acknowledge(input: { capability: ConfigurationCapability; target: string; requestKey: string }): Promise<
    { outcome: "acknowledged"; record: ConfigurationRecord } | { outcome: "not_unresolved" }
  >;
}

export type ConfigurationStoreErrorCode = "schema_required" | "unavailable" | "uncertain" | "malformed";
export class ConfigurationStoreError extends Error {
  constructor(public readonly code: ConfigurationStoreErrorCode) { super(code); }
}

const TIMEOUT_MS = 8_000;
const MAX_RESPONSE_BYTES = 128 * 1024;
const rawRecordSchema = z.strictObject({
  capability: z.enum(["notes", "reader-anthropic", "reader-openai", "reader-google", "mirror", "cache", "alerts"]),
  target: z.string().min(1).max(300),
  revision: z.number().int().min(0),
  status: z.enum(["running", "finished", "uncertain"]),
  request_key: configurationRequestKeySchema,
  result: configurationResultSchema.nullable(),
  acknowledged: z.boolean(),
  updated_at: z.iso.datetime({ offset: true }),
});

function record(value: unknown): ConfigurationRecord {
  const row = rawRecordSchema.parse(value);
  return configurationRecordSchema.parse({
    capability: row.capability,
    target: row.target,
    revision: row.revision,
    status: row.status,
    requestKey: row.request_key,
    result: row.result,
    acknowledged: row.acknowledged,
    updatedAt: row.updated_at,
  });
}

async function boundedJson(response: Response): Promise<unknown> {
  const declared = response.headers.get("content-length");
  if (declared && (!/^\d+$/.test(declared) || Number(declared) > MAX_RESPONSE_BYTES)) throw new ConfigurationStoreError("malformed");
  const reader = response.body?.getReader();
  if (!reader) return null;
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_RESPONSE_BYTES) {
      void reader.cancel();
      throw new ConfigurationStoreError("malformed");
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  try { return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); }
  catch { throw new ConfigurationStoreError("malformed"); }
}

function missingSchema(status: number, value: unknown): boolean {
  const code = value && typeof value === "object" ? (value as Record<string, unknown>).code : null;
  return status === 404 && ["PGRST202", "PGRST205", "42P01"].includes(String(code));
}

let override: ConfigurationStore | null | undefined;
export function __setConsoleConfigurationStore(value: ConfigurationStore | null | undefined): void { override = value; }

export function consoleConfigurationStore(): ConfigurationStore | null {
  if (override !== undefined) return override;
  const base = process.env.SUPABASE_URL?.replace(/\/$/, "");
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!base || !key) return null;

  async function call(name: string, body: object, mutation = false): Promise<unknown> {
    let response: Response;
    try {
      response = await fetch(`${base}/rest/v1/rpc/${name}`, {
        method: "POST",
        cache: "no-store",
        headers: { apikey: key!, Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch { throw new ConfigurationStoreError(mutation ? "uncertain" : "unavailable"); }
    let value: unknown;
    try { value = await boundedJson(response); }
    catch (error) {
      if (mutation) throw new ConfigurationStoreError("uncertain");
      if (error instanceof ConfigurationStoreError) throw error;
      throw new ConfigurationStoreError("unavailable");
    }
    if (!response.ok) {
      if (missingSchema(response.status, value)) throw new ConfigurationStoreError("schema_required");
      throw new ConfigurationStoreError(mutation ? "uncertain" : "unavailable");
    }
    return value;
  }

  const outcome = (value: unknown) => z.strictObject({
    outcome: z.string(), record: z.unknown().optional(), claimToken: z.string().optional(),
  }).parse(value);

  return {
    async admit(input) {
      try {
        const parsed = outcome(await call("console_configuration_admit", {
          request_key: input.requestKey,
          input_fingerprint: input.fingerprint,
          capability_name: input.capability,
          target_name: input.target,
          expected_revision: input.expectedRevision,
        }, true));
        if (["key_conflict", "stale", "active", "expired", "capacity"].includes(parsed.outcome)) {
          return { outcome: parsed.outcome as "key_conflict" | "stale" | "active" | "expired" | "capacity" };
        }
        if (parsed.outcome === "replay" && parsed.record) return { outcome: "replay", record: record(parsed.record) };
        if (parsed.outcome === "admitted" && parsed.record && z.uuidv4().safeParse(parsed.claimToken).success) {
          return { outcome: "admitted", record: record(parsed.record), claimToken: parsed.claimToken! };
        }
        throw new ConfigurationStoreError("uncertain");
      } catch (error) {
        if (error instanceof ConfigurationStoreError) throw error;
        throw new ConfigurationStoreError("uncertain");
      }
    },
    async publish(input) {
      try {
        const parsed = outcome(await call("console_configuration_publish", {
          capability_name: input.capability,
          target_name: input.target,
          request_key: input.requestKey,
          claim_token: input.claimToken,
          completion_state: input.result.state === "uncertain" ? "uncertain" : "finished",
          result_value: input.result,
        }, true));
        if ((parsed.outcome === "published" || parsed.outcome === "stale") && parsed.record) {
          return { outcome: parsed.outcome, record: record(parsed.record) };
        }
        throw new ConfigurationStoreError("uncertain");
      } catch (error) {
        if (error instanceof ConfigurationStoreError) throw error;
        throw new ConfigurationStoreError("uncertain");
      }
    },
    async list(filter = {}) {
      let value: unknown;
      try {
        value = await call("console_configuration_get", {
          request_key: null,
          capability_name: filter.capability ?? null,
          target_name: filter.target ?? null,
        });
        return z.array(z.unknown()).max(32).parse(value).map(record);
      } catch (error) {
        if (error instanceof ConfigurationStoreError) throw error;
        throw new ConfigurationStoreError("malformed");
      }
    },
    async getRequest(requestKey) {
      let value: unknown;
      try {
        value = await call("console_configuration_get", { request_key: requestKey, capability_name: null, target_name: null });
        const rows = z.array(z.unknown()).max(1).parse(value);
        return rows[0] ? record(rows[0]) : null;
      } catch (error) {
        if (error instanceof ConfigurationStoreError) throw error;
        throw new ConfigurationStoreError("malformed");
      }
    },
    async acknowledge(input) {
      try {
        const parsed = outcome(await call("console_configuration_acknowledge", {
          capability_name: input.capability, target_name: input.target, request_key: input.requestKey,
        }, true));
        if (parsed.outcome === "not_unresolved") return { outcome: "not_unresolved" };
        if (parsed.outcome === "acknowledged" && parsed.record) {
          return { outcome: "acknowledged", record: configurationAcknowledgedRecordSchema.parse(record(parsed.record)) };
        }
        throw new ConfigurationStoreError("uncertain");
      } catch (error) {
        if (error instanceof ConfigurationStoreError) throw error;
        throw new ConfigurationStoreError("uncertain");
      }
    },
  };
}

export function environmentTarget(projectId: string, teamId: string | null, target: ConfigurationTarget): string {
  return `vercel:${projectId}:${teamId ?? "personal"}:${target}`;
}
