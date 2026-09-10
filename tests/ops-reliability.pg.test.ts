import {readFile} from "node:fs/promises";
import {Client} from "pg";
import {afterAll,beforeAll,beforeEach,describe,expect,it,vi} from "vitest";
import {opsStore} from "../lib/ops";
import {applyReport} from "../lib/ops-report";
import {runSweep} from "../lib/sweep";
import type {Unit} from "../lib/ops-state";

const socket=process.env.CORTEX_NATIVE_PG_SOCKET??"";
const config={host:socket,port:5432,user:"cortex_test",database:"postgres",options:"-c statement_timeout=5000"};
const database=`cortex_test_ops_${process.pid}_${Date.now()}`;
let db:Client,other:Client,created=false;let historical:any;
const now=new Date("2026-09-08T12:00:00Z");
const at=(minutes:number)=>new Date(now.getTime()+minutes*60000);
const unit:Unit={id:"synthetic",kind:"routine",name:"Synthetic",owner:"none",period_s:86400,grace_s:1800,max_run_s:60,pages:true,tolerance:2,paused_until:null,run_now:null,notes:null};
const report=(key:string,verb="start",extra={})=>({unit:unit.id,run_key:key,verb,...extra});
const rpc=async(c:Client,r:unknown,t=now)=>(await c.query("select ops_report_atomic($1,$2) value",[r,t])).rows[0].value;
const envelope={from:"fixture@example.com",to:"operator@example.com",credential:"a".repeat(64)};
function actualStore(){
  vi.stubEnv("SUPABASE_URL","https://synthetic.invalid");vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY","synthetic");
  vi.stubGlobal("fetch",async(url:string,init?:RequestInit)=>{
    const u=new URL(url),a=JSON.parse(String(init?.body??"{}"));let value;
    const rpc=u.pathname.split("/").at(-1);
    const calls:Record<string,[string,unknown[]]>={
      ops_report_atomic:["select ops_report_atomic($1,$2) value",[a.report,a.observed_at]],
      ops_sweep_snapshot:["select ops_sweep_snapshot($1) value",[a.unit_id]],
      ops_sweep_record:["select ops_sweep_record($1,$2,$3,$4,$5) value",[a.unit_id,a.expected_token,a.visual_state,a.alert,a.observed_at]],
      ops_alert_claim:["select ops_alert_claim($1,$2) value",[a.observed_at,a.envelope]],
      ops_alert_complete:["select ops_alert_complete($1,$2,$3,$4) value",[a.alert_id,a.token,a.result,a.observed_at]],
      ops_delivery_status:["select ops_delivery_status($1) value",[a.unit_id]],
    };
    if(calls[rpc!])value=(await db.query(...calls[rpc!])).rows[0].value;
    else if(rpc==="ops_units")value=(await db.query("select * from ops_units order by id")).rows;
    else if(rpc==="ops_monitor")value=(await db.query("select failures from ops_monitor where unit_id=$1",[u.searchParams.get("unit_id")!.slice(3)])).rows;
    else throw new Error("unmapped synthetic request");
    return Response.json(value);
  });
  return opsStore()!;
}

