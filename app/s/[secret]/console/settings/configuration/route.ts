import { z } from "zod";
import {
  ConfigurationError,
  configurationIngressAvailable,
  configurationProviderStatus,
  requestConfiguration,
  type ConfigurationCapability,
  type ConfigurationTarget,
} from "@/lib/console-configuration";
import {
  configurationCapabilitySchema,
  configurationRequestKeySchema,
  configurationTargetSchema,
} from "@/lib/console-configuration-contract";
import {
  ConfigurationStoreError,
  consoleConfigurationStore,
  environmentTarget,
} from "@/lib/console-configuration-store";
import { gateConsolePost, requireSecretOnly } from "../../post-gate";

export const dynamic = "force-dynamic";
// The normal body/admission/provider/publication path is bounded to 40 seconds. If a provider
// response or publication is ambiguous, durable exact-request recovery can add another 24 seconds,
// beyond both this 60-second host budget and the editor's 45-second wait. A cutoff therefore stays
// explicitly unresolved and is settled by a later exact-request status read; it never authorizes an
// automatic provider retry or implies cancellation.
export const maxDuration = 60;
// Three 8-KiB values plus JSON escaping and the fixed envelope remain representable.
const MAX_BODY_BYTES = 65_536;
export const CONFIGURATION_MIGRATION = "supabase/migrations/20260908225927_console_configuration.sql";

function reply(body: unknown, status = 200): Response {
  return Response.json(body, { status, headers: { "cache-control": "private, no-store, max-age=0" } });
}

function denied(response: Response): Response {
  response.headers.set("cache-control", "private, no-store, max-age=0");
  return response;
}

function errorResponse(error: unknown): Response {
  const code = error instanceof ConfigurationError ? error.code : "unavailable";
  if (code === "invalid") return reply({ code, error: "invalid capability configuration request" }, 400);
  if (code === "key_conflict") return reply({ code, error: "request key was already used for different configuration input" }, 409);
  if (code === "stale") return reply({ code, error: "configuration revision changed · inspect current status before saving" }, 409);
  if (code === "active") return reply({ code, error: "this capability has an unresolved configuration write · inspect or acknowledge it first" }, 409);
  if (code === "expired") return reply({ code, error: "request clock is outside the five-minute admission window · review the device clock and explicitly start a fresh request" }, 409);
  if (code === "capacity") return reply({ code, error: "configuration receipt capacity is held by retained or unresolved writes · inspect and acknowledge unresolved work before retrying" }, 503);
  if (code === "adapter_required") return reply({ code, error: "one-time provider setup required · configure CORTEX_VERCEL_TOKEN and fixed CORTEX_VERCEL_PROJECT_ID in the provider UI" }, 503);
  if (code === "ingress_required") return reply({ code, error: "secret entry requires the supported Vercel-managed HTTPS deployment · expose the provider system environment variables through Vercel project settings" }, 503);
  if (code === "schema_required") return reply({ code, error: "configuration receipts need one-time database setup through the provider UI", migration: CONFIGURATION_MIGRATION }, 503);
  return reply({ code: "unavailable", error: "configuration service unavailable · no provider write was confirmed" }, 503);
}

function https(request: Request): boolean {
  try { return new URL(request.url).protocol === "https:"; }
  catch { return false; }
}

export async function GET(request: Request, ctx: { params: Promise<{ secret: string }> }): Promise<Response> {
  const gate = await requireSecretOnly(request, ctx.params);
  if ("deny" in gate) return denied(gate.deny);
  const adapter = configurationProviderStatus(process.env);
  const store = consoleConfigurationStore();
  if (!store) return reply({ adapter, records: [], store: "unconfigured" });
  try {
    const url = new URL(request.url);
    const known = new Set(["capability", "target", "requestKey"]);
    if ([...url.searchParams.keys()].some((key) => !known.has(key))
      || url.searchParams.getAll("capability").length > 1
      || url.searchParams.getAll("target").length > 1
      || url.searchParams.getAll("requestKey").length > 1) {
      return errorResponse(new ConfigurationError("invalid"));
    }
    const rawCapability = url.searchParams.get("capability");
    const rawTarget = url.searchParams.get("target");
    const rawRequestKey = url.searchParams.get("requestKey");
    if ((rawCapability === null) !== (rawTarget === null)) return errorResponse(new ConfigurationError("invalid"));
    if (rawRequestKey !== null && (rawCapability === null || rawTarget === null)) return errorResponse(new ConfigurationError("invalid"));
    const capability = rawCapability === null ? null : configurationCapabilitySchema.safeParse(rawCapability);
    const target = rawTarget === null ? null : configurationTargetSchema.safeParse(rawTarget);
    const requestKey = rawRequestKey === null ? null : configurationRequestKeySchema.safeParse(rawRequestKey);
    if (capability && !capability.success || target && !target.success || requestKey && !requestKey.success) return errorResponse(new ConfigurationError("invalid"));
    if (!adapter.projectId) return reply({ adapter, records: [] });
    if (capability?.success && target?.success && requestKey?.success) {
      const fullTarget = environmentTarget(adapter.projectId, adapter.teamId, target.data);
      const exact = await store.getRequest(requestKey.data);
      if (exact && (exact.requestKey !== requestKey.data || exact.capability !== capability.data || exact.target !== fullTarget)) {
        return errorResponse(new ConfigurationError("unavailable"));
      }
      return reply({ adapter, records: exact ? [exact] : [] });
    }
    const filters: Array<{ capability?: ConfigurationCapability; target: string }> = target && target.success
      ? [{ capability: capability && capability.success ? capability.data : undefined, target: environmentTarget(adapter.projectId, adapter.teamId, target.data) }]
      : (["production", "preview"] as const).map((environment) => ({ target: environmentTarget(adapter.projectId!, adapter.teamId, environment) }));
    const pages = await Promise.all(filters.map((filter) => store.list(filter)));
    if (pages.some((page, index) => page.some((record) => record.target !== filters[index].target
      || (filters[index].capability && record.capability !== filters[index].capability)))) {
      return errorResponse(new ConfigurationError("unavailable"));
    }
    const records = pages.flat();
    return reply({ adapter, records });
  } catch (error) {
    if (error instanceof ConfigurationStoreError && error.code === "schema_required") return errorResponse(new ConfigurationError("schema_required"));
    return errorResponse(error);
  }
}

