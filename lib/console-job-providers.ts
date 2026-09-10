import {createHmac,createHash,timingSafeEqual} from "node:crypto";
import {z} from "zod";
import {executeJobAdmission,JobError,type ConsoleJob,type ConsoleJobStore,type OperationId} from "./console-jobs";
import {operationIdSchema} from "./console-job-contract";
import {getOperationsReadiness,resolveProviderConfiguration} from "./console-operations-readiness";
import {githubDispatch,githubStatus,githubLogs,githubHeaders} from "./console-job-github";
import {vercelDispatch,vercelStatus,vercelLogs} from "./console-job-vercel";
import {providerFetch,providerJson,type ProviderFetch,type SafeJobOutput} from "./console-job-output";
import {migrationPlan,readMigrationFiles} from "../scripts/migrate";

type Environment=Record<string,string|undefined>;
export interface ProviderDependencies {store:ConsoleJobStore;env?:Environment;fetcher?:ProviderFetch;now?:()=>number;files?:()=>Map<string,string>}
const SHA=/^[a-f0-9]{40}$/;
const mutation=(op:OperationId)=>["migrations.apply","deploy.preview","deploy.production"].includes(op);
const executionSchema=z.object({provider:z.enum(["github","vercel"]),repository:z.string().max(200),branch:z.string().max(100),project:z.string().max(120).nullable(),team:z.string().max(120).nullable(),pendingDigest:z.string().regex(/^[a-f0-9]{64}$/).nullable()}).strict();
const intentSchema=z.object({version:z.literal(1),operation:operationIdSchema,requestKey:z.uuidv4(),sourceSha:z.string().regex(SHA),target:z.string().max(160),execution:executionSchema,unresolvedId:z.uuidv4().nullable(),expiresAt:z.iso.datetime()}).strict();
type Intent=z.infer<typeof intentSchema>;
const signingKey=(env:Environment)=>{
  if(!env.CONSOLE_PASSCODE?.trim()||!env.CONNECTOR_PATH_SECRET)throw new JobError("unavailable","Missing configuration: CONSOLE_PASSCODE, CONNECTOR_PATH_SECRET");
  return createHmac("sha256",env.CONSOLE_PASSCODE.trim()).update(`cortex-command-intent-v1:${env.CONNECTOR_PATH_SECRET}`).digest();
};
function sign(payload:string,env:Environment){return createHmac("sha256",signingKey(env)).update(payload).digest("hex");}
function decode(token:string,env:Environment):Intent{
  const [payload,mac,...rest]=token.split(".");if(rest.length||!payload||!/^[a-f0-9]{64}$/.test(mac??""))throw new JobError("invalid");
  if(!timingSafeEqual(Buffer.from(mac,"hex"),Buffer.from(sign(payload,env),"hex")))throw new JobError("invalid");
  try{return intentSchema.parse(JSON.parse(Buffer.from(payload,"base64url").toString("utf8")));}catch{throw new JobError("invalid");}
}

