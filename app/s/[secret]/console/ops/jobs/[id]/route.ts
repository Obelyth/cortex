import { consoleJobStore } from "@/lib/console-job-store";
import { JobError } from "@/lib/console-jobs";
import {reconcileProviderJob} from "@/lib/console-job-providers";
import { gateConsolePost, requireSecretOnly } from "../../../post-gate";

export const dynamic = "force-dynamic";
export const maxDuration=120;
type Context = { params: Promise<{ secret: string; id: string }> };
const reply = (body: unknown, status = 200) => Response.json(body, { status, headers: { "Cache-Control": "no-store" } });

export async function GET(req: Request, ctx: Context): Promise<Response> {
  const gate = await requireSecretOnly(req, ctx.params); if ("deny" in gate) { gate.deny.headers.set("Cache-Control", "no-store"); return gate.deny; }
  try {
    if (req.url.length > 2_048 || new URL(req.url).search) throw new JobError("invalid");
    const { id } = await ctx.params;
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id)) throw new JobError("invalid");
    const store = consoleJobStore(); if (!store) throw new JobError("unavailable");
    const job = await store.get(id); if (!job) return reply({ code: "missing", error: "command receipt not found" }, 404);
    return reply(job.operation==="diagnostics"?{job}:await reconcileProviderJob(id,{store}));
  } catch (error) {
    const safe = error instanceof JobError ? error : new JobError("unavailable");
    return reply({ code: safe.code, error: safe.message }, safe.code === "invalid" ? 400 : safe.code === "malformed" ? 502 : 503);
  }
}

export async function POST(req:Request,ctx:Context):Promise<Response>{
  const auth=await requireSecretOnly(req,ctx.params);if("deny" in auth){auth.deny.headers.set("Cache-Control","no-store");return auth.deny;}
  if(req.headers.get("content-type")?.split(";")[0].trim().toLowerCase()!=="application/json")return reply({code:"invalid",error:"invalid command request"},400);
  try{
    const gate=await gateConsolePost(req,ctx.params,{maxBytes:2048,bodyFailure:reason=>reply({code:"invalid",error:reason==="too_large"?"command request exceeds 2,048 bytes":reason==="timeout"?"command body read timed out":"invalid command request"},reason==="too_large"?413:400)});if("deny" in gate){gate.deny.headers.set("Cache-Control","no-store");return gate.deny;}
    const action=gate.body.action;
    if(Object.keys(gate.body).length!==1||typeof action!=="string"||!["acknowledge-unresolved","mark-uncertain","reconcile","logs"].includes(action))throw new JobError("invalid");
    const {id}=await ctx.params;if(!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id))throw new JobError("invalid");
    const store=consoleJobStore();if(!store)throw new JobError("unavailable");
    if(action==="reconcile"||action==="logs")return reply(await reconcileProviderJob(id,{store},action==="logs"));
    if(action==="mark-uncertain")return reply({job:await store.markUncertain(id),markedUncertain:true});
    return reply({job:await store.acknowledgeUncertain(id),acknowledged:true});
  }catch(error){const safe=error instanceof JobError?error:new JobError("unavailable");return reply({code:safe.code,error:safe.message},safe.code==="invalid"?400:safe.code==="malformed"?502:503);}
}
