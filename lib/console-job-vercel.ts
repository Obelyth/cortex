import type {ConsoleJob,JobCompletion,ProviderContext} from "./console-jobs";
import type {DispatchResult} from "./console-job-github";
import {clipSafeText,providerFetch,providerJson,boundedProviderText,type ProviderFetch,type SafeJobOutput} from "./console-job-output";
const record=(v:unknown):Record<string,unknown>|null=>v!==null&&typeof v==="object"&&!Array.isArray(v)?v as Record<string,unknown>:null;
const team=(ctx:ProviderContext)=>ctx.team?`teamId=${encodeURIComponent(ctx.team)}`:"";
const headers=(token:string)=>({Authorization:`Bearer ${token}`,"Content-Type":"application/json"});
function verify(value:unknown,job:ConsoleJob,ctx:ProviderContext){
  const r=record(value),git=record(r?.gitSource),meta=record(r?.meta),[org,repo]=ctx.repository.split("/");
  if(!r||typeof r.id!=="string"||!/^dpl_[A-Za-z0-9]{1,100}$/.test(r.id)||r.projectId!==ctx.project||meta?.cortex_job_id!==job.id||git?.type!=="github"||git.org!==org||git.repo!==repo||git.ref!==ctx.branch||git.sha!==job.sourceSha)return null;
  if(job.providerId!==null&&r.id!==job.providerId)return null;
  if((job.operation==="deploy.production"&&r.target!=="production")||(job.operation==="deploy.preview"&&r.target!==null&&r.target!=="preview"))return null;
  return r;
}
export async function vercelDispatch(job:ConsoleJob,ctx:ProviderContext,token:string,fetcher:ProviderFetch=fetch):Promise<DispatchResult>{
  const [org,repo]=ctx.repository.split("/");
  try{
    const res=await providerFetch(`https://api.vercel.com/v13/deployments${team(ctx)?`?${team(ctx)}`:""}`,{method:"POST",headers:headers(token),body:JSON.stringify({name:repo,project:ctx.project,gitSource:{type:"github",org,repo,ref:ctx.branch,sha:job.sourceSha},...(job.operation==="deploy.production"?{target:"production"}:{}),meta:{cortex_job_id:job.id}})},fetcher);
    if([400,401,403,404,422].includes(res.status))return {kind:"rejected",code:"vercel_dispatch_rejected"};
    if(!res.ok)return {kind:"uncertain",code:"vercel_dispatch_unconfirmed"};
    const found=verify(await providerJson(res),job,ctx);return found?{kind:"accepted",providerId:String(found.id)}:{kind:"uncertain",code:"vercel_identity_unconfirmed"};
  }catch{return {kind:"uncertain",code:"vercel_dispatch_uncertain"};}
}
async function get(path:string,ctx:ProviderContext,token:string,fetcher:ProviderFetch){const res=await providerFetch(`https://api.vercel.com${path}${path.includes("?")?"&":"?"}${team(ctx)}`,{headers:headers(token)},fetcher);if(!res.ok)throw new Error("Vercel status unavailable");return providerJson(res);}
export async function vercelStatus(job:ConsoleJob,ctx:ProviderContext,token:string,fetcher:ProviderFetch=fetch):Promise<JobCompletion|null>{
  try{
    let id=job.providerId;
    if(!id){const list=record(await get(`/v6/deployments?projectId=${encodeURIComponent(ctx.project!)}&limit=50`,ctx,token,fetcher));if(!Array.isArray(list?.deployments)||list.deployments.length>50)return null;
      const matching=list.deployments.map(record).filter(r=>r&&record(r.meta)?.cortex_job_id===job.id);if(matching.length!==1)return null;id=String(matching[0]!.uid??matching[0]!.id);}
    if(!/^dpl_[A-Za-z0-9]{1,100}$/.test(id))return null;
    const r=verify(await get(`/v13/deployments/${id}?withGitRepoInfo=true`,ctx,token,fetcher),{...job,providerId:id},ctx);if(!r)return null;
    const state=String(r.readyState);if(!["QUEUED","INITIALIZING","BUILDING","READY","ERROR","CANCELED"].includes(state))return null;
    const production=job.operation==="deploy.production",assigned=r.aliasAssigned===true&&!r.aliasError;
    return {state:state==="ERROR"||state==="CANCELED"?"failed":state==="READY"?production&&!assigned?"uncertain":"succeeded":"running",providerId:id,
      summary:state==="READY"&&production&&!assigned?"READY build · production assignment unconfirmed or failed; not confirmed live":`Provider build ${state}${production&&assigned?" · production assignment confirmed":""}`,
      checks:[{name:"provider build",state:state==="READY"?"passed":state==="ERROR"||state==="CANCELED"?"failed":"unavailable",detail:`Vercel ${state}`},...(production?[{name:"production assignment",state:assigned?"passed" as const:r.aliasError?"failed" as const:"unavailable" as const,detail:assigned?"Provider confirms alias assignment":"Build readiness alone does not prove production assignment."}]:[])]};
  }catch{return null;}
}
export async function vercelLogs(job:ConsoleJob,ctx:ProviderContext,token:string,fetcher:ProviderFetch=fetch,exactSecrets:readonly string[]=[token]):Promise<SafeJobOutput>{
  if(!job.providerId||!/^dpl_[A-Za-z0-9]{1,100}$/.test(job.providerId))throw new Error("Logs unavailable");
  const response=await providerFetch(`https://api.vercel.com/v3/deployments/${job.providerId}/events?follow=0&limit=100${team(ctx)?`&${team(ctx)}`:""}`,{headers:headers(token)},fetcher);
  if(!response.ok)throw new Error("Logs unavailable");const raw=await boundedProviderText(response,1024*1024);const value:unknown=JSON.parse(raw);
  if(!Array.isArray(value)||value.length>100)throw new Error("Logs unavailable");
  const text=value.map(v=>{const e=record(v);if(!e||typeof e.text!=="string")throw new Error("Logs unavailable");return e.text;}).join("\n");
  return {available:true,...clipSafeText(text,16384,exactSecrets)};
}
