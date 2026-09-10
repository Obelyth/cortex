import { changeDevice, listDevices } from "@/lib/devices";
import { DeviceError } from "@/lib/device-contract";
import { DEVICE_COOKIE, deviceCookie, readDeviceCookie, signDeviceCookie } from "@/lib/device-cookie";
import { readCookie } from "@/lib/stamp";
import { gateConsolePost, requireSecretOnly } from "../../post-gate";

export const dynamic="force-dynamic";
type Context={params:Promise<{secret:string}>};
const reply=(body:unknown,status=200)=>Response.json(body,{status,headers:{"Cache-Control":"no-store"}});
const denied=(res:Response)=>{res.headers.set("Cache-Control","no-store");return res;};
const identity=(req:Request)=>readDeviceCookie(readCookie(req.headers.get("cookie"),DEVICE_COOKIE));
export async function GET(req:Request,ctx:Context) {
  const gate=await requireSecretOnly(req,ctx.params);if("deny" in gate)return denied(gate.deny);
  try {
    // Passive responses must not mutate a binding that may have changed since this request.
    return reply(await listDevices(identity(req)));
  }catch{return reply({code:"unavailable",error:new DeviceError("unavailable").message},503);}
}
export async function POST(req:Request,ctx:Context) {
  const auth=await requireSecretOnly(req,ctx.params);if("deny" in auth)return denied(auth.deny);
  if(req.headers.get("content-type")?.split(";")[0].trim().toLowerCase()!=="application/json")return reply({code:"invalid",error:new DeviceError("invalid").message},400);
  try {
    const gate=await gateConsolePost(req,ctx.params,{maxBytes:4096,bodyFailure:reason=>reply({code:"invalid",error:reason==="too_large"?"Device request exceeds 4,096 bytes.":"Invalid device request."},reason==="too_large"?413:400)});if("deny" in gate)return denied(gate.deny);
    const current=identity(req),result=await changeDevice(gate.body,current),res=reply(result);
    if(result.outcome==="registered"&&"item" in result)res.headers.set("Set-Cookie",deviceCookie(signDeviceCookie(result.item.id),(await ctx.params).secret));
    if(result.outcome==="forgotten"&&"id" in result&&result.id===current)res.headers.set("Set-Cookie",deviceCookie(null,(await ctx.params).secret));
    return res;
  }catch(e){
    const safe=e instanceof DeviceError?e:new DeviceError("uncertain");
    const res=reply({code:safe.code,error:safe.message},safe.code==="invalid"?400:["conflict","missing","forgotten","expired","key_conflict","capacity","recent_capacity"].includes(safe.code)?409:503);
    return res;
  }
}
