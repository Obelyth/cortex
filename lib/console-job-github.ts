import type {ConsoleJob,JobCompletion,ProviderContext} from "./console-jobs";
import {clipSafeText,providerFetch,providerJson,safeOutput,type ProviderFetch,type SafeJobOutput} from "./console-job-output";
export type DispatchResult={kind:"accepted";providerId:string}|{kind:"rejected";code:string}|{kind:"uncertain";code:string};
const WORKFLOW="cortex-dashboard-checks.yml";
const record=(v:unknown):Record<string,unknown>|null=>v!==null&&typeof v==="object"&&!Array.isArray(v)?v as Record<string,unknown>:null;
const numeric=(v:unknown)=>typeof v==="number"&&Number.isSafeInteger(v)&&v>0;
export const githubHeaders=(token:string)=>({Authorization:`Bearer ${token}`,Accept:"application/vnd.github+json","X-GitHub-Api-Version":"2026-03-10","Content-Type":"application/json"});
const base=(ctx:ProviderContext)=>`https://api.github.com/repos/${ctx.repository}`;
function verifyRun(value:unknown,job:ConsoleJob,ctx:ProviderContext):Record<string,unknown>|null{
  const r=record(value);if(!r||!numeric(r.id)||r.display_title!==`cortex:${job.id}`||r.path!==`.github/workflows/${WORKFLOW}`||r.event!=="workflow_dispatch"||r.head_sha!==job.sourceSha||r.head_branch!==ctx.branch||record(r.repository)?.full_name!==ctx.repository)return null;
  if(job.providerId!==null&&String(r.id)!==job.providerId)return null;return r;
}
async function get(path:string,ctx:ProviderContext,token:string,fetcher:ProviderFetch){const r=await providerFetch(`${base(ctx)}${path}`,{headers:githubHeaders(token)},fetcher);if(!r.ok)throw new Error("GitHub status unavailable");return providerJson(r);}
export async function githubDispatch(job:ConsoleJob,ctx:ProviderContext,token:string,fetcher:ProviderFetch=fetch):Promise<DispatchResult>{
  try{
    const response=await providerFetch(`${base(ctx)}/actions/workflows/${WORKFLOW}/dispatches`,{method:"POST",headers:githubHeaders(token),body:JSON.stringify({ref:ctx.branch,return_run_details:true,inputs:{request_id:job.id,source_sha:job.sourceSha,operation:job.operation,target_identity:job.target,pending_digest:ctx.pendingDigest??""}})},fetcher);
    if([400,401,403,404,422].includes(response.status))return {kind:"rejected",code:"github_dispatch_rejected"};
    if(response.status!==200)return {kind:"uncertain",code:"github_dispatch_unconfirmed"};
    const value=record(await providerJson(response));const id=value?.workflow_run_id;
    if(!numeric(id)||value?.run_url!==`${base(ctx)}/actions/runs/${id}`||value?.html_url!==`https://github.com/${ctx.repository}/actions/runs/${id}`)return{kind:"uncertain",code:"github_dispatch_malformed"};
    const found=verifyRun(await get(`/actions/runs/${id}`,ctx,token,fetcher),{...job,providerId:String(id)},ctx);
    return found?{kind:"accepted",providerId:String(id)}:{kind:"uncertain",code:"github_identity_unconfirmed"};
  }catch{return {kind:"uncertain",code:"github_dispatch_uncertain"};}
}
export async function githubStatus(job:ConsoleJob,ctx:ProviderContext,token:string,fetcher:ProviderFetch=fetch,exactSecrets:readonly string[]=[token]):Promise<JobCompletion|null>{
  try{
    let run:Record<string,unknown>|null;
    if(job.providerId){if(!/^[1-9]\d{0,19}$/.test(job.providerId))return null;run=verifyRun(await get(`/actions/runs/${job.providerId}`,ctx,token,fetcher),job,ctx);}
    else{
      const page=record(await get(`/actions/workflows/${WORKFLOW}/runs?event=workflow_dispatch&branch=${encodeURIComponent(ctx.branch)}&per_page=50&page=1`,ctx,token,fetcher));
      if(!Array.isArray(page?.workflow_runs)||page.workflow_runs.length>50)return null;
      const matches=page.workflow_runs.map(r=>verifyRun(r,job,ctx)).filter(Boolean);if(matches.length!==1)return null;run=matches[0]!;
    }
    if(!run)return null;
    const complete=run.status==="completed",conclusion=run.conclusion;
    if(!["queued","in_progress","waiting","pending","requested","completed"].includes(String(run.status)))return null;
    const page=record(await get(`/actions/runs/${run.id}/jobs?per_page=50&page=1`,ctx,token,fetcher));
    if(!Array.isArray(page?.jobs)||page.jobs.length>50||typeof page.total_count!=="number")return null;
    const checks:JobCompletion["checks"]=[];
    for(const raw of page.jobs){const j=record(raw);if(!j||j.run_id!==run.id||typeof j.name!=="string")return null;
      if(!Array.isArray(j.steps)||j.steps.length>100)return null;
      for(const rawStep of j.steps){const step=record(rawStep);if(!step||typeof step.name!=="string")return null;if(checks.length>=60)break;
        checks.push({name:clipSafeText(`${j.name}: ${step.name}`,120,exactSecrets).text,state:step.conclusion==="success"?"passed":step.conclusion==="skipped"?"skipped":step.conclusion===null?"unavailable":"failed",detail:step.conclusion===null?"Provider step not completed":`Provider step ${["success","skipped","failure","cancelled","timed_out","neutral"].includes(String(step.conclusion))?step.conclusion:"unavailable"}`});
      }
    }
    if(page.total_count>page.jobs.length||checks.length>=60)checks.push({name:"step coverage",state:"unavailable",detail:"Bounded step listing is incomplete; omitted gates are not passed."});
    // Presence and a successful workflow do not prove the optional corpus gate ran.
    if(!checks.some(c=>c.name.includes("Private corpus gate")&&c.state==="passed"))checks.push({name:"private corpus",state:"skipped",detail:"Optional private-corpus gate is unavailable or did not run; not accuracy evidence."});
    return {state:complete?(conclusion==="success"?"succeeded":"failed"):"running",checks,summary:complete?`Workflow ${conclusion==="success"?"completed":"did not succeed"} · inspect named/skipped gates`:"Workflow accepted · execution in progress",providerId:String(run.id)};
  }catch{return null;}
}
export async function githubLogs(job:ConsoleJob,ctx:ProviderContext,token:string,fetcher:ProviderFetch=fetch,exactSecrets:readonly string[]=[token]):Promise<SafeJobOutput>{
  if(!job.providerId||!/^\d{1,20}$/.test(job.providerId))throw new Error("Logs unavailable");
  // Caller verified the stored run identity in this read request before reaching this method.
  const page=record(await get(`/actions/runs/${job.providerId}/jobs?per_page=50&page=1`,ctx,token,fetcher));
  if(!Array.isArray(page?.jobs)||page.jobs.length>50)throw new Error("Logs unavailable");
  const selected=record(page.jobs.find(raw=>record(raw)?.conclusion==="failure")??page.jobs[0]);
  if(!selected||!numeric(selected.id)||String(selected.run_id)!==job.providerId)throw new Error("Logs unavailable");
  const response=await providerFetch(`${base(ctx)}/actions/jobs/${selected.id}/logs`,{headers:githubHeaders(token),redirect:"manual"},fetcher);
  if(response.status!==302)throw new Error("Logs unavailable");
  const location=response.headers.get("location");if(!location)throw new Error("Logs unavailable");const url=new URL(location);
  if(url.protocol!=="https:"||url.username||url.password||url.port||url.hash||![".actions.githubusercontent.com",".blob.core.windows.net"].some(host=>url.hostname.endsWith(host)&&url.hostname.length>host.length))throw new Error("Logs unavailable");
  return safeOutput(await providerFetch(url.toString(),{redirect:"error",headers:{}},fetcher),exactSecrets);
}
