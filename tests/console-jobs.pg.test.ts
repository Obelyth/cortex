import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { Client } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it,vi } from "vitest";
import {consoleJobStore,__setConsoleJobStore} from "../lib/console-job-store";
import {prepareProviderJob,requestProviderJob,reconcileProviderJob} from "../lib/console-job-providers";

const socket = process.env.CORTEX_NATIVE_PG_SOCKET ?? "";
const port = Number(process.env.CORTEX_NATIVE_PG_PORT ?? 5432);
const config = { host: socket, port, user: "cortex_test", database: "postgres" };
const database = `cortex_test_console_jobs_${process.pid}_${Date.now()}`;
let db: Client, other: Client, created = false;
const fingerprint = (char = "a") => char.repeat(64);
const execution={provider:"github",repository:"fixture/app",branch:"main",project:null,team:null,pendingDigest:null};
async function providerEnqueue(client:Client,op="checks",target="github:fixture/app",key=randomUUID(),ack:string|null=null,expiry=new Date(Date.now()+240000).toISOString()){
  return (await client.query("select console_job_enqueue_provider($1,$2,$3,$4,$5,$6,$7,$8) value",[key,fingerprint(),op,target,"b".repeat(40),execution,expiry,ack])).rows[0].value;
}
async function enqueue(client: Client, operation:string = "diagnostics", target:string = randomUUID(), key:string = randomUUID(), fp:string = fingerprint()) {
  return (await client.query("select console_job_enqueue($1,$2,$3,$4,null) value", [key, fp, operation, target])).rows[0].value;
}