function configuration(operation:OperationId,env:Environment){
  if(operation==="diagnostics")throw new JobError("invalid");
  const result=resolveProviderConfiguration(operation,env);
  if(!result.ok)throw new JobError(result.code,result.detail);
  return result.value;
}
export function providerReadiness(env:Environment=process.env){
  return getOperationsReadiness(env).providers;
}
async function currentPlan(operation:OperationId,deps:ProviderDependencies){
  const env=deps.env??process.env,config=configuration(operation,env),fetcher=deps.fetcher??fetch;
  const response=await providerFetch(`https://api.github.com/repos/${config.execution.repository}/commits/${encodeURIComponent(config.execution.branch)}`,{headers:githubHeaders(env.CORTEX_ACTIONS_TOKEN!)},fetcher);
  if(!response.ok)throw new JobError("unavailable","Application source SHA unavailable");
  const value=z.object({sha:z.string().regex(SHA)}).passthrough().safeParse(await providerJson(response));if(!value.success)throw new JobError("unavailable","Application source SHA unavailable");
  const sourceSha=value.data.sha;
  if(operation==="migrations.apply"){
    if(env.VERCEL_GIT_COMMIT_SHA!==sourceSha)throw new JobError("unavailable","Apply requires this application's deployed SHA to equal the selected source SHA; corpus SHA is not proof");
    if(!deps.store.migrationLedger)throw new JobError("unavailable","Migration ledger reader unavailable");
    try{const ledger=await deps.store.migrationLedger();if(ledger.state!=="present")throw new Error("prerequisite");const plan=migrationPlan((deps.files??readMigrationFiles)(),ledger);if(plan.legacyChecksums)throw new Error("legacy");config.execution.pendingDigest=plan.digest;}catch{throw new JobError("unavailable","Migration ledger, exact shipped files or checksum prerequisites unavailable");}
  }
  if(mutation(operation)&&!deps.store.lastUnresolved)throw new JobError("unavailable","Unresolved mutation reader unavailable");
  const unresolvedId=mutation(operation)?await deps.store.lastUnresolved!():null;
  return {...config,sourceSha,unresolvedId};
}
export async function prepareProviderJob(raw:unknown,deps:ProviderDependencies){
  const parsed=z.object({operation:operationIdSchema,requestKey:z.uuidv4()}).strict().safeParse(raw);if(!parsed.success||parsed.data.operation==="diagnostics")throw new JobError("invalid");
  const plan=await currentPlan(parsed.data.operation,deps),expiresAt=new Date((deps.now??Date.now)()+300000).toISOString();
  const body:Intent={version:1,...parsed.data,...plan,expiresAt};const payload=Buffer.from(JSON.stringify(body)).toString("base64url");
  return {operation:body.operation,requestKey:body.requestKey,sourceSha:body.sourceSha,target:body.target,pendingDigest:body.execution.pendingDigest,expiresAt,intent:`${payload}.${sign(payload,deps.env??process.env)}`,warning:body.unresolvedId?`Earlier job ${body.unresolvedId} remains unresolved and may still finish. This new mutation can duplicate external work.`:"Review the immutable source and fixed target. Admission is not execution success."};
}
export async function requestProviderJob(raw:unknown,deps:ProviderDependencies):Promise<ConsoleJob>{
  const parsed=z.object({operation:operationIdSchema,requestKey:z.uuidv4(),intent:z.string().max(4096),confirm:z.literal(true)}).strict().safeParse(raw);if(!parsed.success)throw new JobError("invalid");
  const env=deps.env??process.env,body=decode(parsed.data.intent,env);
  if(body.operation!==parsed.data.operation||body.requestKey!==parsed.data.requestKey||body.operation==="diagnostics")throw new JobError("invalid");
  const fingerprint=createHash("sha256").update(parsed.data.intent).digest("hex");
  const prior=await deps.store.findByRequest(body.requestKey);
  if(prior){if(prior.fingerprint!==fingerprint)throw new JobError("key_conflict");if(prior.job.state!=="queued")return prior.job;}
  if(Date.parse(body.expiresAt)<=(deps.now??Date.now)())throw new JobError("conflict");
  const current=await currentPlan(body.operation,deps);
  if(Date.parse(body.expiresAt)<=(deps.now??Date.now)())throw new JobError("conflict");
  if(current.sourceSha!==body.sourceSha||current.target!==body.target||current.unresolvedId!==body.unresolvedId||JSON.stringify(current.execution)!==JSON.stringify(body.execution))throw new JobError("conflict");
  return executeJobAdmission({requestKey:body.requestKey,fingerprint,operation:body.operation,target:body.target,sourceSha:body.sourceSha,execution:body.execution,unresolvedId:body.unresolvedId,expiresAt:body.expiresAt},{store:deps.store,adapters:[{supports:()=>true,async execute(_op,_target,_signal,job){
    const dispatch=body.execution.provider==="github"?await githubDispatch(job,body.execution,env.CORTEX_ACTIONS_TOKEN!,deps.fetcher):await vercelDispatch(job,body.execution,env.CORTEX_VERCEL_TOKEN!,deps.fetcher);
    return dispatch.kind==="accepted"?{state:"running",checks:[],summary:"Provider accepted · awaiting execution status",providerId:dispatch.providerId}:dispatch.kind==="rejected"?{state:"failed",checks:[{name:"provider admission",state:"failed",detail:dispatch.code}],summary:"Provider rejected the request · no accepted run identified",providerId:null}:{state:"uncertain",checks:[{name:"provider admission",state:"unavailable",detail:dispatch.code}],summary:"Provider outcome uncertain · lookup this receipt; never automatically resend",providerId:null};
  }}]});
}
/** `reconciled` is present only when a verified provider status reached the store: `published`
 *  (attached), `resumed` (the receipt was uncertain — marked so by an operator while its provider
 *  was healthy, or acknowledged — and the provider verifiably has the run in progress, so it is
 *  running again under its original token; a mutation holds the guard again), `stale` (an observer
 *  lease or token no longer valid) or `conflict` (the provider still reports an acknowledged
 *  receipt running while a later command owns its target or another mutation holds the guard; the
 *  receipt stays uncertain and its summary names the holder). It is an outcome, never a swallowed
 *  error, and the decision behind `resumed` is in migration 20260909043000's header. */