// VISIBLE, not silent. A gated suite that skips itself shrinks the count and says nothing, so a
// run with no database looked identical to a run that had checked everything — for a month.
if (process.env.CORTEX_NATIVE_PG !== "1") {
  describe.skip("native Ops reliability — SKIPPED: set CORTEX_NATIVE_PG=1 and CORTEX_NATIVE_PG_SOCKET to a Unix socket directory", () => {
    it("did not run", () => {});
  });
}
describe.runIf(process.env.CORTEX_NATIVE_PG==="1")("native Ops reliability",()=>{
  beforeAll(async()=>{
    if(!socket.startsWith("/"))throw new Error("explicit native socket required");
    const admin=new Client(config);await admin.connect();await admin.query(`create database ${database}`);created=true;await admin.end();
    db=new Client({...config,database});other=new Client({...config,database});await db.connect();await other.connect();
    await db.query("do $$begin create role anon nologin;exception when duplicate_object then null;end$$;do $$begin create role authenticated nologin;exception when duplicate_object then null;end$$;do $$begin create role service_role nologin bypassrls;exception when duplicate_object then null;end$$;");
    await db.query(await readFile("supabase/migrations/20260902120000_ops_ledger.sql","utf8"));
    await db.query("insert into ops_units(id,kind,name,period_s,pages) values('routine-history','routine','Historical routine',86400,true),('workstation-test','machine','Test workstation',900,false);insert into ops_runs(unit_id,run_key,started_at,ended_at,state,exit_reason,evidence) values('routine-history','old-failed','2026-09-01','2026-09-01','acknowledged','code','[]'),('routine-history','old-success','2026-09-02','2026-09-02','failed',null,'[\"proof\"]'),('routine-history','inferred-failed','2026-09-03','2026-09-03','paused','code','[]'),('workstation-test','heartbeat','2026-09-03','2026-09-03','quiet',null,'[]');insert into ops_events(unit_id,run_id,actor,kind,to_state) select unit_id,id,'unit','finish',case when run_key='old-success' then 'succeeded' else 'failed' end from ops_runs where run_key in ('old-failed','old-success');insert into ops_events(unit_id,run_id,actor,kind,to_state) select unit_id,id,'sweep','alert_sent','failed' from ops_runs where run_key='inferred-failed';insert into ops_events(unit_id,actor,kind,to_state) values('routine-history','sweep','transition','succeeded');");
    await db.query(await readFile("supabase/migrations/20260908150350_ops_reliability.sql","utf8"));
    historical={monitor:(await db.query("select * from ops_monitor where unit_id='routine-history'")).rows[0],outcomes:(await db.query("select run_key,terminal_outcome from ops_runs order by id")).rows};
  });
  afterAll(async()=>{vi.unstubAllGlobals();vi.unstubAllEnvs();if(!created)return;await db?.end();await other?.end();const admin=new Client(config);await admin.connect();await admin.query(`drop database ${database}`);await admin.end();});
  beforeEach(async()=>{
    await db.query("delete from ops_units");
    await db.query("insert into ops_units(id,kind,name,owner,period_s,grace_s,max_run_s,pages,tolerance) values($1,$2,$3,$4,$5,$6,$7,$8,$9)",Object.values(unit).slice(0,9));
  });
  it("atomically admits one key, replays it, and fences expired workers",async()=>{
    const out=await Promise.all([rpc(db,report("a")),rpc(other,report("b"))]);
    expect(out.filter(r=>r.ok)).toHaveLength(1);
    expect(out.find(r=>!r.ok)).toMatchObject({status:409});
    const winner=out.find(r=>r.ok).run.run_key;
    expect(await rpc(db,report(winner))).toMatchObject({ok:true,replay:true});
    expect((await db.query("select count(*)::int n from ops_events where kind='start'")).rows[0].n).toBe(1);
    expect(await rpc(db,report("replacement"),at(2))).toMatchObject({ok:true});
    for(const verb of ["finish","heartbeat"])expect(await rpc(db,report(winner,verb),at(2))).toMatchObject({ok:false,status:409});
    expect(await rpc(db,report("replacement","finish",{ok:false}),at(2))).toMatchObject({ok:true});
    expect(await rpc(db,report("replacement","heartbeat"),at(2))).toMatchObject({ok:false});
  });
  it("backfills from finish evidence and does not mistake a successful visual transition for accepted recovery",()=>{
    expect(historical.monitor.failures).toBe(1);expect(Number(historical.monitor.accepted_alert)).toBeGreaterThan(0);expect(historical.monitor.recovered_alert).toBe("0");
    expect(historical.monitor.last_alert_key).toMatch(/^alert:\d+:failed$/);
    expect(historical.outcomes).toEqual([{run_key:"old-failed",terminal_outcome:"failed"},{run_key:"old-success",terminal_outcome:"succeeded"},{run_key:"inferred-failed",terminal_outcome:"failed"},{run_key:"heartbeat",terminal_outcome:null}]);
  });
  it("actual report/store/sweep counts distinct outcomes without running transitions and retries unchanged mail",async()=>{
    const s=actualStore();let sends=0;
    const mail={envelope,send:async()=>++sends===1?{ok:false as const,status:502,error:"provider_unavailable",retryable:true}:{ok:true as const,id:"accepted"}};
    for(const [i,k] of ["first","second"].entries()){
      await applyReport(s,[unit],{...report(k),verb:"start"},at(i*2));
      await applyReport(s,[unit],{...report(k),verb:"finish",ok:false},at(i*2));
      await runSweep(s,mail,at(i*2+1),"https://synthetic.invalid/");
    }
    expect(await s.consecutiveFailures(unit.id)).toBe(2);expect(sends).toBe(1);
    await runSweep(s,mail,at(18),"https://synthetic.invalid/");expect(sends).toBe(2);
    await runSweep(s,mail,at(33),"https://synthetic.invalid/");expect(sends).toBe(2);
    expect((await db.query("select count(*)::int n from ops_events where kind='alert_sent'")).rows[0].n).toBe(1);
    expect((await db.query("select terminal_outcome from ops_runs order by id")).rows).toEqual([{terminal_outcome:"failed"},{terminal_outcome:"failed"}]);
    await applyReport(s,[unit],{...report("success"),verb:"start"},at(34));
    await applyReport(s,[unit],{...report("success"),verb:"finish",ok:true,evidence:["synthetic"]},at(34));
    expect(await s.consecutiveFailures(unit.id)).toBe(0);
    await runSweep(s,mail,at(35),"https://synthetic.invalid/");expect(sends).toBe(3);
    await runSweep(s,mail,at(36),"https://synthetic.invalid/");expect(sends).toBe(3);
  });
  it("retains one owed alert across full capacity and a newer run, then admits it after cleanup",async()=>{
    const s=actualStore();let sends=0;const mail={envelope,send:async()=>{sends++;return {ok:true as const,id:"accepted"};}};
    await db.query("update ops_units set tolerance=1");
    await db.query("insert into ops_alert_outbox(unit_id,logical_key,kind,to_state,subject,body,created_at,next_attempt_at,state,finished_at) select 'synthetic','seed:'||n,'alert','failed','synthetic','synthetic',$1,$1,'accepted',$1 from generate_series(1,200) n",[now]);
    await applyReport(s,[unit],{...report("owed"),verb:"start"},now);
    const finished=await applyReport(s,[unit],{...report("owed"),verb:"finish",ok:false},now);
    const full=await runSweep(s,mail,at(1),"https://synthetic.invalid/");expect(full.unavailable).toContain(unit.id);expect(sends).toBe(0);
    expect(await s.deliveryStatus!(unit.id)).toBe("outbox_capacity");
    await applyReport(s,[unit],{...report("newer"),verb:"start"},at(2));
    await applyReport(s,[unit],{...report("newer"),verb:"finish",ok:true,evidence:["synthetic"]},at(2));
    await runSweep(s,mail,at(3),"https://synthetic.invalid/");
    await db.query("update ops_alert_outbox set finished_at=$1::timestamptz-interval '31 days' where logical_key='seed:1'",[now]);
    await runSweep(s,mail,at(4),"https://synthetic.invalid/");
    expect(sends).toBe(1);
    const row=(await db.query("select run_id,to_state,created_at from ops_alert_outbox where logical_key not like 'seed:%'")).rows[0];
    expect(row.run_id).toBe(String(finished.ok&&finished.run.id));expect(row.to_state).toBe("failed");expect(row.created_at.toISOString()).toBe(at(1).toISOString());
    expect((await db.query("select count(*)::int n from ops_alert_outbox")).rows[0].n).toBe(200);
  });
  it("concurrent sweeps deduplicate intent and claims while a lost response retries the same provider request",async()=>{
    const s=actualStore();await db.query("update ops_units set tolerance=1");
    await rpc(db,report("failure"));await rpc(db,report("failure","finish",{ok:false}));
    const accepted=new Map<string,string>();let calls=0;const bodies:string[]=[];
    const mail={envelope,send:async(subject:string,text:string,frozen?:{key:string;from:string;to:string})=>{
      calls++;bodies.push(JSON.stringify({subject,text,...frozen}));accepted.set(frozen!.key,"provider-id");
      if(calls===1)throw new Error("synthetic lost response");return {ok:true as const,id:"provider-id"};
    }};
    await Promise.all([runSweep(s,mail,at(1),"https://synthetic.invalid/"),runSweep(s,mail,at(1),"https://synthetic.invalid/")]);
    expect((await db.query("select count(*)::int n from ops_alert_outbox")).rows[0].n).toBe(1);expect(calls).toBe(1);
    await runSweep(s,{...mail,envelope:{...envelope,from:"rotated@example.com",to:"rotated-to@example.com"}},at(16),"https://synthetic.invalid/");
    expect(calls).toBe(2);expect(accepted.size).toBe(1);expect(bodies[1]).toBe(bodies[0]);
  });
  it("fences stale mail tokens, preserves first-send time, and refuses expired provider-window retries",async()=>{
    const s=actualStore();await db.query("update ops_units set tolerance=1");
    await rpc(db,report("failure"));await rpc(db,report("failure","finish",{ok:false}));
    const snap=await s.sweepSnapshot!(unit.id);await s.recordSweep!(unit.id,snap!.token,"failed",{kind:"alert",subject:"synthetic",text:"synthetic"},now);
    const claim=async(c:Client,t:Date)=>(await c.query("select ops_alert_claim($1,$2) value",[t,envelope])).rows[0].value;
    const claims=await Promise.all([claim(db,now),claim(other,now)]);expect(claims.filter(Boolean)).toHaveLength(1);
    const first=claims.find(Boolean),second=await claim(db,at(2));
    expect(second.provider_key).toBe(first.provider_key);expect(second.first_claim_at).toBe(first.first_claim_at);expect(second.claim_token).not.toBe(first.claim_token);
    expect(await s.completeAlert!(first.id,first.claim_token,{ok:true,id:"old"},at(2))).toBe("stale");
    const expired=await claim(db,at(23*60));expect(expired.state).toBe("terminal");
    expect(await claim(db,at(24*60))).toBeNull();
    expect((await db.query("select accepted_alert from ops_monitor")).rows[0].accepted_alert).toBe("0");
  });
  it("caps attempts, reports missing configuration unavailable, and never owes recovery for unaccepted mail",async()=>{
    const s=actualStore();await db.query("update ops_units set tolerance=1");await rpc(db,report("failure"));await rpc(db,report("failure","finish",{ok:false}));
    const unavailable=await runSweep(s,null,at(1),"https://synthetic.invalid/");expect(unavailable.paged).toEqual([]);expect(unavailable.unavailable).toContain(unit.id);
    expect((await db.query("select attempts,first_claim_at from ops_alert_outbox")).rows[0]).toEqual({attempts:0,first_claim_at:null});
    let tick=new Date((await db.query("select next_attempt_at from ops_alert_outbox")).rows[0].next_attempt_at);
    for(let i=0;i<6;i++){
      const a=await s.claimAlert!(tick,envelope);expect(a?.state).toBe("sending");
      await s.completeAlert!(a!.id!,a!.claim_token!,{ok:false,status:502,error:"provider_unavailable",retryable:true},tick);
      tick=new Date((await db.query("select next_attempt_at from ops_alert_outbox")).rows[0].next_attempt_at);
    }
    expect(await s.claimAlert!(tick,envelope)).toBeNull();
    expect((await db.query("select state,attempts from ops_alert_outbox")).rows[0]).toEqual({state:"terminal",attempts:6});
    await rpc(db,report("success"),tick);await rpc(db,report("success","finish",{ok:true,evidence:["synthetic"]}),tick);
    await runSweep(s,null,tick,"https://synthetic.invalid/");
    expect((await db.query("select count(*)::int n from ops_alert_outbox where kind='recovery'")).rows[0].n).toBe(0);
  });
  it("keeps RPCs service-only and terminal evidence immutable",async()=>{
    for(const name of ["ops_report_atomic(jsonb,timestamp with time zone)","ops_sweep_snapshot(text)","ops_sweep_record(text,text,text,jsonb,timestamp with time zone)","ops_alert_claim(timestamp with time zone,jsonb)","ops_alert_complete(bigint,uuid,jsonb,timestamp with time zone)"]){
      expect((await db.query("select has_function_privilege('anon',$1,'execute') anon,has_function_privilege('authenticated',$1,'execute') auth,has_function_privilege('service_role',$1,'execute') service",[name])).rows[0]).toEqual({anon:false,auth:false,service:true});
    }
    await db.query("set role service_role");try{expect(await rpc(db,report("service"))).toMatchObject({ok:true});}finally{await db.query("reset role");}
    await rpc(db,report("service","finish",{ok:false}));
    await expect(db.query("update ops_runs set terminal_outcome='succeeded',evidence='[\"fake\"]'")).rejects.toThrow(/immutable/);
    await db.query("set role anon");try{await expect(db.query("select * from ops_alert_outbox")).rejects.toThrow(/permission denied/);}finally{await db.query("reset role");}
  });
  it("acknowledgment and pause suppress pending delivery without altering outcomes",async()=>{
    const s=actualStore();await db.query("update ops_units set tolerance=1");await rpc(db,report("failure"));await rpc(db,report("failure","finish",{ok:false}));
    await runSweep(s,null,at(1),"https://synthetic.invalid/");
    await db.query("insert into ops_events(unit_id,actor,kind,at,body) values('synthetic','operator','snooze',$1,$2)",[at(2),{until:at(120).toISOString()}]);
    expect(await s.claimAlert!(at(30),envelope)).toBeNull();
    await db.query("update ops_units set paused_until=$1",[at(180)]);
    expect(await s.claimAlert!(at(150),envelope)).toBeNull();
    // A sweep may have cached a silenced visual state. Delivery must use the current clock,
    // not wait for this unit to be observed again before honoring expiry.
    await runSweep(s,null,at(150),"https://synthetic.invalid/");
    expect(await s.claimAlert!(at(181),envelope)).toMatchObject({state:"sending"});
    expect(await s.consecutiveFailures(unit.id)).toBe(1);
  });
  it("keeps the accepted status truthful after terminal payload pruning",async()=>{
    const s=actualStore();await db.query("update ops_units set tolerance=1");await rpc(db,report("failure"));await rpc(db,report("failure","finish",{ok:false}));
    await runSweep(s,{envelope,send:async()=>({ok:true,id:"accepted"})},at(1),"https://synthetic.invalid/");
    await db.query("delete from ops_alert_outbox where state='accepted'");
    expect(await s.deliveryStatus!(unit.id)).toBe("provider_accepted");
  });
  it("deduplicates overlapping same-key starts and terminal replays without changing the outcome counter",async()=>{
    const starts=await Promise.all([rpc(db,report("same")),rpc(other,report("same"))]);
    expect(starts.map(r=>r.run.id)).toEqual([starts[0].run.id,starts[0].run.id]);expect(starts.filter(r=>r.replay)).toHaveLength(1);
    const finishes=await Promise.all([rpc(db,report("same","finish",{ok:false})),rpc(other,report("same","finish",{ok:false}))]);
    expect(finishes.filter(r=>r.replay)).toHaveLength(1);
    expect(await rpc(db,report("same","finish",{ok:true,evidence:["changed replay"]}))).toMatchObject({replay:true,run:{terminal_outcome:"failed",evidence:[]}});
    expect((await db.query("select failures from ops_monitor")).rows[0].failures).toBe(1);
    expect((await db.query("select kind,count(*)::int n from ops_events group by kind order by kind")).rows).toEqual([{kind:"finish",n:1},{kind:"start",n:1}]);
  });
  it("compares overlapping native sweep snapshots before admitting one alert",async()=>{
    await rpc(db,report("failure"));await rpc(db,report("failure","finish",{ok:false}));
    const snapshot=(await db.query("select ops_sweep_snapshot('synthetic') value")).rows[0].value;
    const record=(c:Client)=>c.query("select ops_sweep_record($1,$2,$3,$4,$5) value",[unit.id,snapshot.token,"failed",{kind:"alert",subject:"s",text:"t"},now]);
    const results=await Promise.all([record(db),record(other)]);
    expect(results.map(r=>r.rows[0].value.state).sort()).toEqual(["conflict","recorded"]);
    expect((await db.query("select count(*)::int n from ops_alert_outbox")).rows[0].n).toBe(1);
  });
  it("keeps pending A acknowledged after live B starts without silencing B's own alert",async()=>{
    const s=actualStore();await db.query("update ops_units set tolerance=1");
    const a=await rpc(db,report("A"));await rpc(db,report("A","finish",{ok:false}));
    let snap=await s.sweepSnapshot!(unit.id);
    await s.recordSweep!(unit.id,snap!.token,"failed",{kind:"alert",subject:"A",text:"A"},now);
    await db.query("insert into ops_events(unit_id,actor,kind,at,body) values('synthetic','operator','ack',$1,'{}')",[at(2)]);
    const b=await rpc(db,report("B"),at(3));
    expect(await s.claimAlert!(at(3),envelope)).toBeNull();
    await rpc(db,report("B","finish",{ok:false}),at(3));
    snap=await s.sweepSnapshot!(unit.id);
    await s.recordSweep!(unit.id,snap!.token,"failed",{kind:"alert",subject:"B",text:"B"},at(4));
    const claim=await s.claimAlert!(at(4),envelope);
    expect(claim).toMatchObject({state:"sending",subject:"B"});
    expect((await db.query("select state from ops_alert_outbox where run_id=$1",[a.run.id])).rows[0].state).toBe("pending");
    expect((await db.query("select run_id from ops_alert_outbox where id=$1",[claim!.id])).rows[0].run_id).toBe(String(b.run.id));
  });
  it("owes fresh recovery when delayed A is accepted after B and B's recovery, even after pruning",async()=>{
    const s=actualStore();await db.query("update ops_units set tolerance=1");
    await rpc(db,report("A"));await rpc(db,report("A","finish",{ok:false}));
    let snap=await s.sweepSnapshot!(unit.id);
    await s.recordSweep!(unit.id,snap!.token,"failed",{kind:"alert",subject:"A",text:"A"},now);
    let a;
    for(const minute of [0,1,5]){
      a=await s.claimAlert!(at(minute),envelope);
      await s.completeAlert!(a!.id!,a!.claim_token!,{ok:false,status:502,error:"provider_unavailable",retryable:true},at(minute));
    }
    await rpc(db,report("B"),at(6));await rpc(db,report("B","finish",{ok:false}),at(6));
    snap=await s.sweepSnapshot!(unit.id);
    await s.recordSweep!(unit.id,snap!.token,"failed",{kind:"alert",subject:"B",text:"B"},at(6));
    const b=await s.claimAlert!(at(6),envelope);expect(b?.subject).toBe("B");
    await s.completeAlert!(b!.id!,b!.claim_token!,{ok:true,id:"accepted-B"},at(6));
    await rpc(db,report("success"),at(7));await rpc(db,report("success","finish",{ok:true,evidence:["synthetic"]}),at(7));
    const mail={envelope,send:vi.fn(async()=>({ok:true as const,id:"recovery"}))};
    await runSweep(s,mail,at(8),"https://synthetic.invalid/");expect(mail.send).toHaveBeenCalledTimes(1);
    let monitor=(await s.sweepSnapshot!(unit.id))!.monitor;expect(monitor.accepted_alert).toBe(monitor.recovered_alert);
    await db.query("delete from ops_alert_outbox where state='accepted'");
    const delayed=await s.claimAlert!(at(21),envelope);expect(delayed?.id).toBe(a!.id);
    await s.completeAlert!(delayed!.id!,delayed!.claim_token!,{ok:true,id:"accepted-A-late"},at(21));
    monitor=(await s.sweepSnapshot!(unit.id))!.monitor;
    expect(monitor.accepted_alert).toBeGreaterThan(monitor.recovered_alert);
    const receipt=(await db.query("select id from ops_events where kind='alert_sent' and body->>'id'='accepted-A-late'")).rows[0];
    expect(String(monitor.accepted_alert)).toBe(receipt.id);
    await runSweep(s,mail,at(22),"https://synthetic.invalid/");expect(mail.send).toHaveBeenCalledTimes(2);
    await runSweep(s,mail,at(23),"https://synthetic.invalid/");expect(mail.send).toHaveBeenCalledTimes(2);
    expect(await s.completeAlert!(delayed!.id!,delayed!.claim_token!,{ok:true,id:"accepted-A-late"},at(23))).toBe("stale");
  });
  it("preserves run-less acknowledgment and lets an expiring snooze unblock its pending alert",async()=>{
    const s=actualStore();await db.query("update ops_units set kind='item',period_s=null");
    const snap=await s.sweepSnapshot!(unit.id);
    await s.recordSweep!(unit.id,snap!.token,"needs_you",{kind:"alert",subject:"run-less",text:"run-less"},now);
    await db.query("insert into ops_events(unit_id,actor,kind,at,body) values('synthetic','operator','ack',$1,'{}')",[at(1)]);
    expect(await s.claimAlert!(at(2),envelope)).toBeNull();
    await db.query("insert into ops_events(unit_id,actor,kind,at,body) values('synthetic','operator','snooze',$1,$2)",[at(3),{until:at(5).toISOString()}]);
    expect(await s.claimAlert!(at(4),envelope)).toBeNull();
    expect(await s.claimAlert!(at(6),envelope)).toMatchObject({state:"sending",subject:"run-less"});
  });
});
