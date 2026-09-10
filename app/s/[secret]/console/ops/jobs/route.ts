import { consoleJobStore, CONSOLE_JOB_HISTORY } from "@/lib/console-job-store";
import { JobError, requestJob } from "@/lib/console-jobs";
import {prepareProviderJob,requestProviderJob,providerReadiness} from "@/lib/console-job-providers";
import { gateConsolePost, requireSecretOnly } from "../../post-gate";

export const dynamic = "force-dynamic";
// Body8 + source/ledger/risk32 + history8 + admission/recovery16 + owner recovery16 +
// dispatch/identity32 + publish/recovery16 = at most128s in the longest provider path.
export const maxDuration = 150;
const MAX_BODY = 8_192;
type Context = { params: Promise<{ secret: string }> };
const reply = (body: unknown, status = 200) => Response.json(body, { status, headers: { "Cache-Control": "no-store" } });
const denied = (res: Response) => { res.headers.set("Cache-Control", "no-store"); return res; };

function failure(error: unknown): Response {
  const safe = error instanceof JobError ? error : new JobError("unavailable");
  const status = safe.code === "invalid" ? 400 : ["key_conflict", "capacity", "mutation_busy", "active","conflict"].includes(safe.code) ? 409 : safe.code === "malformed" ? 502 : 503;
  return reply({ code: safe.code, error: safe.message, ...(safe.activeId ? { activeId: safe.activeId } : {}), ...(safe.code === "schema_required" ? { migration: "supabase/migrations/20260908160000_console_jobs.sql", migrations: ["supabase/migrations/20260908160000_console_jobs.sql", "supabase/migrations/20260908163000_console_job_claim_recovery.sql", "supabase/migrations/20260908205956_console_job_providers.sql", "supabase/migrations/20260908221155_console_job_provider_fences.sql", "supabase/migrations/20260909041000_console_job_recovery_exits.sql", "supabase/migrations/20260909043000_console_job_guard_invariant.sql"] } : {}) }, status);
}

export async function GET(req: Request, ctx: Context): Promise<Response> {
  const gate = await requireSecretOnly(req, ctx.params); if ("deny" in gate) return denied(gate.deny);
  try {
    if (req.url.length > 2_048) throw new JobError("invalid");
    const params = new URL(req.url).searchParams;
    if(params.size===1&&params.get("catalog")==="1")return reply({providers:providerReadiness()});
    if ([...params.keys()].some((key) => key !== "cursor") || params.getAll("cursor").length > 1) throw new JobError("invalid");
    const store = consoleJobStore(); if (!store) throw new JobError("unavailable");
    return reply({ ...(await store.list(params.get("cursor"))), historyPolicy: CONSOLE_JOB_HISTORY });
  } catch (error) { return failure(error); }
}

export async function POST(req: Request, ctx: Context): Promise<Response> {
  const auth = await requireSecretOnly(req, ctx.params); if ("deny" in auth) return denied(auth.deny);
  if (req.headers.get("content-type")?.split(";")[0].trim().toLowerCase() !== "application/json") return failure(new JobError("invalid"));
  try {
    const gate = await gateConsolePost(req, ctx.params,{maxBytes:MAX_BODY,bodyFailure:reason=>reply({code:"invalid",error:reason==="too_large"?"command request exceeds 8,192 bytes":reason==="timeout"?"command body read timed out":"body must be a JSON object"},reason==="too_large"?413:400)}); if ("deny" in gate) return denied(gate.deny);
    const store = consoleJobStore(); if (!store) throw new JobError("unavailable");
    if(gate.body.action==="prepare"){
      if(Object.keys(gate.body).some(key=>!["action","operation","requestKey"].includes(key)))throw new JobError("invalid");
      return reply({preparation:await prepareProviderJob({operation:gate.body.operation,requestKey:gate.body.requestKey},{store})});
    }
    if("intent" in gate.body)return reply({job:await requestProviderJob(gate.body,{store})});
    // Without a signed intent this door runs one thing: the local diagnostic. Provider work
    // arrives only through prepare → confirm → intent. A bare request naming deploy.production
    // with a target and SHA of its own choosing used to be admitted, take the mutation guard,
    // and land in history as a "failed" receipt against a target nothing had checked.
    if (gate.body.operation !== "diagnostics") throw new JobError("invalid");
    return reply({ job: await requestJob(gate.body as never, { store }) });
  } catch (error) { return failure(error); }
}
