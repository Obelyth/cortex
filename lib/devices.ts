import { z } from "zod";
import { deviceCommand, deviceItem, deviceRoster, DeviceError, DEVICE_MESSAGES, type DeviceItem, type DeviceResult } from "./device-contract";
import { deviceInputFingerprint, prepareDeviceIntent, readDeviceIntent } from "./device-cookie";
import { redact } from "./redact";

async function rpc(name: string, body: unknown): Promise<unknown> {
  const base=process.env.SUPABASE_URL?.replace(/\/$/,""),key=process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!base||!key) throw new DeviceError("unavailable");
  const res=await fetch(`${base}/rest/v1/rpc/${name}`,{method:"POST",cache:"no-store",headers:{apikey:key,Authorization:`Bearer ${key}`,"Content-Type":"application/json"},body:JSON.stringify(body),signal:AbortSignal.timeout(8000)});
  if (!res.ok) throw new Error("inventory store unavailable");
  return res.json();
}
const rawItem=z.object({id:z.uuidv4(),label:z.string().max(240),category:z.enum(["computer","phone","tablet","other"]).nullable(),created_at:z.string(),updated_at:z.string(),last_seen_at:z.string().nullable()});
function item(raw:unknown):DeviceItem {
  const r=rawItem.parse(raw);
  // Preserve updated_at byte-for-byte as the optimistic comparison token, including microseconds.
  return deviceItem.parse({id:r.id,label:redact(r.label),category:r.category,createdAt:r.created_at,updatedAt:r.updated_at,lastSeenAt:r.last_seen_at});
}
export async function listDevices(currentId:string|null) {
  try {
    const r=z.object({items:z.array(rawItem).max(50)}).parse(await rpc("console_device_list",{}));
    const items=r.items.map(item);
    return deviceRoster.parse({items,currentId:items.some(i=>i.id===currentId)?currentId:null});
  } catch {throw new DeviceError("unavailable");}
}
export async function changeDevice(raw:unknown,currentId:string|null):Promise<DeviceResult> {
  const parsed=deviceCommand.safeParse(raw); if(!parsed.success)throw new DeviceError("invalid");
  const c=parsed.data;
  try {
    if(c.action==="prepare")return prepareDeviceIntent();
    if(c.action==="visit"&&!currentId)return {outcome:"unregistered" as const};
    let value:unknown,requestId:string|null=null;
    if(c.action==="register") {
      const intent=readDeviceIntent(c.intent);if(!intent)throw new DeviceError("expired");
      requestId=intent.id;
      value=await rpc("console_device_register",{request_key:intent.id,intent_expires:intent.expiresAt,chosen_label:c.label,chosen_category:c.category,input_fingerprint:deviceInputFingerprint(c.label,c.category),current_id:currentId});
    } else if(c.action==="rename") value=await rpc("console_device_rename",{device_id:c.id,expected_updated:c.updatedAt,chosen_label:c.label});
    else if(c.action==="forget")value=await rpc("console_device_forget",{device_id:c.id,expected_updated:c.updatedAt});
    else value=await rpc("console_device_visit",{device_id:currentId});
    const result=z.object({outcome:z.string(),item:z.unknown().optional(),id:z.uuidv4().optional()}).parse(value);
    if(c.action==="visit"&&result.outcome==="missing")return {outcome:"unregistered" as const};
    if(c.action==="forget"&&result.outcome==="forgotten"&&result.id===c.id)return {outcome:"forgotten" as const,id:c.id};
    if(Object.hasOwn(DEVICE_MESSAGES,result.outcome))throw new DeviceError(result.outcome as keyof typeof DEVICE_MESSAGES);
    if((c.action==="register"&&result.outcome==="registered")||(c.action==="rename"&&result.outcome==="renamed")) {
      const validated=item(result.item);
      if(c.action==="rename"&&validated.id!==c.id)throw new DeviceError("uncertain");
      if(c.action==="register"&&validated.id!==requestId&&validated.id!==currentId)throw new DeviceError("uncertain");
      return {outcome:result.outcome as "registered"|"renamed",item:validated};
    }
    if(c.action==="visit"&&(result.outcome==="visited"||result.outcome==="throttled"))return {outcome:result.outcome};
    throw new DeviceError("uncertain");
  }catch(e){if(e instanceof DeviceError)throw e;throw new DeviceError(c.action==="prepare"?"unavailable":"uncertain");}
}