export async function POST(request: Request, ctx: { params: Promise<{ secret: string }> }): Promise<Response> {
  // Authenticate the path and device before reading a secret-bearing body. The URL protocol is
  // necessary but not sufficient TLS evidence; save also requires the Vercel-managed-ingress
  // system environment below and never derives trust from request forwarding headers.
  const auth = await requireSecretOnly(request, ctx.params);
  if ("deny" in auth) return denied(auth.deny);
  if (!https(request)) return reply({ code: "invalid", error: "configuration secrets require HTTPS" }, 400);
  const gate = await gateConsolePost(request,ctx.params,{maxBytes:MAX_BODY_BYTES,bodyFailure:reason=>reply({code:"invalid",error:reason==="too_large"?"configuration request exceeds 65,536 bytes":reason==="timeout"?"configuration body read timed out":"body must be a JSON object"},reason==="too_large"?413:400)});
  if ("deny" in gate) return denied(gate.deny);
  const store = consoleConfigurationStore();
  if (!store) return errorResponse(new ConfigurationError("schema_required"));
  const body = gate.body;
  if (body.action === "save") {
    // request.url is reconstructed by Next and is not TLS attestation on a standalone host.
    // Secret entry is supported only behind Vercel's managed ingress, identified by its
    // server-owned system environment. Never infer this trust boundary from forwarded headers.
    if (!configurationIngressAvailable(process.env)) return errorResponse(new ConfigurationError("ingress_required"));
    const { action: _action, ...input } = body;
    try { return reply({ record: await requestConfiguration(input, { env: process.env, store }) }); }
    catch (error) { return errorResponse(error); }
  }
  if (body.action === "acknowledge-unresolved") {
    const parsed = z.strictObject({
      action: z.literal("acknowledge-unresolved"),
      capability: configurationCapabilitySchema,
      target: configurationTargetSchema,
      requestKey: configurationRequestKeySchema,
    }).safeParse(body);
    if (!parsed.success) return errorResponse(new ConfigurationError("invalid"));
    const adapter = configurationProviderStatus(process.env);
    // Acknowledgment is a value-free receipt mutation. It needs the immutable target identity,
    // not provider write authority or Vercel hosting, and it never contacts the provider.
    if (!adapter.projectId) return errorResponse(new ConfigurationError("adapter_required"));
    try {
      const fullTarget = environmentTarget(adapter.projectId, adapter.teamId, parsed.data.target);
      const before = await store.getRequest(parsed.data.requestKey);
      if (!before
        || before.requestKey !== parsed.data.requestKey
        || before.capability !== parsed.data.capability
        || before.target !== fullTarget
        || before.acknowledged
        || (before.status !== "running" && before.status !== "uncertain")) {
        return reply({ code: "stale", error: "the unresolved receipt changed · inspect current status" }, 409);
      }
      const result = await store.acknowledge({
        capability: parsed.data.capability,
        target: fullTarget,
        requestKey: parsed.data.requestKey,
      });
      if (result.outcome !== "acknowledged"
        || result.record.requestKey !== parsed.data.requestKey
        || result.record.capability !== parsed.data.capability
        || result.record.target !== fullTarget
        || result.record.status !== "uncertain"
        || !result.record.acknowledged
        || result.record.revision <= before.revision) {
        return reply({ code: "stale", error: "the unresolved receipt changed · inspect current status" }, 409);
      }
      return reply({ acknowledged: true, record: result.record, warning: "Acknowledged as unresolved. The earlier provider write may still complete; this does not cancel it." });
    } catch (error) { return errorResponse(error); }
  }
  return errorResponse(new ConfigurationError("invalid"));
}
