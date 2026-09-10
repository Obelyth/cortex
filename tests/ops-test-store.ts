// Controlled in-memory contract for fast adapter tests. Actual locking, migrations, limits,
// and multi-connection correctness are exercised against native PostgreSQL, not this model.
import type {OpsStore,OpsEvent,OpsSnapshot,AlertClaim} from "../lib/ops";
import type {Run,Unit} from "../lib/ops-state";
export const testEnvelope={from:"test@example.com",to:"operator@example.com",credential:"a".repeat(64)};
export function withAtomic<T extends OpsStore>(base:T,units:Unit[],runs:Run[],events:OpsEvent[]):T {
  let next=10000;
  const revisions=new Map<string,number>(),lastKeys=new Map<string,string>();
  const accepted=new Map<string,number>(),recovered=new Map<string,number>();
  const snapshots=new Map<string,OpsSnapshot>();
  const pending:Array<AlertClaim&{logical:string;next:number;attempts:number;target:number;kind:string;done:boolean;to:string}>=[];
  const bump=(u:string)=>revisions.set(u,(revisions.get(u)??0)+1);
  const newest=(u:string)=>[...runs].filter(r=>r.unit_id===u).sort((a,b)=>Date.parse(b.started_at??"")-Date.parse(a.started_at??"")||b.id-a.id)[0]??null;
  const append=(e:OpsEvent)=>{events.push({...e,id:++next});};
  const failures=(u:string)=>{let count=0;for(const r of [...runs].filter(r=>r.unit_id===u&&r.ended_at&&r.state!=="seen").sort((a,b)=>Date.parse(b.ended_at!)-Date.parse(a.ended_at!)||b.id-a.id)){if((r.terminal_outcome??r.state)!=="failed")break;count++;}return count;};
  base.consecutiveFailures=async u=>failures(u);
  base.reportAtomic=async (r,now)=>{
    const u=units.find(u=>u.id===r.unit)!;let row=runs.find(x=>x.unit_id===r.unit&&x.run_key===r.run_key);
    const at=now.toISOString(),live=newest(u.id);
    const fresh=():Run=>({id:++next,unit_id:u.id,run_key:r.run_key,trigger:r.trigger??"cron",scheduled_at:null,started_at:at,ended_at:null,lease_until:new Date(+now+u.max_run_s*1000).toISOString(),state:"running",exit_reason:null,attempt:1,summary:null,error:null,evidence:[],cost:null,facts:r.facts??null});
    if(r.verb==="start"){
      if(row?.started_at)return {ok:true,run:row,replay:true};
      if(live&&!live.ended_at&&Date.parse(live.lease_until!)>=+now)return {ok:false,status:409,error:"unit has a live run",run:live};
      row=fresh();runs.push(row);append({unit_id:u.id,run_id:row.id,at,actor:"unit",kind:"start",to_state:"running",body:{run_key:r.run_key}});
    }else if(r.verb==="heartbeat"&&u.kind==="machine"){
      if(!row){row=fresh();runs.push(row);}Object.assign(row,{started_at:at,ended_at:at,lease_until:null,state:"seen",trigger:"heartbeat",facts:r.facts??row.facts});
      append({unit_id:u.id,run_id:row.id,at,actor:"unit",kind:"heartbeat",to_state:"seen"});
    }else{
      if(!row?.started_at)return {ok:false,status:404,error:"no started run"};
      if(r.verb==="finish"&&row.terminal_outcome)return {ok:true,run:row,replay:true};
      if(row.ended_at||row.id!==live?.id||Date.parse(row.lease_until!)<+now)return {ok:false,status:409,error:"stale run"};
      if(r.verb==="heartbeat")Object.assign(row,{lease_until:new Date(+now+u.max_run_s*1000).toISOString(),facts:r.facts??row.facts});
      else{
        const evidence=r.evidence??[],reason=r.ok===false?r.exit_reason??"code":null;
        const state=reason==="question"?"needs_you":reason==="infra"?"crashed":reason?"failed":evidence.length?"succeeded":"unverified";
        Object.assign(row,{ended_at:at,lease_until:null,terminal_outcome:state,state,exit_reason:reason,evidence,error:r.error??null,summary:r.summary??null,cost:r.cost??null});
        append({unit_id:u.id,run_id:row.id,at,actor:"unit",kind:"finish",from_state:"running",to_state:state,body:{evidence,summary:r.summary??null,error:r.error??null}});
      }
    }
    bump(u.id);return {ok:true,run:row,replay:false};
  };
  base.sweepSnapshot=async id=>{
    const u=units.find(u=>u.id===id);if(!u)return null;
    if(!accepted.has(id)){
      const a=await base.latestEvent(id,"alert_sent"),r=await base.latestEvent(id,"alert_sent","succeeded");
      accepted.set(id,a&&a.to_state!=="succeeded"?Date.parse(a.at):0);recovered.set(id,r?Date.parse(r.at):0);
    }
    const s:OpsSnapshot={token:String(revisions.get(id)??0),unit:u,run:newest(id),ack:await base.latestAck(id),monitor:{failures:failures(id),visual:(await base.latestTransition(id))?.to_state??"scheduled",accepted_alert:accepted.get(id)!,recovered_alert:recovered.get(id)!}};
    snapshots.set(id,s);return structuredClone(s);
  };
  base.recordSweep=async(id,token,to,alert,now)=>{
    if(token!==String(revisions.get(id)??0))return {state:"conflict"};
    const s=snapshots.get(id)!,transition=s.monitor.visual!==to;
    if(transition)append({unit_id:id,run_id:s.run?.id??null,at:now.toISOString(),actor:"sweep",kind:"transition",from_state:s.monitor.visual,to_state:to});
    if(alert){
      const logical=alert.kind==="recovery"?`recovery:${s.monitor.accepted_alert}`:`alert:${s.run?.id??"none"}:${to}`;
      if(lastKeys.get(id+alert.kind)!==logical){
        lastKeys.set(id+alert.kind,logical);
        pending.push({id:++next,unit_id:id,state:"sending",logical,next:+now,attempts:0,target:s.monitor.accepted_alert,kind:alert.kind,done:false,to,subject:alert.subject,body:alert.text,provider_key:`test/${next}`});
      }
    }
    bump(id);return {state:"recorded",transition};
  };
  base.claimAlert=async(now,envelope)=>{
    const a=pending.find(x=>!x.done&&x.next<=+now&&(!x.lease_until||Date.parse(x.lease_until)<+now));if(!a)return null;
    if(!envelope){a.next=+now+900000;append({unit_id:a.unit_id,run_id:null,at:now.toISOString(),actor:"sweep",kind:"alert_failed",body:{error:"mail_unavailable"}});return {state:"unavailable",unit_id:a.unit_id};}
    a.envelope??=envelope;a.first_claim_at??=now.toISOString();a.lease_until=new Date(+now+60000).toISOString();a.claim_token=String(++next);a.attempts++;return structuredClone(a);
  };
  base.completeAlert=async(id,token,result,now)=>{
    const a=pending.find(x=>x.id===id);if(!a||a.claim_token!==token||a.done)return "stale";
    if(result.ok){a.done=true;if(a.kind==="alert")accepted.set(a.unit_id,id);else recovered.set(a.unit_id,a.target);}
    else {a.next=+now+60000;a.lease_until=undefined;}
    append({unit_id:a.unit_id,run_id:null,at:now.toISOString(),actor:"sweep",kind:result.ok?"alert_sent":"alert_failed",to_state:a.to,body:result.ok?{id:result.id}:{status:result.status,error:result.error}});
    bump(a.unit_id);return result.ok?"accepted":"pending";
  };
  return base;
}
