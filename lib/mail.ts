// One sender, one recipient, one shape. The mail is the groundskeeper's UNHEALTHY format made
// universal: what changed, the error, when, the next action, a link. A failed send is reported
// back as data (never thrown). A successful response means provider acceptance, not delivery.
import {createHash} from "node:crypto";
import {redact} from "./redact";
import {utf16Prefix} from "./utf8";
export interface Alert { unit: string; unitName: string; from: string; to: string; error: string | null; at: Date; next: string; boardUrl: string }
export interface MailEnvelope {from:string;to:string;credential:string}
export type MailResult={ok:true;id:string}|{ok:false;status:number;error:string;retryable?:boolean};
export interface Mailer {envelope?:MailEnvelope;send(subject:string,text:string,frozen?:{key:string;from:string;to:string;notAfter?:number}):Promise<MailResult>}

export function alertSubject(a: Alert): string { return utf16Prefix(redact(`CORTEX OPS: ${a.unitName} ${a.from} → ${a.to}`),500); }
export function alertBody(a: Alert): string {
  const when = a.at.toISOString().slice(0, 16).replace("T", " ") + " UTC";
  return [`What changed: ${utf16Prefix(redact(a.unitName),256)} ${a.from} → ${a.to}`, `Error: ${utf16Prefix(redact(a.error ?? "—"),3000)}`, `When: ${when}`, `Next: ${a.next}`, a.boardUrl].join("\n");
}

let override: Mailer | null | undefined;
export function __setMailer(m: Mailer | null | undefined): void { override = m; }

export function mailer(): Mailer | null {
  if (override !== undefined) return override;
  const key = process.env.RESEND_API_KEY?.trim();
  const to = process.env.OPS_ALERT_TO?.trim();
  const from = process.env.OPS_ALERT_FROM?.trim() || "Cortex <onboarding@resend.dev>";
  if (!key || !to) return null;
  return {
    envelope:{from,to,credential:createHash("sha256").update("cortex-ops-mail\0"+key).digest("hex")},
    async send(subject, text, frozen) {
      if(frozen?.notAfter!==undefined&&Date.now()>=frozen.notAfter)return {ok:false,status:0,error:"provider_window_expired",retryable:false};
      const body=JSON.stringify({from:frozen?.from??from,to:[frozen?.to??to],subject,text});
      if(Buffer.byteLength(body)>20000)return {ok:false,status:0,error:"request_too_large",retryable:false};
      try {
        const res = await fetch("https://api.resend.com/emails", {
          method: "POST",
          headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json",...(frozen?{"Idempotency-Key":frozen.key}:{}) },
          body,
          signal: AbortSignal.timeout(8_000),
        });
        // Stream with a strict byte cap. Provider bodies and thrown messages never escape.
        const reader=res.body?.getReader();let size=0;const chunks:Uint8Array[]=[];
        if(reader)for(;;){const {done,value}=await reader.read();if(done)break;size+=value.length;if(size>4096){await reader.cancel();return {ok:false,status:res.status,error:"response_too_large",retryable:true};}chunks.push(value);}
        let j:{id?:unknown;name?:unknown}={};try {const parsed=JSON.parse(Buffer.concat(chunks).toString("utf8"));if(parsed&&typeof parsed==="object"&&!Array.isArray(parsed))j=parsed;}catch {/* status still classifies non-JSON errors */}
        if(!res.ok) {
          const conflict=res.status===409&&j.name==="concurrent_idempotent_requests";
          const mismatch=res.status===409&&j.name==="invalid_idempotent_request";
          return {ok:false,status:res.status,error:mismatch?"invalid_idempotent_request":conflict?"concurrent_idempotent_requests":res.status>=500?"provider_unavailable":"provider_rejected",retryable:conflict||res.status===429||res.status>=500};
        }
        if(typeof j.id!=="string"||!j.id||j.id.length>256)return {ok:false,status:res.status,error:"invalid_response",retryable:true};
        return { ok: true, id: j.id };
      } catch {
        return { ok: false, status: 0, error:"transport_unavailable",retryable:true };
      }
    },
  };
}
