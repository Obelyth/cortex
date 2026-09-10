// Validation at the reporter boundary; admission, fencing and effects belong to one DB RPC.
import {OpsHttpError,type OpsStore} from "./ops";
import type {Run,Unit} from "./ops-state";
import {redact} from "./redact";
import {utf16Prefix} from "./utf8";

export interface Report {
  unit:string;verb:"start"|"finish"|"heartbeat";run_key:string;
  ok?:boolean;summary?:string;error?:string;evidence?:string[];cost?:unknown;
  facts?:Record<string,unknown>;exit_reason?:"code"|"infra"|"timeout"|"no_signal"|"question";
  trigger?:"cron"|"manual"|"retry"|"webhook"|"heartbeat";
}
export type ReportResult={ok:true;run:Run;replay:boolean}|{ok:false;status:400|404|409;error:string;run?:Run};
const VERBS=new Set(["start","finish","heartbeat"]);
const REASONS=new Set(["code","infra","timeout","no_signal","question"]);
const TRIGGERS=new Set(["cron","manual","retry","webhook","heartbeat"]);
/** Auth is checked before this reader. Bound the stream before JSON allocation/validation. */
export async function readReportBody(req:Request):Promise<{body:unknown}|{error:string;status:number}> {
  const reader=req.body?.getReader();if(!reader)return {error:"body must be JSON",status:400};
  const cancel=()=>{void reader.cancel().catch(()=>{});};
  if(Number(req.headers.get("content-length"))>65536){cancel();return {error:"report exceeds 65536 bytes",status:413};}
  let timer:ReturnType<typeof setTimeout>|undefined;
  try {
    return await Promise.race([(async()=>{
      const chunks:Uint8Array[]=[];let size=0;
      for(;;){const {done,value}=await reader.read();if(done)break;size+=value.byteLength;if(size>65536){cancel();return {error:"report exceeds 65536 bytes",status:413};}chunks.push(value);}
      return {body:JSON.parse(new TextDecoder("utf-8",{fatal:true}).decode(Buffer.concat(chunks)))};
    })(),new Promise<{error:string;status:number}>(resolve=>{timer=setTimeout(()=>{cancel();resolve({error:"report body timed out",status:408});},5000);})]);
  }catch {return {error:"body must be JSON",status:400};}finally{clearTimeout(timer);}
}
export function parseReport(body:unknown):Report|string {
  if(!body||typeof body!=="object"||Array.isArray(body))return "body must be a JSON object";
  const b=body as Record<string,unknown>;
  if(typeof b.unit!=="string"||!b.unit||b.unit.length>128)return "unit must be 1-128 characters";
  if(typeof b.verb!=="string"||!VERBS.has(b.verb))return "verb must be start, finish or heartbeat";
  if(typeof b.run_key!=="string"||!b.run_key||b.run_key.length>256)return "run_key must be 1-256 characters";
  const r:Report={unit:b.unit,verb:b.verb as Report["verb"],run_key:b.run_key};
  if(typeof b.ok==="boolean")r.ok=b.ok;
  if(typeof b.summary==="string")r.summary=utf16Prefix(redact(b.summary),280);
  if(typeof b.error==="string")r.error=utf16Prefix(redact(b.error),4000);
  if(Array.isArray(b.evidence))r.evidence=b.evidence.filter((x):x is string=>typeof x==="string").slice(0,20).map(x=>utf16Prefix(redact(x),2048));
  if(b.cost!==undefined)r.cost=b.cost;
  if(b.facts&&typeof b.facts==="object"&&!Array.isArray(b.facts))r.facts=b.facts as Record<string,unknown>;
  if(typeof b.exit_reason==="string"&&REASONS.has(b.exit_reason))r.exit_reason=b.exit_reason as Report["exit_reason"];
  if(typeof b.trigger==="string"&&TRIGGERS.has(b.trigger))r.trigger=b.trigger as Report["trigger"];
  try {
    if(Buffer.byteLength(JSON.stringify(r.facts??{}))>16384||Buffer.byteLength(JSON.stringify(r.cost??null))>4096||Buffer.byteLength(JSON.stringify(r))>65536)return "report payload too large";
  } catch {return "report must be JSON serializable";}
  return r;
}
export async function applyReport(store:OpsStore,units:Unit[],r:Report,now:Date):Promise<ReportResult> {
  const parsed=parseReport(r);
  if(typeof parsed==="string")return {ok:false,status:400,error:parsed};
  if(!units.some(u=>u.id===r.unit))return {ok:false,status:404,error:"unknown unit"};
  if(!store.reportAtomic)throw new OpsHttpError(503,"atomic reporting unavailable");
  return store.reportAtomic(parsed,now);
}