// VISIBLE, not silent. A gated suite that skips itself shrinks the count and says nothing, so a
// run with no database looked identical to a run that had checked everything — for a month.
if (process.env.CORTEX_NATIVE_PG !== "1") {
  describe.skip("native console job admission — SKIPPED: set CORTEX_NATIVE_PG=1 and CORTEX_NATIVE_PG_SOCKET to a Unix socket directory", () => {
    it("did not run", () => {});
  });
}
describe.runIf(process.env.CORTEX_NATIVE_PG === "1")("native console job admission", () => {
  beforeAll(async () => {
    if (!socket.startsWith("/")) throw new Error("explicit native socket required");
    const admin = new Client(config); await admin.connect(); await admin.query(`create database ${database}`); created = true; await admin.end();
    db = new Client({ ...config, database }); other = new Client({ ...config, database }); await db.connect(); await other.connect();
    await db.query(`do $$ begin create role anon nologin; exception when duplicate_object then null; end $$;
      do $$ begin create role authenticated nologin; exception when duplicate_object then null; end $$;
      do $$ begin create role service_role nologin; exception when duplicate_object then null; end $$;`);
    await db.query(await readFile("supabase/migrations/20260908160000_console_jobs.sql", "utf8"));
    await db.query(await readFile("supabase/migrations/20260908163000_console_job_claim_recovery.sql", "utf8"));
    await db.query(await readFile("supabase/migrations/20260908205956_console_job_providers.sql", "utf8"));
    await db.query(await readFile("supabase/migrations/20260908221155_console_job_provider_fences.sql", "utf8"));
    await db.query(await readFile("supabase/migrations/20260909041000_console_job_recovery_exits.sql", "utf8"));
    await db.query(await readFile("supabase/migrations/20260909043000_console_job_guard_invariant.sql", "utf8"));
  });
  afterAll(async () => {
    if (!created) return;
    await db?.end(); await other?.end();
    const admin = new Client(config); await admin.connect(); await admin.query(`drop database ${database}`); await admin.end();
  });
  afterEach(()=>{vi.unstubAllGlobals();vi.unstubAllEnvs();__setConsoleJobStore(undefined);});
  beforeEach(async () => {
    await db.query("truncate public.console_jobs cascade");
    await db.query("insert into public.console_job_mutation_guard(singleton,job_id) values(true,null) on conflict(singleton) do update set job_id=null");
  });

  it("atomically replays an identical key and rejects changed input", async () => {
    const key = randomUUID();
    const [a, b] = await Promise.all([enqueue(db, "diagnostics", "deployment", key), enqueue(other, "diagnostics", "deployment", key)]);
    expect(a.job.id).toBe(b.job.id);
    expect([a.outcome, b.outcome].sort()).toEqual(["enqueued", "replay"]);
    expect((await enqueue(db, "diagnostics", "deployment", key, fingerprint("b"))).outcome).toBe("key_conflict");
    expect((await db.query("select count(*)::int n from console_jobs")).rows[0].n).toBe(1);
  });

  it("enforces the deployment-wide active cap under concurrent admission", async () => {
    for (let i = 0; i < 19; i++) expect((await enqueue(db, "diagnostics", `target-${i}`)).outcome).toBe("enqueued");
    const result = await Promise.all([enqueue(db, "checks", "edge-a"), enqueue(other, "checks", "edge-b")]);
    expect(result.map((value) => value.outcome).sort()).toEqual(["capacity", "enqueued"]);
    expect((await db.query("select count(*)::int n from console_jobs where state in ('queued','running')")).rows[0].n).toBe(20);
  });

  it("claims exactly once and fences publication by token", async () => {
    const admitted = await enqueue(db);
    const id = admitted.job.id;
    const [a, b] = await Promise.all([db.query("select console_job_claim($1) value", [id]), other.query("select console_job_claim($1) value", [id])]);
    const values = [a.rows[0].value, b.rows[0].value];
    expect(values.map((value) => value.outcome).sort()).toEqual(["claimed", "not_claimed"]);
    const claim = values.find((value) => value.outcome === "claimed");
    expect((await db.query("select console_job_publish($1,$2,'succeeded',$3,null,null) value",[id,claim.token,{checks:[{name:"x",state:"invented",detail:"bad"}],summary:"invalid"}])).rows[0].value.outcome).toBe("invalid");
    const stale = (await db.query("select console_job_publish($1,$2,'succeeded',$3,null,null) value", [id, randomUUID(), { checks: [], summary: "wrong worker" }])).rows[0].value;
    expect(stale.outcome).toBe("stale"); expect(stale.job.state).toBe("running");
    const done = (await db.query("select console_job_publish($1,$2,'succeeded',$3,null,null) value", [id, claim.token, { checks: [], summary: "complete" }])).rows[0].value;
    expect(done.outcome).toBe("published"); expect(done.job.state).toBe("succeeded");
    expect((await db.query("select console_job_publish($1,$2,'failed',$3,null,null) value", [id, claim.token, { checks: [], summary: "late" }])).rows[0].value.outcome).toBe("stale");
  });
  it("retains a provider acceptance as running with its dispatch fence and mutation guard",async()=>{
    const admitted=await enqueue(db,"deploy.preview","provider-target"),id=admitted.job.id;
    const claim=(await db.query("select console_job_claim($1,$2) value",[id,randomUUID()])).rows[0].value;
    const result=(await db.query("select console_job_publish($1,$2,'running',$3,'dpl_fixture',null) value",[id,claim.token,{checks:[],summary:"Accepted"}])).rows[0].value;
    expect(result.outcome).toBe("published");expect(result.job.state).toBe("running");expect(result.job.dispatch_token).toBe(claim.token);
    expect((await enqueue(other,"migrations.apply","other")).outcome).toBe("mutation_busy");
  });
  it("atomically consumes a prepared identity once and replays an admitted expired intent without admission",async()=>{
    const key=randomUUID();const values=await Promise.all([providerEnqueue(db,"checks","github:fixture/app",key),providerEnqueue(other,"checks","github:fixture/app",key)]);
    expect(values.map(v=>v.outcome).sort()).toEqual(["enqueued","replay"]);expect(values[0].job.id).toBe(values[1].job.id);expect(values[0].job.execution_context).toEqual(execution);
    expect((await providerEnqueue(db,"checks","github:fixture/app",key,null,"2000-01-01T00:00:00Z")).outcome).toBe("replay");
    expect((await providerEnqueue(db,"checks","github:another",randomUUID(),null,"2000-01-01T00:00:00Z")).outcome).toBe("conflict");
    expect((await db.query("select count(*)::int n from console_jobs")).rows[0].n).toBe(1);
  });
  it.each(["legacy","owned"])("refuses queued dispatch after expiry crosses while the %s claim waits for its row lock",async(kind)=>{
    const admitted=await providerEnqueue(db,"deploy.preview","vercel:prj_fixture:preview",randomUUID(),null,new Date(Date.now()+200).toISOString());
    await db.query("begin");await db.query("select id from console_jobs where id=$1 for update",[admitted.job.id]);
    const pending=other.query(kind==="legacy"?"select console_job_claim($1) value":"select console_job_claim($1,$2) value",kind==="legacy"?[admitted.job.id]:[admitted.job.id,randomUUID()]);
    try{await db.query("select pg_sleep(0.25)");}finally{await db.query("commit");}
    const result=(await pending).rows[0].value;expect(result.outcome).toBe("not_claimed");expect(result.job.state).toBe("queued");
    expect((await enqueue(db,"migrations.apply","another")).outcome).toBe("mutation_busy");
  });
  it("keeps a healthy observer's ownership beyond the five-second admission throttle",async()=>{
    const admitted=await providerEnqueue(db);await db.query("select console_job_claim($1,$2)",[admitted.job.id,randomUUID()]);
    const first=(await db.query("select console_job_reconcile_claim($1) value",[admitted.job.id])).rows[0].value;
    await db.query("update console_jobs set last_polled_at=now()-interval '6 seconds' where id=$1",[admitted.job.id]);
    const second=(await other.query("select console_job_reconcile_claim($1) value",[admitted.job.id])).rows[0].value;
    expect(second.outcome).toBe("not_claimed");
    const completed=(await db.query("select console_job_reconcile_publish($1,$2,$3,'succeeded',$4,'123') value",[admitted.job.id,first.token,first.pollToken,{checks:[],summary:"Healthy slow lookup"}])).rows[0].value;
    expect(completed.outcome).toBe("published");expect(completed.job.state).toBe("succeeded");
  });
  it("preserves original expiry and same-owner recovery while refusing unproven legacy queued work",async()=>{
    const original=new Date(Date.now()+60000).toISOString(),key=randomUUID();const admitted=await providerEnqueue(db,"checks","original",key,null,original);
    const replay=await providerEnqueue(db,"checks","original",key,null,new Date(Date.now()+240000).toISOString());
    expect(new Date(replay.job.intent_expires_at).toISOString()).toBe(original);
    const owner=randomUUID(),claimed=(await db.query("select console_job_claim($1,$2) value",[admitted.job.id,owner])).rows[0].value;
    await db.query("update console_jobs set intent_expires_at=now()-interval '1 second' where id=$1",[admitted.job.id]);
    expect((await db.query("select console_job_claim($1,$2) value",[admitted.job.id,owner])).rows[0].value.token).toBe(claimed.token);
    const legacy=await enqueue(db,"checks","legacy-queued");await db.query("update console_jobs set execution_context=$2 where id=$1",[legacy.job.id,execution]);
    expect((await db.query("select console_job_claim($1,$2) value",[legacy.job.id,randomUUID()])).rows[0].value.outcome).toBe("not_claimed");
    expect((await db.query("select console_job_mark_uncertain($1) value",[legacy.job.id])).rows[0].value.outcome).toBe("marked_uncertain");
  });
  it("fences expired observer publication and stale release without changing the mutation guard",async()=>{
    const admitted=await providerEnqueue(db,"deploy.preview","vercel:prj_fixture:preview"),id=admitted.job.id;
    await db.query("select console_job_claim($1,$2)",[id,randomUUID()]);
    const old=(await db.query("select console_job_reconcile_claim($1) value",[id])).rows[0].value;
    await db.query("update console_jobs set last_polled_at=now()-interval '101 seconds',poll_expires_at=now()-interval '1 second' where id=$1",[id]);
    expect((await db.query("select console_job_reconcile_publish($1,$2,$3,'succeeded',$4,'dpl_fixture') value",[id,old.token,old.pollToken,{checks:[],summary:"too late"}])).rows[0].value.outcome).toBe("stale");
    const fresh=(await other.query("select console_job_reconcile_claim($1) value",[id])).rows[0].value;
    expect((await db.query("select console_job_reconcile_release($1,$2) value",[id,old.pollToken])).rows[0].value).toEqual({released:false});
    expect((await db.query("select poll_token from console_jobs where id=$1",[id])).rows[0].poll_token).toBe(fresh.pollToken);
    expect((await enqueue(db,"migrations.apply","another")).outcome).toBe("mutation_busy");
    expect((await db.query("select console_job_reconcile_release($1,$2) value",[id,fresh.pollToken])).rows[0].value).toEqual({released:true});
    expect((await db.query("select job_id from console_job_mutation_guard")).rows[0].job_id).toBe(id);
  });
  it("publishes a healthy 6.2-second provider lookup despite another client's five-second poll",async()=>{
    const ctx={provider:"vercel",repository:"fixture/app",branch:"main",project:"prj_fixture",team:null,pendingDigest:null};
    const admitted=await providerEnqueue(db,"deploy.preview","vercel:prj_fixture:preview"),id=admitted.job.id;
    await db.query("update console_jobs set execution_context=$2,provider_id='dpl_fixture' where id=$1",[id,ctx]);await db.query("select console_job_claim($1,$2)",[id,randomUUID()]);
    vi.stubEnv("SUPABASE_URL","https://store.synthetic.invalid");vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY","synthetic-service");
    vi.stubGlobal("fetch",async(url:string,init?:RequestInit)=>{
      const path=new URL(url).pathname.replace("/rest/v1/","");
      if(path==="console_jobs")return Response.json((await db.query("select * from console_jobs where id=$1",[id])).rows);
      const b=JSON.parse(init!.body as string);const calls:Record<string,[string,unknown[]]>={
        "rpc/console_job_reconcile_claim":["select console_job_reconcile_claim($1) value",[b.job_id]],
        "rpc/console_job_reconcile_publish":["select console_job_reconcile_publish($1,$2,$3,$4,$5,$6) value",[b.job_id,b.claim_token,b.poll_owner,b.completion_state,b.result_value,b.provider_identity]],
        "rpc/console_job_reconcile_release":["select console_job_reconcile_release($1,$2) value",[b.job_id,b.poll_owner]],
      };const call=calls[path];if(!call)throw new Error("Unexpected native RPC");return Response.json((await other.query(call[0],call[1])).rows[0].value);
    });
    let reads=0,posts=0;let started!:()=>void;const ready=new Promise<void>(r=>{started=r;});
    const fetcher=async(_url:string,init?:RequestInit)=>{if(init?.method==="POST")posts++;reads++;started();await new Promise(r=>setTimeout(r,6200));return Response.json({id:"dpl_fixture",projectId:"prj_fixture",gitSource:{type:"github",org:"fixture",repo:"app",ref:"main",sha:"b".repeat(40)},meta:{cortex_job_id:id},target:null,readyState:"READY"});};
    const env={CORTEX_APP_REPO:"fixture/app",CORTEX_APP_BRANCH:"main",CORTEX_ACTIONS_TOKEN:"synthetic-actions",CORTEX_VERCEL_TOKEN:"synthetic-vercel",CORTEX_VERCEL_PROJECT_ID:"prj_fixture"};
    const first=reconcileProviderJob(id,{store:consoleJobStore()!,env,fetcher});await ready;await new Promise(r=>setTimeout(r,5100));
    const second=await reconcileProviderJob(id,{store:consoleJobStore()!,env,fetcher});expect(second.job.state).toBe("running");
    expect((await first).job.state).toBe("succeeded");expect(reads).toBe(1);expect(posts).toBe(0);
    expect((await db.query("select poll_token from console_jobs where id=$1",[id])).rows[0].poll_token).toBeNull();
    expect((await db.query("select job_id from console_job_mutation_guard")).rows[0].job_id).toBeNull();
  },10000);
  it("requires the explicit previous-unresolved identity for a new mutation after acknowledgement",async()=>{
    const first=await providerEnqueue(db,"deploy.preview","vercel:prj_fixture:preview");
    const claim=(await db.query("select console_job_claim($1,$2) value",[first.job.id,randomUUID()])).rows[0].value;
    await db.query("select console_job_publish($1,$2,'uncertain',$3,null,null)",[first.job.id,claim.token,{checks:[],summary:"Unknown"}]);
    await db.query("select console_job_acknowledge_uncertain($1)",[first.job.id]);
    expect((await providerEnqueue(db,"deploy.production","vercel:prj_fixture:production")).outcome).toBe("conflict");
    const next=await providerEnqueue(db,"deploy.production","vercel:prj_fixture:production",randomUUID(),first.job.id);expect(next.outcome).toBe("enqueued");
    await db.query("select console_job_publish($1,$2,'succeeded',$3,'dpl_first',null)",[first.job.id,claim.token,{checks:[],summary:"Late verified result"}]);
    expect((await db.query("select job_id from console_job_mutation_guard")).rows[0].job_id).toBe(next.job.id);
  });
  it.each(["recovery","claim"])("fences queued-provider recovery against dispatch when %s wins the row lock",async(first)=>{
    const admitted=await providerEnqueue(db,"deploy.preview","vercel:prj_fixture:preview"),id=admitted.job.id,owner=randomUUID();
    const recover="select console_job_mark_uncertain($1) value",claim="select console_job_claim($1,$2) value";
    await db.query("begin");
    const winner=(await db.query(first==="recovery"?recover:claim,first==="recovery"?[id]:[id,owner])).rows[0].value;
    const competitor=other.query(first==="recovery"?claim:recover,first==="recovery"?[id,owner]:[id]);
    try{
      const pid=(await db.query("select pid from pg_stat_activity where datname=current_database() and pid<>pg_backend_pid() limit 1")).rows[0].pid;
      let blocked=false;
      for(let n=0;n<100&&!blocked;n++)blocked=(await db.query("select wait_event_type='Lock' blocked from pg_stat_activity where pid=$1",[pid])).rows[0].blocked;
      expect(blocked).toBe(true);
    }finally{await db.query("commit");}
    const loser=(await competitor).rows[0].value;
    const row=(await db.query("select * from console_jobs where id=$1",[id])).rows[0];
    expect(row.state).toBe("uncertain");expect(row.execution_context).toEqual(execution);
    if(first==="recovery"){expect(winner.outcome).toBe("marked_uncertain");expect(loser.outcome).toBe("not_claimed");expect(row.dispatch_token).toBeNull();}
    else{expect(winner.outcome).toBe("claimed");expect(loser.outcome).toBe("marked_uncertain");expect(row.dispatch_token).toBe(winner.token);}
    expect((await enqueue(other,"migrations.apply","another")).outcome).toBe("mutation_busy");
    expect((await providerEnqueue(db,"deploy.preview","vercel:prj_fixture:preview",admitted.job.request_key,null,"2000-01-01T00:00:00Z")).job.state).toBe("uncertain");
    await db.query("select console_job_acknowledge_uncertain($1)",[id]);
    // A claim that won left a dispatch token behind, so the run may still finish and the next
    // mutation must name it; a fence that won proves nothing was dispatched, so nothing is named.
    expect((await db.query("select last_unresolved_id from console_job_mutation_guard")).rows[0].last_unresolved_id).toBe(first==="claim"?id:null);
    expect((await providerEnqueue(db,"deploy.production","vercel:prj_fixture:production")).outcome).toBe(first==="claim"?"conflict":"enqueued");
    if(first==="claim")expect((await providerEnqueue(db,"deploy.production","vercel:prj_fixture:production",randomUUID(),id)).outcome).toBe("enqueued");
  });
  it("throttles overlapping reconciliation and fences stale poll publication without dispatch claims",async()=>{
    const admitted=await providerEnqueue(db),id=admitted.job.id;
    await db.query("select console_job_claim($1,$2)",[id,randomUUID()]);
    const values=await Promise.all([db.query("select console_job_reconcile_claim($1) value",[id]),other.query("select console_job_reconcile_claim($1) value",[id])]);
    expect(values.map(v=>v.rows[0].value.outcome).sort()).toEqual(["claimed","not_claimed"]);
    const old=values.map(v=>v.rows[0].value).find(v=>v.outcome==="claimed");
    await db.query("update console_jobs set last_polled_at=now()-interval '101 seconds',poll_expires_at=now()-interval '1 second' where id=$1",[id]);
    const fresh=(await db.query("select console_job_reconcile_claim($1) value",[id])).rows[0].value;
    const stale=(await db.query("select console_job_reconcile_publish($1,$2,$3,'succeeded',$4,'123') value",[id,old.token,old.pollToken,{checks:[],summary:"Old poll"}])).rows[0].value;
    expect(stale.outcome).toBe("stale");expect(stale.job.state).toBe("running");
    expect((await db.query("select console_job_reconcile_publish($1,$2,$3,'succeeded',$4,'123') value",[id,fresh.token,fresh.pollToken,{checks:[],summary:"Verified completion"}])).rows[0].value.job.state).toBe("succeeded");
    await db.query("select console_job_reconcile_release($1,$2)",[id,fresh.pollToken]);
    await db.query("update console_jobs set last_polled_at=now()-interval '6 seconds' where id=$1",[id]);
    const logs=(await db.query("select console_job_reconcile_claim($1) value",[id])).rows[0].value;expect(logs.outcome).toBe("claimed");expect(logs.token).toBeNull();expect(logs.job.state).toBe("succeeded");
  });
  it("reads a complete bounded scalar ledger without bootstrapping and refuses overcapacity",async()=>{
    expect((await db.query("select console_job_migration_ledger() value")).rows[0].value).toEqual({state:"absent",rows:[]});
    expect((await db.query("select to_regclass('public.schema_migrations') value")).rows[0].value).toBeNull();
    await db.query("create table schema_migrations(name text primary key,checksum text)");
    try{
      await db.query("insert into schema_migrations select lpad(i::text,14,'0')||'_fixture.sql',repeat('a',64) from generate_series(1,650) i");
      expect((await db.query("select console_job_migration_ledger() value")).rows[0].value.rows).toHaveLength(650);
      await db.query("insert into schema_migrations select lpad(i::text,14,'0')||'_fixture.sql',repeat('a',64) from generate_series(651,2001) i");
      await expect(db.query("select console_job_migration_ledger()")).rejects.toThrow("migration ledger unavailable");
    }finally{await db.query("drop table schema_migrations");}
  });
  it("composes real command and REST store with native admission and one lost provider POST",async()=>{
    vi.stubEnv("SUPABASE_URL","https://store.synthetic.invalid");vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY","synthetic-service");
    const env={CORTEX_APP_REPO:"fixture/app",CORTEX_APP_BRANCH:"main",CORTEX_ACTIONS_TOKEN:"synthetic-actions",CONNECTOR_PATH_SECRET:"synthetic-path",CONSOLE_PASSCODE:"synthetic-passcode"};
    let posts=0;
    vi.stubGlobal("fetch",async(url:string,init?:RequestInit)=>{
      if(url.startsWith("https://api.github.com/")){if(init?.method==="POST"){posts++;throw new Error("lost response");}return Response.json({sha:"b".repeat(40)});}
      const path=new URL(url).pathname.replace("/rest/v1/","");
      if(path.startsWith("rpc/")){const body=JSON.parse(init!.body as string);const calls:Record<string,[string,string[]]>={console_job_enqueue_provider:["select console_job_enqueue_provider($1,$2,$3,$4,$5,$6,$7,$8) value",["request_key","input_fingerprint","operation_name","target_name","source_sha","execution_value","expires_at","unresolved_id"]],console_job_claim:["select console_job_claim($1,$2) value",["job_id","owner_token"]],console_job_publish:["select console_job_publish($1,$2,$3,$4,$5,$6) value",["job_id","claim_token","completion_state","result_value","provider_identity","source_sha"]]};const call=calls[path.slice(4)];if(!call)throw new Error("Unexpected RPC");return Response.json((await db.query(call[0],call[1].map(k=>body[k]))).rows[0].value);}
      const params=new URL(url).searchParams;const requestKey=params.get("request_key")?.slice(3);if(!requestKey)throw new Error("Unexpected table read");return Response.json((await db.query("select * from console_jobs where request_key=$1",[requestKey])).rows);
    });
    const actual=consoleJobStore()!,deps={store:actual,env};const key=randomUUID();const prepared=await prepareProviderJob({operation:"checks",requestKey:key},deps);
    const command={operation:"checks",requestKey:key,intent:prepared.intent,confirm:true};
    const first=await requestProviderJob(command,deps),second=await requestProviderJob(command,deps);
    expect(first.state).toBe("uncertain");expect(second.id).toBe(first.id);expect(posts).toBe(1);expect((await db.query("select count(*)::int n from console_jobs")).rows[0].n).toBe(1);
  });

  it("recovers a committed claim only for its durable request owner",async()=>{
    const admitted=await enqueue(db),owner=randomUUID(),otherOwner=randomUUID();
    const first=(await db.query("select console_job_claim($1,$2) value",[admitted.job.id,owner])).rows[0].value;
    expect(first.outcome).toBe("claimed");
    const recovered=(await db.query("select console_job_claim($1,$2) value",[admitted.job.id,owner])).rows[0].value;
    expect(recovered.outcome).toBe("claimed");expect(recovered.token).toBe(first.token);
    const stranger=(await db.query("select console_job_claim($1,$2) value",[admitted.job.id,otherOwner])).rows[0].value;
    expect(stranger.outcome).toBe("not_claimed");expect(stranger).not.toHaveProperty("token");expect(stranger.job.state).toBe("running");
  });

  it("recovers a pre-owner diagnostic receipt without releasing a mutation receipt",async()=>{
    const legacyDiagnostic=await enqueue(db,"diagnostics","legacy-diagnostic");
    const oldDiagnosticClaim=(await db.query("select console_job_claim($1) value",[legacyDiagnostic.job.id])).rows[0].value;
    expect(oldDiagnosticClaim.outcome).toBe("claimed");
    const refusedDiagnostic=(await db.query("select console_job_claim($1,$2) value",[legacyDiagnostic.job.id,randomUUID()])).rows[0].value;
    expect(refusedDiagnostic.outcome).toBe("not_claimed");expect(refusedDiagnostic.job.state).toBe("running");
    const recovered=(await db.query("select console_job_mark_uncertain($1) value",[legacyDiagnostic.job.id])).rows[0].value;
    expect(recovered.outcome).toBe("marked_uncertain");expect(recovered.job.state).toBe("uncertain");expect(recovered.job.check_count).toBe(1);
    expect((await enqueue(db,"diagnostics","legacy-diagnostic")).outcome).toBe("enqueued");

    const legacyMutation=await enqueue(db,"deploy.production","legacy-mutation");
    expect((await db.query("select console_job_claim($1) value",[legacyMutation.job.id])).rows[0].value.outcome).toBe("claimed");
    const refused=(await db.query("select console_job_claim($1,$2) value",[legacyMutation.job.id,randomUUID()])).rows[0].value;
    expect(refused.outcome).toBe("not_claimed");expect(refused.job.state).toBe("running");
    const marked=(await db.query("select console_job_mark_uncertain($1) value",[legacyMutation.job.id])).rows[0].value;
    expect(marked.outcome).toBe("marked_uncertain");expect(marked.job.state).toBe("uncertain");expect(marked.job.dispatch_token).toBeTruthy();
    expect((await enqueue(db,"migrations.apply","other-mutation")).outcome).toBe("mutation_busy");
  });

  it("retains the global mutation guard across uncertainty until token reconciliation or explicit acknowledgment", async () => {
    const admitted = await enqueue(db, "migrations.apply", "primary");
    const claim = (await db.query("select console_job_claim($1) value", [admitted.job.id])).rows[0].value;
    const uncertain = (await db.query("select console_job_publish($1,$2,'uncertain',$3,null,null) value", [admitted.job.id, claim.token, { checks: [], summary: "provider receipt missing" }])).rows[0].value;
    expect(uncertain.job.state).toBe("uncertain");
    expect((await enqueue(db, "deploy.production", "production")).outcome).toBe("mutation_busy");
    expect((await enqueue(db, "diagnostics", "deployment")).outcome).toBe("enqueued");
    expect((await db.query("select console_job_claim($1) value", [admitted.job.id])).rows[0].value.outcome).toBe("not_claimed");
    expect((await db.query("select console_job_publish($1,$2,'succeeded',$3,'provider-7',null) value",[admitted.job.id,claim.token,{checks:[],summary:"reconciled"}])).rows[0].value.job.state).toBe("succeeded");
    const deploy=await enqueue(db, "deploy.production", "production");expect(deploy.outcome).toBe("enqueued");
    const deployClaim=(await db.query("select console_job_claim($1) value",[deploy.job.id])).rows[0].value;
    await db.query("select console_job_publish($1,$2,'uncertain',$3,null,null)",[deploy.job.id,deployClaim.token,{checks:[],summary:"still unresolved"}]);
    expect((await enqueue(db,"migrations.apply","secondary")).outcome).toBe("mutation_busy");
    expect((await db.query("select console_job_acknowledge_uncertain($1) value", [deploy.job.id])).rows[0].value.outcome).toBe("acknowledged");
    expect((await enqueue(db,"migrations.apply","secondary")).outcome).toBe("enqueued");
  });

  it("fences a queued receipt whose request never claimed it, names it to the next admission, then frees its slot",async()=>{
    const stuck=await enqueue(db,"diagnostics","deployment");
    const blocked=await enqueue(other,"diagnostics","deployment");expect(blocked.outcome).toBe("active");expect(blocked.job.id).toBe(stuck.job.id);
    const marked=(await db.query("select console_job_mark_uncertain($1) value",[stuck.job.id])).rows[0].value;
    expect(marked.outcome).toBe("marked_uncertain");expect(marked.job.state).toBe("uncertain");expect(marked.job.dispatch_token).toBeNull();expect(marked.job.claim_owner).toBeNull();expect(marked.job.check_count).toBe(1);expect(marked.job.summary).toContain("never claimed it");
    expect((await db.query("select console_job_acknowledge_uncertain($1) value",[stuck.job.id])).rows[0].value.outcome).toBe("acknowledged");
    expect((await db.query("select job_id,last_unresolved_id from console_job_mutation_guard")).rows[0]).toEqual({job_id:null,last_unresolved_id:null});
    expect((await enqueue(db,"diagnostics","deployment")).outcome).toBe("enqueued");
    expect((await db.query("select console_job_mark_uncertain($1) value",[stuck.job.id])).rows[0].value.outcome).toBe("not_running");
    // A legacy mutation admitted through the plain path keeps its guard until explicit acknowledgment.
    const mutation=await enqueue(db,"deploy.production","legacy-plain");
    const fenced=(await db.query("select console_job_mark_uncertain($1) value",[mutation.job.id])).rows[0].value;
    expect(fenced.outcome).toBe("marked_uncertain");expect(fenced.job.summary).toContain("acknowledge to release the mutation slot");
    expect((await enqueue(db,"migrations.apply","other")).outcome).toBe("mutation_busy");
    expect((await db.query("select console_job_acknowledge_uncertain($1) value",[mutation.job.id])).rows[0].value.outcome).toBe("acknowledged");
    // Nothing was dispatched, so the release names nothing: the next mutation needs no citation.
    expect((await db.query("select job_id,last_unresolved_id from console_job_mutation_guard")).rows[0]).toEqual({job_id:null,last_unresolved_id:null});
    expect((await providerEnqueue(db,"migrations.apply","supabase:x",randomUUID(),mutation.job.id)).outcome).toBe("conflict");
    expect((await providerEnqueue(db,"migrations.apply","supabase:x")).outcome).toBe("enqueued");
  });

  it("refuses a NULL claim token on every fenced receipt and keeps the mutation guard",async()=>{
    const admitted=await providerEnqueue(db,"deploy.preview","vercel:prj_fixture:preview");
    await db.query("select console_job_mark_uncertain($1)",[admitted.job.id]);
    expect((await db.query("select console_job_publish($1,null,'succeeded',$2,'dpl_x',null) value",[admitted.job.id,{checks:[],summary:"forged"}])).rows[0].value.outcome).toBe("invalid");
    expect((await db.query("select console_job_reconcile_publish($1,null,$2,'succeeded',$3,'dpl_x') value",[admitted.job.id,randomUUID(),{checks:[],summary:"forged"}])).rows[0].value.outcome).toBe("invalid");
    expect((await db.query("select state from console_jobs where id=$1",[admitted.job.id])).rows[0].state).toBe("uncertain");
    expect((await db.query("select job_id from console_job_mutation_guard")).rows[0].job_id).toBe(admitted.job.id);
    const local=await enqueue(db,"diagnostics","deployment");await db.query("select console_job_claim($1,$2)",[local.job.id,randomUUID()]);await db.query("select console_job_mark_uncertain($1)",[local.job.id]);
    expect((await db.query("select console_job_publish($1,null,'succeeded',$2,null,null) value",[local.job.id,{checks:[],summary:"forged"}])).rows[0].value.outcome).toBe("invalid");
    expect((await db.query("select state from console_jobs where id=$1",[local.job.id])).rows[0].state).toBe("uncertain");
  });

  it("clears the required unresolved id once the acknowledged job reconciles, and answers conflict to a late running status",async()=>{
    const first=await providerEnqueue(db,"deploy.production","vercel:prj_fixture:production");
    const claim=(await db.query("select console_job_claim($1,$2) value",[first.job.id,randomUUID()])).rows[0].value;
    await db.query("select console_job_publish($1,$2,'uncertain',$3,null,null)",[first.job.id,claim.token,{checks:[],summary:"Unknown"}]);
    await db.query("select console_job_acknowledge_uncertain($1)",[first.job.id]);
    const next=await providerEnqueue(db,"deploy.production","vercel:prj_fixture:production",randomUUID(),first.job.id);expect(next.outcome).toBe("enqueued");
    const late=(await db.query("select console_job_publish($1,$2,'running',$3,'dpl_first',null) value",[first.job.id,claim.token,{checks:[],summary:"Provider run in progress"}])).rows[0].value;
    expect(late.outcome).toBe("conflict");expect(late.job.state).toBe("uncertain");expect(late.job.provider_id).toBe("dpl_first");
    expect(late.job.summary).toContain("later deploy.production command now owns");expect(late.job.result.checks[0].detail).toContain(next.job.id);
    expect((await db.query("select state from console_jobs where id=$1",[next.job.id])).rows[0].state).toBe("queued");
    expect((await db.query("select console_job_publish($1,$2,'running',$3,'dpl_first',null) value",[first.job.id,randomUUID(),{checks:[],summary:"forged"}])).rows[0].value.outcome).toBe("stale");
    expect((await db.query("select console_job_publish($1,$2,'succeeded',$3,'dpl_first',null) value",[first.job.id,claim.token,{checks:[],summary:"Late verified result"}])).rows[0].value.job.state).toBe("succeeded");
    expect((await db.query("select job_id,last_unresolved_id from console_job_mutation_guard")).rows[0]).toEqual({job_id:next.job.id,last_unresolved_id:null});
    // The reconciled receipt is no longer the unresolved work a new mutation must name; the
    // only refusal left is the guard that `next` holds.
    expect((await providerEnqueue(db,"deploy.preview","vercel:prj_fixture:preview")).outcome).toBe("mutation_busy");
    const nextClaim=(await db.query("select console_job_claim($1,$2) value",[next.job.id,randomUUID()])).rows[0].value;
    expect((await db.query("select console_job_publish($1,$2,'running',$3,'dpl_next',null) value",[next.job.id,nextClaim.token,{checks:[],summary:"Accepted"}])).rows[0].value).toMatchObject({outcome:"published",job:{state:"running"}});
  });

  it("re-takes the mutation guard when an acknowledged mutation resumes running, so no second mutation can start beside it",async()=>{
    // Acknowledgment released the guard. The previous wrapper put the row back to running and left
    // the guard free, so a mutation on another target could be admitted and claimed alongside it.
    const first=await providerEnqueue(db,"deploy.preview","vercel:prj_fixture:preview");
    const claim=(await db.query("select console_job_claim($1,$2) value",[first.job.id,randomUUID()])).rows[0].value;
    await db.query("select console_job_publish($1,$2,'uncertain',$3,'dpl_first',null)",[first.job.id,claim.token,{checks:[],summary:"lost"}]);
    await db.query("select console_job_acknowledge_uncertain($1)",[first.job.id]);
    expect((await db.query("select job_id,last_unresolved_id from console_job_mutation_guard")).rows[0]).toEqual({job_id:null,last_unresolved_id:first.job.id});
    const late=(await db.query("select console_job_publish($1,$2,'running',$3,'dpl_first',null) value",[first.job.id,claim.token,{checks:[],summary:"still running"}])).rows[0].value;
    expect(late).toMatchObject({outcome:"resumed",job:{state:"running",dispatch_token:claim.token,summary:"still running"}});
    expect((await db.query("select job_id,last_unresolved_id from console_job_mutation_guard")).rows[0]).toEqual({job_id:first.job.id,last_unresolved_id:null});
    expect((await providerEnqueue(db,"deploy.production","vercel:prj_fixture:production")).outcome).toBe("mutation_busy");
    expect((await providerEnqueue(db,"deploy.production","vercel:prj_fixture:production",randomUUID(),first.job.id)).outcome).toBe("conflict");
    expect((await enqueue(other,"migrations.apply","another")).outcome).toBe("mutation_busy");
    expect((await db.query("select count(*)::int n from console_jobs where state='running'")).rows[0].n).toBe(1);
    // Later polls are ordinary publications; the terminal result releases the guard as always.
    expect((await db.query("select console_job_publish($1,$2,'running',$3,'dpl_first',null) value",[first.job.id,claim.token,{checks:[],summary:"still"}])).rows[0].value).toMatchObject({outcome:"published",job:{state:"running"}});
    expect((await db.query("select console_job_publish($1,$2,'succeeded',$3,'dpl_first',null) value",[first.job.id,claim.token,{checks:[],summary:"done"}])).rows[0].value.job.state).toBe("succeeded");
    expect((await db.query("select job_id,last_unresolved_id from console_job_mutation_guard")).rows[0]).toEqual({job_id:null,last_unresolved_id:null});
    expect((await providerEnqueue(db,"deploy.production","vercel:prj_fixture:production")).outcome).toBe("enqueued");
  });

  it("answers conflict naming the guard holder when another mutation took the guard after acknowledgment",async()=>{
    const first=await providerEnqueue(db,"deploy.preview","vercel:prj_fixture:preview");
    const claim=(await db.query("select console_job_claim($1,$2) value",[first.job.id,randomUUID()])).rows[0].value;
    await db.query("select console_job_publish($1,$2,'uncertain',$3,'dpl_first',null)",[first.job.id,claim.token,{checks:[],summary:"lost"}]);
    await db.query("select console_job_acknowledge_uncertain($1)",[first.job.id]);
    const next=await providerEnqueue(db,"deploy.production","vercel:prj_fixture:production",randomUUID(),first.job.id);expect(next.outcome).toBe("enqueued");
    expect((await db.query("select console_job_publish($1,$2,'running',$3,'dpl_first',null) value",[first.job.id,randomUUID(),{checks:[],summary:"forged"}])).rows[0].value.outcome).toBe("stale");
    const late=(await db.query("select console_job_publish($1,$2,'running',$3,'dpl_first',null) value",[first.job.id,claim.token,{checks:[],summary:"still running"}])).rows[0].value;
    expect(late.outcome).toBe("conflict");expect(late.job.state).toBe("uncertain");expect(late.job.dispatch_token).toBe(claim.token);
    expect(late.job.summary).toContain("later deploy.production command now holds the mutation guard");
    expect(late.job.result.checks[0].detail).toContain(next.job.id);expect(late.job.result.checks[0].detail.length).toBeLessThanOrEqual(500);
    expect((await db.query("select job_id,last_unresolved_id from console_job_mutation_guard")).rows[0]).toEqual({job_id:next.job.id,last_unresolved_id:first.job.id});
    const nextClaim=(await db.query("select console_job_claim($1,$2) value",[next.job.id,randomUUID()])).rows[0].value;
    expect((await db.query("select console_job_publish($1,$2,'running',$3,'dpl_next',null) value",[next.job.id,nextClaim.token,{checks:[],summary:"Accepted"}])).rows[0].value).toMatchObject({outcome:"published",job:{state:"running"}});
    expect((await db.query("select count(*)::int n from console_jobs where state='running'")).rows[0].n).toBe(1);
    // The acknowledged receipt still reconciles to its own terminal result with its own token.
    expect((await db.query("select console_job_publish($1,$2,'succeeded',$3,'dpl_first',null) value",[first.job.id,claim.token,{checks:[],summary:"done"}])).rows[0].value.job.state).toBe("succeeded");
    expect((await db.query("select job_id,last_unresolved_id from console_job_mutation_guard")).rows[0]).toEqual({job_id:next.job.id,last_unresolved_id:null});
  });

  it.each(["deploy.preview","checks"])("resumes a running %s receipt marked uncertain while its provider was healthy, under its original token and guard",async(operation)=>{
    const target=operation==="checks"?"github:fixture/app":"vercel:prj_fixture:preview",mutation=operation!=="checks";
    const admitted=await providerEnqueue(db,operation,target),id=admitted.job.id;
    const claim=(await db.query("select console_job_claim($1,$2) value",[id,randomUUID()])).rows[0].value;
    expect((await db.query("select console_job_publish($1,$2,'running',$3,'prov-1',null) value",[id,claim.token,{checks:[],summary:"Accepted"}])).rows[0].value.outcome).toBe("published");
    const marked=(await db.query("select console_job_mark_uncertain($1) value",[id])).rows[0].value;
    expect(marked.outcome).toBe("marked_uncertain");expect(marked.job.dispatch_token).toBe(claim.token);
    expect((await db.query("select job_id from console_job_mutation_guard")).rows[0].job_id).toBe(mutation?id:null);
    const back=(await db.query("select console_job_publish($1,$2,'running',$3,'prov-1',null) value",[id,claim.token,{checks:[],summary:"Provider run in progress"}])).rows[0].value;
    expect(back).toMatchObject({outcome:"resumed",job:{state:"running",dispatch_token:claim.token,summary:"Provider run in progress",unresolved_acknowledged_at:null}});
    expect((await db.query("select job_id,last_unresolved_id from console_job_mutation_guard")).rows[0]).toEqual({job_id:mutation?id:null,last_unresolved_id:null});
    if(mutation)expect((await enqueue(other,"migrations.apply","another")).outcome).toBe("mutation_busy");
    expect((await db.query("select console_job_publish($1,$2,'succeeded',$3,'prov-1',null) value",[id,claim.token,{checks:[],summary:"done"}])).rows[0].value).toMatchObject({outcome:"published",job:{state:"succeeded"}});
    expect((await db.query("select job_id from console_job_mutation_guard")).rows[0].job_id).toBeNull();
  });

  it("names nothing new as unresolved when a mutation fenced before any claim is acknowledged",async()=>{
    // A queued receipt has no dispatch token, so it can never publish a terminal result; naming it
    // made every later confirmation warn about work that provably never started.
    const never=await providerEnqueue(db,"migrations.apply","supabase:x");
    expect((await db.query("select console_job_mark_uncertain($1) value",[never.job.id])).rows[0].value.job.dispatch_token).toBeNull();
    expect((await db.query("select console_job_acknowledge_uncertain($1) value",[never.job.id])).rows[0].value.outcome).toBe("acknowledged");
    expect((await db.query("select job_id,last_unresolved_id from console_job_mutation_guard")).rows[0]).toEqual({job_id:null,last_unresolved_id:null});
    expect((await providerEnqueue(db,"migrations.apply","supabase:x",randomUUID(),never.job.id)).outcome).toBe("conflict");
    const after=await providerEnqueue(db,"migrations.apply","supabase:x");expect(after.outcome).toBe("enqueued");
    // An earlier acknowledged receipt that did dispatch stays the one to name: a fenced row's
    // release neither displaces nor clears it.
    const afterClaim=(await db.query("select console_job_claim($1,$2) value",[after.job.id,randomUUID()])).rows[0].value;
    await db.query("select console_job_publish($1,$2,'uncertain',$3,'run-1',null)",[after.job.id,afterClaim.token,{checks:[],summary:"lost"}]);
    await db.query("select console_job_acknowledge_uncertain($1)",[after.job.id]);
    const queued=await providerEnqueue(db,"deploy.preview","vercel:prj_fixture:preview",randomUUID(),after.job.id);expect(queued.outcome).toBe("enqueued");
    await db.query("select console_job_mark_uncertain($1)",[queued.job.id]);await db.query("select console_job_acknowledge_uncertain($1)",[queued.job.id]);
    expect((await db.query("select job_id,last_unresolved_id from console_job_mutation_guard")).rows[0]).toEqual({job_id:null,last_unresolved_id:after.job.id});
    expect((await providerEnqueue(db,"deploy.preview","vercel:prj_fixture:preview")).outcome).toBe("conflict");
    expect((await providerEnqueue(db,"deploy.preview","vercel:prj_fixture:preview",randomUUID(),after.job.id)).outcome).toBe("enqueued");
  });

  it("prunes only old terminal diagnostic/test receipts",async()=>{
    const values=[
      [randomUUID(),randomUUID(),fingerprint("a"),"diagnostics","old-diagnostic","succeeded"],
      [randomUUID(),randomUUID(),fingerprint("b"),"diagnostics","old-uncertain","uncertain"],
      [randomUUID(),randomUUID(),fingerprint("c"),"deploy.preview","old-deploy","succeeded"],
    ];
    for(const row of values)await db.query("insert into console_jobs(id,request_key,input_fingerprint,operation,target,state,requested_at,updated_at,result,summary) values($1,$2,$3,$4,$5,$6,now()-interval '31 days',now()-interval '31 days',$7,'old')",[...row,{checks:[],summary:"old"}]);
    await enqueue(db,"checks","fresh");
    expect((await db.query("select target from console_jobs order by target")).rows.map(row=>row.target)).toEqual(["fresh","old-deploy","old-uncertain"]);
  });

  it("exposes service-only RPCs and no anonymous table read", async () => {
    for (const signature of ["console_job_enqueue_provider(uuid,text,text,text,text,jsonb,timestamptz,uuid)","console_job_reconcile_claim(uuid)","console_job_reconcile_publish(uuid,uuid,uuid,text,jsonb,text)","console_job_reconcile_release(uuid,uuid)","console_job_migration_ledger()","console_job_enqueue(uuid,text,text,text,text)", "console_job_claim(uuid)", "console_job_claim(uuid,uuid)", "console_job_mark_uncertain(uuid)", "console_job_publish(uuid,uuid,text,jsonb,text,text)", "console_job_acknowledge_uncertain(uuid)"]) {
      const row = (await db.query("select has_function_privilege('anon',$1,'execute') anon,has_function_privilege('authenticated',$1,'execute') auth,has_function_privilege('service_role',$1,'execute') service", [signature])).rows[0];
      expect(row).toEqual({ anon: false, auth: false, service: true });
    }
    await db.query("set role anon");
    try { await expect(db.query("select * from console_jobs")).rejects.toThrow(/permission denied/); } finally { await db.query("reset role"); }
    await db.query("set role service_role");
    try { expect((await enqueue(db)).outcome).toBe("enqueued"); } finally { await db.query("reset role"); }
  });
});