export type ProviderReconciliation={job:ConsoleJob;output?:SafeJobOutput;reconciled?:"published"|"resumed"|"stale"|"conflict"};
export async function reconcileProviderJob(id:string,deps:ProviderDependencies,logs=false):Promise<ProviderReconciliation>{
  const existing=await deps.store.get(id);if(!existing)throw new JobError("invalid");
  if(!logs&&!["running","uncertain"].includes(existing.state))return {job:existing};
  if(!deps.store.claimReconciliation||!deps.store.publishReconciliation||!deps.store.releaseReconciliation)return {job:existing,...(logs?{output:{available:false,text:"Provider status unavailable",clipped:false}}:{})};
  const claim=await deps.store.claimReconciliation(id);if(!claim)return {job:existing,...(logs?{output:{available:false,text:"Status lookup throttled or unavailable",clipped:false}}:{})};
  try{
    const env=deps.env??process.env,configured=configuration(claim.job.operation,env);
    const exactSecrets=[env.CORTEX_ACTIONS_TOKEN,env.CORTEX_VERCEL_TOKEN,env.SUPABASE_SERVICE_ROLE_KEY].filter((value):value is string=>Boolean(value));
    const {pendingDigest:_digest,...saved}=claim.execution;const {pendingDigest:_pending,...current}=configured.execution;
    if(JSON.stringify(saved)!==JSON.stringify(current)||configured.target!==claim.job.target)throw new Error("provider configuration changed");
    const status=claim.execution.provider==="github"?await githubStatus(claim.job,claim.execution,env.CORTEX_ACTIONS_TOKEN!,deps.fetcher,exactSecrets):await vercelStatus(claim.job,claim.execution,env.CORTEX_VERCEL_TOKEN!,deps.fetcher);
    if(!status)return {job:existing,...(logs?{output:{available:false,text:"Provider identity or status unavailable",clipped:false}}:{})};
    const result=claim.token?await deps.store.publishReconciliation(id,claim.token,claim.pollToken,status):null;const job=result?result.job:existing;let output:SafeJobOutput|undefined;
    if(logs){try{output=claim.execution.provider==="github"?await githubLogs(job,claim.execution,env.CORTEX_ACTIONS_TOKEN!,deps.fetcher,exactSecrets):await vercelLogs(job,claim.execution,env.CORTEX_VERCEL_TOKEN!,deps.fetcher,exactSecrets);}catch{output={available:false,text:"Provider logs unavailable",clipped:false};}}
    return{job,...(result?{reconciled:result.outcome}:{}),...(output?{output}:{})};
  }catch{return {job:existing,...(logs?{output:{available:false,text:"Provider status unavailable",clipped:false}}:{})};}
  finally{await deps.store.releaseReconciliation(id,claim.pollToken).catch(()=>{});}
}
