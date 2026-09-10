// Visual transitions, execution outcomes and mail delivery are separate durable state machines.
import {OpsHttpError,type OpsStore} from "./ops";
import {deriveState,isPageable,type OpsState} from "./ops-state";
import {alertBody,alertSubject,type Mailer,type MailResult} from "./mail";

export interface SweepResult {
  checked:number;transitions:Array<{unit:string;from:string;to:string}>;paged:string[];mailFailed:string[];
  unavailable:string[];conflicts:string[];
}
const NEXT:Partial<Record<OpsState,string>>={missed:"check the routine is enabled, then Run now",crashed:"read the run log, then Run now",failed:"read the error, fix, then Run now",needs_you:"answer, acknowledge, or snooze on the board",succeeded:"nothing: recovered"};

export async function runSweep(store:OpsStore,mail:Mailer|null,now:Date,boardBase:string,deadlineMs=Date.now()+30000):Promise<SweepResult> {
  if(!store.sweepSnapshot||!store.recordSweep||!store.claimAlert||!store.completeAlert)throw new OpsHttpError(503,"atomic sweep unavailable");
  const started=Date.now(),deadline=Math.min(deadlineMs,started+30000);
  const room=(ms:number)=>Date.now()+ms<=deadline;
  const out:SweepResult={checked:0,transitions:[],paged:[],mailFailed:[],unavailable:[],conflicts:[]};
  // A pending delivery gets first turn, independent of slow/new observations. There are at
  // most two serial claims per tick, including empty/unavailable claims; no background work.
  const deliverOne=async()=>{
    // Reserve claim, send and completion before taking a lease.
    if(!room(mail?24000:8000)){if(!out.unavailable.includes("delivery_deferred_budget"))out.unavailable.push("delivery_deferred_budget");return;}
    const claim=await store.claimAlert!(new Date(now.getTime()+Date.now()-started),mail?.envelope??null);
    if(!claim)return;
    if(claim.state!=="sending") {out.mailFailed.push(claim.unit_id);if(claim.state==="unavailable")out.unavailable.push(claim.unit_id);return;}
    let result:MailResult={ok:false,status:0,error:"mail_unavailable",retryable:true};
    const sendAt=new Date(now.getTime()+Date.now()-started);
    if(sendAt.getTime()>=Date.parse(claim.first_claim_at!)+23*3600000||sendAt.getTime()>=Date.parse(claim.lease_until!))result={ok:false,status:0,error:"provider_window_expired",retryable:false};
    else if(mail)try {result=await mail.send(claim.subject!,claim.body!,{key:claim.provider_key!,from:claim.envelope!.from,to:claim.envelope!.to,notAfter:Date.parse(claim.first_claim_at!)+23*3600000});}catch {result={ok:false,status:0,error:"transport_unavailable",retryable:true};}
    const state=await store.completeAlert!(claim.id!,claim.claim_token!,result,new Date(now.getTime()+Date.now()-started));
    if(state==="accepted")out.paged.push(claim.unit_id);else out.mailFailed.push(claim.unit_id);
  };
  await deliverOne();
  if(!room(8000)){out.unavailable.push("sweep_budget");return out;}
  const units=await store.listUnits();
  const origin=new URL(boardBase).origin+"/";
  for(const listed of units) {
    if(!room(16000)){out.unavailable.push("sweep_budget");break;}
    const s=await store.sweepSnapshot(listed.id);if(!s)continue;
    out.checked++;
    const {unit,run,ack,monitor}=s;
    const to=deriveState(unit,run,ack,now,monitor.failures),from=monitor.visual;
    const recovery=to==="succeeded"&&unit.pages&&unit.kind!=="machine"&&monitor.accepted_alert>monitor.recovered_alert;
    const owed=monitor.owed;
    const wants=!!owed||isPageable(unit,to,monitor.failures)||recovery;
    const alertTo=owed?.to??to,alertRun=owed?s.owed_run:run;
    const a={unit:unit.id,unitName:unit.name,from:owed?.from??from,to:alertTo,error:alertRun?.error??(alertTo==="crashed"?`lease expired ${alertRun?.lease_until??""} with no finish`:null),at:owed?new Date(owed.at):now,next:NEXT[alertTo]??"open the board",boardUrl:`${origin}#${encodeURIComponent(unit.id)}`};
    const result=await store.recordSweep(unit.id,s.token,to,wants?{kind:owed?.kind??(recovery?"recovery":"alert"),subject:alertSubject(a),text:alertBody(a)}:null,now);
    if(result.transition)out.transitions.push({unit:unit.id,from,to});
    if(result.state==="capacity")out.unavailable.push(unit.id);
    if(result.state==="conflict")out.conflicts.push(unit.id);
  }
  await deliverOne();
  return out;
}
