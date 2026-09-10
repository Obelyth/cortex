import { changeWorkingState, readWorkingItem, readWorkingState, WorkingStateError } from "@/lib/working-state";
import { gateConsolePost, requireSecretOnly } from "../post-gate";

export const dynamic = "force-dynamic";
const reply = (body: unknown, status=200) => Response.json(body,{status,headers:{"Cache-Control":"no-store"}});
const privateResponse = (res: Response) => {res.headers.set("Cache-Control","no-store");return res;};
type Context = {params:Promise<{secret:string}>};
function error(e: unknown, writing: boolean) {
  const safe = e instanceof WorkingStateError ? e : new WorkingStateError(writing?"uncertain":"unavailable");
  const status = safe.code==="invalid"?400:safe.code==="missing"?404:["conflict","key_conflict"].includes(safe.code)?409:503;
  return reply({code:safe.code,error:safe.message,...(safe.current?{current:safe.current}:{})},status);
}

export async function POST(req: Request, ctx: Context) {
  const auth=await requireSecretOnly(req,ctx.params); if("deny" in auth) return privateResponse(auth.deny);
  if(req.headers.get("content-type")?.split(";")[0].trim().toLowerCase()!=="application/json") return reply({code:"invalid",error:"body must be JSON"},400);
  try {
    const gate=await gateConsolePost(req,ctx.params,{maxBytes:16384,bodyFailure:reason=>reply({code:"invalid",error:reason==="too_large"?"working-state request is too large":"body must be a JSON object"},reason==="too_large"?413:400)});if("deny" in gate)return privateResponse(gate.deny);
    return reply(await changeWorkingState(gate.body));
  } catch(e){return error(e,true);}
}
export async function GET(req: Request,ctx: Context) {
  const gate=await requireSecretOnly(req,ctx.params);if("deny" in gate)return privateResponse(gate.deny);
  try {
    if(req.url.length>2048)throw new WorkingStateError("invalid");
    const q=new URL(req.url).searchParams;
    if([...q.keys()].some(k=>!["id","project","before","beforeId"].includes(k)))throw new WorkingStateError("invalid");
    if(q.has("id")) {if([...q.keys()].length!==1)throw new WorkingStateError("invalid");return reply({item:await readWorkingItem(Number(q.get("id")))});}
    if(q.has("before")!==q.has("beforeId"))throw new WorkingStateError("invalid");
    return reply(await readWorkingState({project:q.has("project")?q.get("project"):null,before:q.has("before")?{touched_at:q.get("before"),id:Number(q.get("beforeId"))}:null}));
  }catch(e){return error(e,false);}
}
