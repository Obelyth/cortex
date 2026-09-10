import {afterEach,describe,expect,it,vi} from "vitest";
import {randomUUID,createHash} from "node:crypto";
import {prepareProviderJob,providerReadiness,requestProviderJob,reconcileProviderJob} from "../lib/console-job-providers";
import {githubDispatch,githubStatus,githubLogs} from "../lib/console-job-github";
import {vercelDispatch,vercelStatus,vercelLogs} from "../lib/console-job-vercel";
import {safeOutput,providerFetch} from "../lib/console-job-output";
import type {ConsoleJob,ConsoleJobStore,ProviderContext} from "../lib/console-jobs";
const sha="b".repeat(40),id="11111111-1111-4111-8111-111111111111",key="22222222-2222-4222-8222-222222222222";
const context:ProviderContext={provider:"github",repository:"fixture/app",branch:"main",project:null,team:null,pendingDigest:null};
const env={CORTEX_APP_REPO:"fixture/app",CORTEX_APP_BRANCH:"main",CORTEX_ACTIONS_TOKEN:"synthetic-actions",CONNECTOR_PATH_SECRET:"synthetic-private-signing",CONSOLE_PASSCODE:"synthetic-private-passcode",CORTEX_VERCEL_TOKEN:"synthetic-vercel",CORTEX_VERCEL_PROJECT_ID:"prj_fixture"};
const job:ConsoleJob={id,operation:"checks",state:"running",requestedAt:"2026-09-08T00:00:00Z",updatedAt:"2026-09-08T00:00:00Z",sourceSha:sha,target:"github:fixture/app",checks:[],summary:"running",providerId:null};
const run=(extra={})=>({id:123,name:"Cortex dashboard checks",display_title:`cortex:${id}`,path:".github/workflows/cortex-dashboard-checks.yml",event:"workflow_dispatch",head_sha:sha,head_branch:"main",repository:{full_name:"fixture/app"},status:"in_progress",conclusion:null,...extra});
function store():ConsoleJobStore{
  let receipt:ConsoleJob|null=null,fingerprint="";let execution=context;
  return {async enqueue(i){if(receipt)return{outcome:i.fingerprint===fingerprint?"replay":"key_conflict",...(i.fingerprint===fingerprint?{job:receipt}:{})} as never;fingerprint=i.fingerprint;execution=i.execution!;receipt={...job,id,operation:i.operation,state:"queued",sourceSha:i.sourceSha,target:i.target};return{outcome:"enqueued",job:receipt};},async claim(){if(receipt!.state!=="queued")return{outcome:"not_claimed",job:receipt!};receipt={...receipt!,state:"running"};return{outcome:"claimed",job:receipt,token:randomUUID()};},async publish(_id,_token,c){receipt={...receipt!,...c};return{outcome:"published",job:receipt};},async get(){return receipt;},async findByRequest(){return receipt?{job:receipt,fingerprint}:null;},async list(){return{items:[],nextCursor:null};},async acknowledgeUncertain(){return receipt!;},async markUncertain(){return receipt!;},async lastUnresolved(){return null;},async claimReconciliation(){return receipt?{job:receipt,execution,token:randomUUID(),pollToken:randomUUID()}:null;},async publishReconciliation(i,t,_p,c){return this.publish(i,t,c);}};
}
afterEach(()=>{vi.restoreAllMocks();vi.useRealTimers();});
describe("fixed provider command composition",()=>{
  it("resolves app SHA, freezes confirmation, and never redispatches a lost POST on browser retry",async()=>{
    let posts=0;const db=store();
    const fetcher=async(url:string,init?:RequestInit)=>{if(init?.method==="POST"){posts++;throw new Error("lost synthetic credential");}expect(url).toBe("https://api.github.com/repos/fixture/app/commits/main");return Response.json({sha});};
    const deps={store:db,env,fetcher};const preparation=await prepareProviderJob({operation:"checks",requestKey:key},deps);
    const command={operation:"checks",requestKey:key,intent:preparation.intent,confirm:true};
    expect((await requestProviderJob(command,deps)).state).toBe("uncertain");
    expect((await requestProviderJob(command,deps)).state).toBe("uncertain");expect(posts).toBe(1);
  });
  it("rejects changed source/target before consuming or dispatching a confirmation",async()=>{
    let current=sha,posts=0;const db=store();const fetcher=async(_url:string,init?:RequestInit)=>{if(init?.method==="POST")posts++;return Response.json({sha:current});};
    const deps={store:db,env,fetcher};const p=await prepareProviderJob({operation:"deploy.production",requestKey:key},deps);
    current="c".repeat(40);await expect(requestProviderJob({operation:"deploy.production",requestKey:key,intent:p.intent,confirm:true},deps)).rejects.toMatchObject({code:"conflict"});expect(posts).toBe(0);
  });
  it("refuses pending-ledger drift and a configured target change before migration dispatch",async()=>{
    const db=store();let rows:Array<{name:string;checksum:string|null}>=[],posts=0;
    db.migrationLedger=async()=>({state:"present",rows});
    const migrationEnv={...env,CORTEX_MIGRATION_TARGET:"supabase:abcdefghijklmnopqrst:postgres",SUPABASE_URL:"https://abcdefghijklmnopqrst.supabase.co",SUPABASE_SERVICE_ROLE_KEY:"synthetic-service",VERCEL_GIT_COMMIT_SHA:sha};
    const deps={store:db,env:migrationEnv,files:()=>new Map([["20990101000000_one.sql","select 1;"]]),fetcher:async(_url:string,init?:RequestInit)=>{if(init?.method==="POST")posts++;return Response.json({sha});}};
    const p=await prepareProviderJob({operation:"migrations.apply",requestKey:key},deps);
    rows=[{name:"20990101000000_one.sql",checksum:"354b7196c9ba5fb4b21cf615bb6ec4cd5c07503c34229feef033fc081a8c03f4"}];
    await expect(requestProviderJob({operation:"migrations.apply",requestKey:key,intent:p.intent,confirm:true},deps)).rejects.toMatchObject({code:"conflict"});expect(posts).toBe(0);
    rows=[];deps.env={...migrationEnv,CORTEX_MIGRATION_TARGET:"supabase:zyxwvutsrqponmlkjihg:postgres"};
    await expect(requestProviderJob({operation:"migrations.apply",requestKey:key,intent:p.intent,confirm:true},deps)).rejects.toMatchObject({code:"conflict"});expect(posts).toBe(0);
  });
  it("never substitutes the corpus SHA for missing runtime migration proof",async()=>{
    const db=store();db.migrationLedger=async()=>({state:"present",rows:[]});
    await expect(prepareProviderJob({operation:"migrations.apply",requestKey:key},{store:db,env:{...env,CORTEX_MIGRATION_TARGET:"supabase:abcdefghijklmnopqrst:postgres",SUPABASE_URL:"https://abcdefghijklmnopqrst.supabase.co",SUPABASE_SERVICE_ROLE_KEY:"synthetic"},fetcher:async()=>Response.json({sha})})).rejects.toThrow(/deployed SHA/);
  });
  it("does not dispatch an expired unconsumed intent or silently renew it",async()=>{
    let now=0,posts=0;const db=store();const deps={store:db,env,now:()=>now,fetcher:async(_url:string,init?:RequestInit)=>{if(init?.method==="POST")posts++;return Response.json({sha});}};
    const p=await prepareProviderJob({operation:"checks",requestKey:key},deps);now=300000;
    await expect(requestProviderJob({operation:"checks",requestKey:key,intent:p.intent,confirm:true},deps)).rejects.toMatchObject({code:"conflict"});expect(posts).toBe(0);
  });
  it.each(["source","ledger"])("refuses a queued retry whose intent expires during the async %s read",async(phase)=>{
    let now=0,cross=false,posts=0;const db=store();
    db.migrationLedger=async()=>{if(cross&&phase==="ledger")now=300000;return{state:"present",rows:[]};};
    const deps={store:db,env:{...env,CORTEX_MIGRATION_TARGET:"supabase:abcdefghijklmnopqrst:postgres",SUPABASE_URL:"https://abcdefghijklmnopqrst.supabase.co",SUPABASE_SERVICE_ROLE_KEY:"synthetic-service",VERCEL_GIT_COMMIT_SHA:sha},now:()=>now,files:()=>new Map([["20990101000000_one.sql","select 1;"]]),fetcher:async(_url:string,init?:RequestInit)=>{if(init?.method==="POST"){posts++;throw new Error("must not dispatch");}if(cross&&phase==="source")now=300000;return Response.json({sha});}};
    const p=await prepareProviderJob({operation:"migrations.apply",requestKey:key},deps);
    await db.enqueue({requestKey:key,fingerprint:createHash("sha256").update(p.intent).digest("hex"),operation:"migrations.apply",sourceSha:sha,target:p.target,execution:{...context,pendingDigest:p.pendingDigest}});
    now=299999;cross=true;
    await expect(requestProviderJob({operation:"migrations.apply",requestKey:key,intent:p.intent,confirm:true},deps)).rejects.toMatchObject({code:"conflict"});
    expect(posts).toBe(0);expect((await db.get(id))?.state).toBe("queued");
  });
  it("keeps an expired admitted queued intent recoverable by its same key without dispatch or renewal",async()=>{
    let now=0,posts=0;const db=store();const deps={store:db,env,now:()=>now,fetcher:async(_url:string,init?:RequestInit)=>{if(init?.method==="POST")posts++;return Response.json({sha});}};
    const p=await prepareProviderJob({operation:"checks",requestKey:key},deps);
    await db.enqueue({requestKey:key,fingerprint:createHash("sha256").update(p.intent).digest("hex"),operation:"checks",sourceSha:sha,target:job.target,execution:context});
    const command={operation:"checks",requestKey:key,intent:p.intent,confirm:true};now=300000;
    await expect(requestProviderJob(command,deps)).rejects.toMatchObject({code:"conflict"});
    expect((await db.get(id))?.state).toBe("queued");
    const recovered={...(await db.get(id))!,state:"uncertain" as const};const prior=await db.findByRequest(key);db.findByRequest=async()=>({...prior!,job:recovered});
    expect(await requestProviderJob(command,deps)).toEqual(recovered);expect(posts).toBe(0);
  });
  it("does not use the content repository/token as execution authority",async()=>{
    await expect(prepareProviderJob({operation:"checks",requestKey:key},{store:store(),env:{BRAIN_REPO:"fixture/brain",GITHUB_TOKEN:"content-secret"},fetcher:async()=>{throw new Error("must not call");}})).rejects.toThrow(/CORTEX_APP_REPO/);
  });
  it("refuses the same malformed fixed source reported by readiness before fetching or dispatching",async()=>{
    const malformed={...env,CORTEX_APP_REPO:"fixture/app.git"};
    expect(providerReadiness(malformed).find(entry=>entry.operation==="checks")).toMatchObject({
      configured:false,detail:"Invalid CORTEX_APP_REPO or CORTEX_APP_BRANCH",setupRequirement:"source",
    });
    const fetcher=vi.fn(async()=>Response.json({sha}));
    await expect(prepareProviderJob({operation:"checks",requestKey:key},{store:store(),env:malformed,fetcher}))
      .rejects.toMatchObject({code:"unavailable",message:"Invalid CORTEX_APP_REPO or CORTEX_APP_BRANCH"});
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("refuses browser-selected provider IDs, repository, SHA or arbitrary URL",async()=>{
    for(const extra of [{providerId:"123"},{repository:"other/repo"},{sourceSha:sha},{url:"https://localhost"}])await expect(prepareProviderJob({operation:"checks",requestKey:key,...extra},{store:store(),env})).rejects.toMatchObject({code:"invalid"});
  });
});
describe("provider identity and acceptance",()=>{
  it("explicitly requests Vercel Git repository information before verifying deployment identity",async()=>{
    const ctx={...context,provider:"vercel" as const,project:"prj_fixture"};
    const fetcher=vi.fn(async(url:string)=>Response.json({id:"dpl_fixture",projectId:"prj_fixture",meta:{cortex_job_id:id},target:null,readyState:"READY",...(new URL(url).searchParams.get("withGitRepoInfo")==="true"?{gitSource:{type:"github",org:"fixture",repo:"app",ref:"main",sha}}:{})}));
    const status=await vercelStatus({...job,operation:"deploy.preview",providerId:"dpl_fixture"},ctx,"synthetic",fetcher);
    expect(status).toMatchObject({state:"succeeded",providerId:"dpl_fixture"});expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it("does not claim a terminal production deployment is live merely because aliasAssigned is truthy",async()=>{
    const ctx={...context,provider:"vercel" as const,project:"prj_fixture"};
    const response={id:"dpl_fixture",projectId:"prj_fixture",gitSource:{type:"github",org:"fixture",repo:"app",ref:"main",sha},meta:{cortex_job_id:id},target:"production",readyState:"READY",aliasAssigned:1};
    const result=await vercelStatus({...job,operation:"deploy.production",providerId:"dpl_fixture"},ctx,"synthetic",async()=>Response.json(response));expect(result?.state).toBe("uncertain");
  });
  it("pins dispatch API and records only validated run acceptance",async()=>{
    let sent:unknown;const fetcher=async(url:string,init?:RequestInit)=>{if(init?.method==="POST"){expect(url).toContain("/actions/workflows/cortex-dashboard-checks.yml/dispatches");expect(new Headers(init.headers).get("X-GitHub-Api-Version")).toBe("2026-03-10");sent=JSON.parse(init.body as string);return Response.json({workflow_run_id:123,run_url:"https://api.github.com/repos/fixture/app/actions/runs/123",html_url:"https://github.com/fixture/app/actions/runs/123"});}return Response.json(run());};
    expect(await githubDispatch(job,context,"synthetic",fetcher)).toEqual({kind:"accepted",providerId:"123"});
    expect(sent).toEqual({ref:"main",return_run_details:true,inputs:{request_id:id,source_sha:sha,operation:"checks",target_identity:"github:fixture/app",pending_digest:""}});
  });
  it.each([{},null,{workflow_run_id:123}])("keeps malformed successful POST uncertain: %j",async(value)=>{
    expect((await githubDispatch(job,context,"synthetic",async()=>Response.json(value))).kind).toBe("uncertain");
  });
  it("does not attach a cross-repository run or a forged source",async()=>{
    for(const bad of [run({repository:{full_name:"other/app"}}),run({head_sha:"c".repeat(40)}),run({display_title:"cortex:another"})])expect(await githubStatus({...job,providerId:"123"},context,"synthetic",async()=>Response.json(bad))).toBeNull();
  });
  it("reconciles one matching lost run without POST and refuses ambiguous matches",async()=>{
    let count=1,posts=0;const fetcher=async(url:string,init?:RequestInit)=>{if(init?.method==="POST")posts++;return Response.json(url.includes("/runs?")?{workflow_runs:Array.from({length:count},()=>run())}:{total_count:1,jobs:[{id:456,run_id:123,name:"checks",steps:[{name:"Typecheck",conclusion:"success"},{name:"Private corpus gate",conclusion:"skipped"}]}]});};
    const found=await githubStatus(job,context,"synthetic",fetcher);expect(found?.providerId).toBe("123");expect(found?.checks.some(c=>c.name==="private corpus"&&c.state==="skipped")).toBe(true);
    count=2;expect(await githubStatus(job,context,"synthetic",fetcher)).toBeNull();expect(posts).toBe(0);
  });
  it("builds Vercel source only from fixed context and rejects cross-project returns",async()=>{
    const ctx={...context,provider:"vercel" as const,project:"prj_fixture"},deploy={...job,operation:"deploy.production" as const,target:"vercel:prj_fixture:production"};let sent:unknown;
    const response={id:"dpl_fixture",projectId:"prj_other",gitSource:{type:"github",org:"fixture",repo:"app",ref:"main",sha},meta:{cortex_job_id:id},target:"production",readyState:"READY"};
    expect((await vercelDispatch(deploy,ctx,"synthetic",async(_url,init)=>{sent=JSON.parse(init!.body as string);return Response.json(response);})).kind).toBe("uncertain");
    expect(sent).toEqual({name:"app",project:"prj_fixture",gitSource:{type:"github",org:"fixture",repo:"app",ref:"main",sha},target:"production",meta:{cortex_job_id:id}});
    const status=await vercelStatus({...deploy,providerId:"dpl_fixture"},ctx,"synthetic",async()=>Response.json({...response,projectId:"prj_fixture",aliasAssigned:false,aliasError:{message:"secret"}}));
    expect(status?.summary).toContain("READY");expect(status?.state).not.toBe("succeeded");expect(JSON.stringify(status)).not.toContain("secret");
  });
});
describe("provider output boundary",()=>{
  it.each(["missing","transport error"])("releases observation ownership after %s so another lookup can make progress",async(failure)=>{
    const db=store();let leased=false,good=false,current={...job};
    db.get=async()=>current;
    db.claimReconciliation=async()=>{if(leased)return null;leased=true;return{job:current,execution:context,token:randomUUID(),pollToken:randomUUID()};};
    Object.assign(db,{releaseReconciliation:async()=>{leased=false;}});
    db.publishReconciliation=async(_id,_token,_poll,c)=>{current={...current,...c};return{outcome:"published",job:current};};
    const deps={store:db,env,fetcher:async(url:string)=>{if(!good){if(failure==="transport error")throw new Error("synthetic network failure");return Response.json({workflow_runs:[]});}return Response.json(url.includes("/runs?")?{workflow_runs:[run({status:"completed",conclusion:"success"})]}:{total_count:0,jobs:[]});}};
    expect((await reconcileProviderJob(id,deps)).job.state).toBe("running");good=true;
    expect((await reconcileProviderJob(id,deps)).job.state).toBe("succeeded");
  });
  it.each(["Authorization: Bearer opaque-management-credential-"+"C".repeat(80), "github_pat_"+"A".repeat(82)])("removes recognizable credentials before whole-output and boundary clipping: %s",async(secret)=>{
    for(const prefix of ["", "x".repeat(16320)+"\n"]){
      const result=await safeOutput(new Response(prefix+secret+"\n"+"z".repeat(100)));
      expect(result.text).not.toContain("opaque-management");expect(result.text).not.toContain("github_pat_");expect(Buffer.byteLength(result.text)).toBeLessThanOrEqual(16384);
    }
  });
  it("removes exact configured management secrets from the verified GitHub and Vercel log paths",async()=>{
    const token="syntheticOpaqueManagementValue-123";
    for(const prefix of ["","x".repeat(16345)+"\n"]){
    let calls=0;const gh=await githubLogs({...job,providerId:"123"},context,token,async()=>{
      calls++;if(calls===1)return Response.json({jobs:[{id:456,run_id:123}]});if(calls===2)return new Response(null,{status:302,headers:{location:"https://host.actions.githubusercontent.com/log"}});return new Response(`${prefix}${token}\nAuthorization: Bearer anotherOpaqueCredential`);
    });
    const vc=await vercelLogs({...job,providerId:"dpl_fixture"},{...context,provider:"vercel",project:"prj_fixture"},token,async()=>Response.json([{text:`${prefix}${token}\ngithub_pat_${"B".repeat(82)}`} ]));
    for(const value of [gh.text,vc.text]){expect(value).not.toContain(token.slice(0,12));expect(value).not.toContain("anotherOpaqueCredential");expect(value).not.toContain("github_pat_");}
    }
  });
  it("bounds stalled response headers and log streams independently",async()=>{
    vi.useFakeTimers();
    const headers=expect(providerFetch("https://api.github.com/synthetic",{},()=>new Promise(()=>{}))).rejects.toThrow("Provider unavailable");
    await vi.advanceTimersByTimeAsync(8000);await headers;
    const cancel=vi.fn();const stream=new ReadableStream({start(c){c.enqueue(new TextEncoder().encode("partial secret"));},cancel});
    const body=expect(safeOutput(new Response(stream))).rejects.toThrow("Provider output unavailable");
    await vi.advanceTimersByTimeAsync(8000);await body;expect(cancel).toHaveBeenCalledTimes(1);
  });
  it("uses bounded non-following Vercel events and rejects more than 100 without partial output",async()=>{
    const ctx={...context,provider:"vercel" as const,project:"prj_fixture"};
    const fetcher=vi.fn(async(url:string)=>{expect(new URL(url).searchParams.get("follow")).toBe("0");expect(new URL(url).searchParams.get("limit")).toBe("100");return Response.json([{text:"https://user:password@synthetic.invalid/path?token=secret"}]);});
    const result=await vercelLogs({...job,providerId:"dpl_fixture"},ctx,"synthetic",fetcher);expect(result.text).toBe("<redacted-url>");
    await expect(vercelLogs({...job,providerId:"dpl_fixture"},ctx,"synthetic",async()=>Response.json(Array.from({length:101},()=>({text:"not partial"}))))).rejects.toThrow();
  });
  it("never follows a second log redirect or requests logs for a different run's job",async()=>{
    for(const wrongOwner of [true,false]){
      let calls=0;await expect(githubLogs({...job,providerId:"123"},context,"synthetic",async()=>{calls++;if(calls===1)return Response.json({jobs:[{id:456,run_id:wrongOwner?999:123}]});return new Response(null,{status:302,headers:{Location:calls===2?"https://host.actions.githubusercontent.com/log":"http://localhost/never"}});})).rejects.toThrow();
      expect(calls).toBe(wrongOwner?1:3);
    }
  });
  it.each(["conflict","published","resumed","stale"] as const)("returns the store's %s outcome as the receipt it produced, never the stale row or a swallowed error",async(outcome)=>{
    const db=store();const acknowledged={...job,operation:"deploy.production" as const,state:"uncertain" as const,target:"vercel:prj_fixture:production",providerId:"dpl_first"};db.get=async()=>acknowledged;
    const running=outcome==="published"||outcome==="resumed";
    const answered={...acknowledged,state:running?"running" as const:"uncertain" as const,summary:outcome==="conflict"?"Provider still reports this run in progress · a later deploy.production command now owns vercel:prj_fixture:production · this receipt stays uncertain":running?"Provider run in progress":acknowledged.summary};
    const ctx={...context,provider:"vercel" as const,project:"prj_fixture"};let published:unknown;
    db.claimReconciliation=async()=>({job:acknowledged,execution:ctx,token:randomUUID(),pollToken:randomUUID()});
    db.publishReconciliation=async(_id,_token,_poll,c)=>{published=c;return{outcome,job:answered};};
    db.releaseReconciliation=async()=>{};
    const fetcher=async()=>Response.json({id:"dpl_first",projectId:"prj_fixture",gitSource:{type:"github",org:"fixture",repo:"app",ref:"main",sha},meta:{cortex_job_id:id},target:"production",readyState:"BUILDING"});
    const result=await reconcileProviderJob(id,{store:db,env,fetcher});
    expect(published).toMatchObject({state:"running",providerId:"dpl_first"});
    expect(result.reconciled).toBe(outcome);expect(result.job).toEqual(answered);
    if(outcome==="conflict"){expect(result.job.state).toBe("uncertain");expect(result.job.summary).toContain("later deploy.production command now owns");}
    if(outcome==="resumed")expect(result.job.state).toBe("running");
  });
  it("reports no reconciliation when the terminal receipt needs no publication",async()=>{
    const db=store();const terminal={...job,state:"succeeded" as const,providerId:"123"};db.get=async()=>terminal;
    expect(await reconcileProviderJob(id,{store:db,env,fetcher:async()=>{throw new Error("must not call");}})).toEqual({job:terminal});
  });
  it("can read verified terminal-job logs without reopening or republishing the job",async()=>{
    const db=store();const terminal={...job,state:"succeeded" as const,providerId:"123"};db.get=async()=>terminal;
    db.releaseReconciliation=async()=>{};
    db.claimReconciliation=async()=>({job:terminal,execution:context,token:null,pollToken:randomUUID()}) as never;
    db.publishReconciliation=async()=>{throw new Error("terminal publication must not occur");};
    const fetcher=async(url:string)=>{if(url.endsWith("/actions/runs/123"))return Response.json(run({status:"completed",conclusion:"success"}));if(url.includes("/jobs?"))return Response.json({total_count:1,jobs:[{id:456,run_id:123,name:"checks",steps:[]}]});if(url.endsWith("/logs"))return new Response(null,{status:302,headers:{Location:"https://logs.actions.githubusercontent.com/file"}});return new Response("terminal log");};
    const result=await reconcileProviderJob(id,{store:db,env,fetcher},true);expect(result.output).toMatchObject({available:true,text:"terminal log"});expect(result.job.state).toBe("succeeded");
  });
  it("redacts full text before byte clipping and rejects oversize multibyte logs",async()=>{
    const raw="a".repeat(16370)+" ghp_"+"A".repeat(40);
    const result=await safeOutput(new Response(raw));expect(result.clipped).toBe(true);expect(Buffer.byteLength(result.text)).toBeLessThanOrEqual(16384);expect(result.text).not.toContain("ghp_");
    await expect(safeOutput(new Response("é".repeat(524289)))).rejects.toThrow();
  });
  it("verifies job ownership, follows only allowlisted HTTPS redirects, without credentials",async()=>{
    for(const destination of ["http://localhost/log","https://evil.actions.githubusercontent.com.evil.test/log","https://u:p@host.actions.githubusercontent.com/log","https://host.actions.githubusercontent.com:444/log"]){
      let calls=0;const fetcher=async()=>{calls++;return calls===1?Response.json({total_count:1,jobs:[{id:456,run_id:123}]}):new Response(null,{status:302,headers:{Location:destination}});};
      await expect(githubLogs({...job,providerId:"123"},context,"synthetic",fetcher)).rejects.toThrow();expect(calls).toBe(2);
    }
    let calls=0;await githubLogs({...job,providerId:"123"},context,"synthetic",async(_url,init)=>{calls++;if(calls===1)return Response.json({total_count:1,jobs:[{id:456,run_id:123}]});if(calls===2)return new Response(null,{status:302,headers:{Location:"https://host.actions.githubusercontent.com/log"}});expect(new Headers(init?.headers).has("Authorization")).toBe(false);expect(init?.redirect).toBe("error");return new Response("safe log");});
  });
});
