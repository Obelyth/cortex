import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  JobError,
  prepareJobRequest,
  requestJob,
  type ConsoleJob,
  type ConsoleJobStore,
  type JobCheck,
  type JobRequest,
} from "../lib/console-jobs";
import { __setConsoleJobStore, consoleJobStore } from "../lib/console-job-store";
import { parseJobRecovery } from "../lib/console-job-contract";
import { parseOpsActionResponse } from "../lib/ops-action-response";

const REQUEST_KEY = "11111111-1111-4111-8111-111111111111";
const NOW = "2026-09-08T18:00:00.000Z";

function memoryStore(): ConsoleJobStore {
  const jobs = new Map<string, ConsoleJob>();
  const requests = new Map<string, { fingerprint: string; id: string }>();
  return {
    async enqueue(input) {
      const prior = requests.get(input.requestKey);
      if (prior) {
        if (prior.fingerprint !== input.fingerprint) return { outcome: "key_conflict" as const };
        return { outcome: "replay" as const, job: jobs.get(prior.id)! };
      }
      const job: ConsoleJob = { id: input.requestKey, operation: input.operation, state: "queued", requestedAt: NOW, updatedAt: NOW, sourceSha: input.sourceSha, target: input.target, checks: [], summary: "Queued", providerId: null };
      requests.set(input.requestKey, { fingerprint: input.fingerprint, id: job.id });
      jobs.set(job.id, job);
      return { outcome: "enqueued" as const, job };
    },
    async claim(id, _ownerToken) {
      const job = jobs.get(id)!;
      if (job.state !== "queued") return { outcome: "not_claimed" as const, job };
      const running = { ...job, state: "running" as const, updatedAt: NOW };
      jobs.set(id, running);
      return { outcome: "claimed" as const, job: running, token: "22222222-2222-4222-8222-222222222222" };
    },
    async publish(id, _token, completion) {
      const job = { ...jobs.get(id)!, ...completion, updatedAt: NOW };
      jobs.set(id, job);
      return { outcome: "published" as const, job };
    },
    async get(id) { return jobs.get(id) ?? null; },
    async findByRequest(requestKey) { const r = requests.get(requestKey); const found=r?jobs.get(r.id):null;return r&&found?{job:found,fingerprint:r.fingerprint}:null; },
    async list() { return { items: [...jobs.values()].map(({checks,...value})=>({...value,checkCount:checks.length})), nextCursor: null }; },
    async acknowledgeUncertain() { throw new Error("unused"); },
    async markUncertain() { throw new Error("unused"); },
  };
}

const checks: JobCheck[] = [{ name: "corpus", state: "passed", detail: "observed 2026-09-08T18:00:00.000Z · corpus SHA abcdef12" }];
const input: JobRequest = { operation: "diagnostics", requestKey: REQUEST_KEY, target: "deployment" };

describe("console job orchestration", () => {
  let store: ConsoleJobStore;
  beforeEach(() => { store = memoryStore(); });

  it("coalesces overlapping identical diagnostics through real enqueue and claim composition", async () => {
    let probeCalls = 0;
    const diagnostics = vi.fn(async () => { probeCalls++; await new Promise((resolve) => setTimeout(resolve, 10)); return { checks, summary: "1 passed", sourceSha: "abcdef12" }; });
    const [first, second] = await Promise.all([
      requestJob(input, { store, diagnostics }),
      requestJob(input, { store, diagnostics }),
    ]);
    expect(first.id).toBe(second.id);
    expect(probeCalls).toBe(1);
    expect((await store.get(first.id))?.state).toBe("succeeded");
  });

  it("rejects a request-key replay with changed canonical input", async () => {
    await requestJob(input, { store, diagnostics: async () => ({ checks, summary: "ok", sourceSha: null }) });
    await expect(requestJob({ ...input, target: "different" }, { store, diagnostics: async () => ({ checks, summary: "ok", sourceSha: null }) })).rejects.toMatchObject({ code: "key_conflict" });
  });

  it.each(["capacity", "mutation_busy", "schema_required"] as const)("surfaces %s admission truthfully", async (code) => {
    store.enqueue = async () => { if (code === "schema_required") throw new JobError(code); return { outcome: code }; };
    await expect(requestJob(input, { store, diagnostics: async () => ({ checks, summary: "ok", sourceSha: null }) })).rejects.toMatchObject({ code });
  });

  it("reconciles a lost enqueue response by request key without issuing a second enqueue", async () => {
    const original = store.enqueue.bind(store);
    let calls = 0;
    store.enqueue = async (request) => { calls++; const result = await original(request); throw new JobError("uncertain", "response lost"); };
    const job = await requestJob(input, { store, diagnostics: async () => ({ checks, summary: "ok", sourceSha: null }) });
    expect(job.state).toBe("succeeded");
    expect(calls).toBe(1);
  });
  it("recovers the same durable claim owner after its committed reply is lost, then probes once",async()=>{
    const original=store.claim.bind(store);let durableOwner:string|undefined,claimCalls=0,lose=true;
    store.claim=async(id:string,owner:string)=>{claimCalls++;if(!durableOwner){durableOwner=owner;const claimed=await original(id,owner);if(lose){lose=false;throw new JobError("uncertain");}return claimed;}if(owner===durableOwner){const running=(await store.get(id))!;return{outcome:"claimed",job:running,token:"22222222-2222-4222-8222-222222222222"};}return{outcome:"not_claimed",job:(await store.get(id))!};};
    const diagnostics=vi.fn(async()=>({checks,summary:"recovered",sourceSha:"abcdef12"}));
    const result=await requestJob(input,{store,diagnostics});expect(result.state).toBe("succeeded");expect(claimCalls).toBe(2);expect(diagnostics).toHaveBeenCalledTimes(1);
  });
  it("does not adopt or execute an older job when a changed-input conflict response is lost",async()=>{
    const original=store.enqueue.bind(store);await original(prepareJobRequest(input));
    store.enqueue=async()=>{throw new JobError("uncertain");};const diagnostics=vi.fn(async()=>({checks,summary:"wrong",sourceSha:null}));
    await expect(requestJob({...input,target:"different"},{store,diagnostics})).rejects.toMatchObject({code:"key_conflict"});expect(diagnostics).not.toHaveBeenCalled();
  });

  it("rejects malformed store success instead of claiming a command succeeded", async () => {
    store.enqueue = async () => ({ outcome: "enqueued", job: { id: "not-a-uuid" } as ConsoleJob });
    await expect(requestJob(input, { store, diagnostics: async () => ({ checks, summary: "ok", sourceSha: null }) })).rejects.toMatchObject({ code: "malformed" });
  });
  it("names the receipt holding the slot when admission is refused as active, and still refuses without one", async () => {
    const held: ConsoleJob = { id: "33333333-3333-4333-8333-333333333333", operation: "diagnostics", state: "queued", requestedAt: NOW, updatedAt: NOW, sourceSha: null, target: "deployment", checks: [], summary: "Queued", providerId: null };
    store.enqueue = async () => ({ outcome: "active", job: held });
    const named = await requestJob(input, { store, diagnostics: async () => ({ checks, summary: "unused", sourceSha: null }) }).catch((e: unknown) => e);
    expect(named).toBeInstanceOf(JobError);
    expect((named as JobError).code).toBe("active"); expect((named as JobError).activeId).toBe(held.id); expect((named as JobError).message).toContain(held.id);
    store.enqueue = async () => ({ outcome: "active" });
    const plain = await requestJob(input, { store, diagnostics: async () => ({ checks, summary: "unused", sourceSha: null }) }).catch((e: unknown) => e);
    expect((plain as JobError).code).toBe("active"); expect((plain as JobError).activeId).toBeUndefined();
    store.enqueue = async () => ({ outcome: "active", job: { id: "not-a-uuid" } as ConsoleJob });
    expect(((await requestJob(input, { store, diagnostics: async () => ({ checks, summary: "unused", sourceSha: null }) }).catch((e: unknown) => e)) as JobError).activeId).toBeUndefined();
  });
  it("keeps an identified provider acceptance running, never succeeded",async()=>{
    let posts=0;
    const adapter={supports:()=>true,execute:async()=>{posts++;return {state:"running",checks:[],summary:"Provider accepted; awaiting execution",providerId:"123"};}};
    const command={...input,operation:"checks" as const};
    const accepted=await requestJob(command,{store,adapters:[adapter as never]});
    expect(accepted.state).toBe("running");expect(accepted.providerId).toBe("123");
    await requestJob(command,{store,adapters:[adapter as never]});expect(posts).toBe(1);
  });
  it("persists a small terminal fallback when a valid completion exceeds the SQL UTF-8 envelope",async()=>{
    const original=store.publish.bind(store);let published:unknown;
    store.publish=async(id,token,completion)=>{published=completion;if(Buffer.byteLength(JSON.stringify({checks:completion.checks,summary:completion.summary}),"utf8")>32_768)throw new JobError("malformed");return original(id,token,completion);};
    const large=Array.from({length:64},(_,i)=>({name:`check-${i}`,state:"passed" as const,detail:"é".repeat(500)}));
    const result=await requestJob(input,{store,diagnostics:async()=>({checks:large,summary:"complete",sourceSha:"abcdef12"})});
    expect(result.state).toBe("succeeded");expect(result.checks).toEqual([{name:"result envelope",state:"unavailable",detail:"Detailed results exceeded the durable receipt limit and were omitted."}]);expect(Buffer.byteLength(JSON.stringify(published),"utf8")).toBeLessThan(32_768);
  });

  it.each(["checks", "migrations.check", "migrations.apply", "deploy.preview", "deploy.production"] as const)("records unsupported %s work as failed with a concrete prerequisite and no dispatch", async (operation) => {
    const diagnostics = vi.fn(async () => ({ checks, summary: "unused", sourceSha: null }));
    const job = await requestJob({ ...input, operation }, { store, diagnostics });
    expect(job.state).toBe("failed");
    expect(job.summary).toContain("provider not configured");
    expect(job.checks[0]).toMatchObject({ state: "unavailable" });
    expect(diagnostics).not.toHaveBeenCalled();
  });
});

describe("bounded history transport", () => {
  afterEach(()=>{__setConsoleJobStore(undefined);vi.unstubAllEnvs();vi.unstubAllGlobals();});
  it("lists 25 summary DTOs while a legitimate maximum-check receipt remains readable on open",async()=>{
    __setConsoleJobStore(undefined);vi.stubEnv("SUPABASE_URL","https://synthetic.invalid");vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY","synthetic-key");
    const rows=Array.from({length:26},(_,index)=>({id:`${String(index+1).padStart(8,"0")}-1111-4111-8111-111111111111`,operation:"diagnostics",state:"succeeded",requested_at:NOW,updated_at:NOW,source_sha:"abcdef12",target:`target-${index}`,summary:"64 checks complete",check_count:64,provider_id:null}));
    const checks=Array.from({length:64},(_,index)=>({name:`check-${index}`,state:"passed",detail:"x".repeat(500)}));
    let sawSummarySelect=false;
    vi.stubGlobal("fetch",async(url:string)=>{
      if(url.includes("order=requested_at")){sawSummarySelect=url.includes("summary,check_count")&&!url.includes(",result,");return Response.json(rows);}
      return Response.json([{...rows[0],result:{checks,summary:"64 checks complete"}}]);
    });
    const store=consoleJobStore()!;const page=await store.list();
    expect(sawSummarySelect).toBe(true);expect(page.items).toHaveLength(25);expect(page.items[0]).not.toHaveProperty("checks");expect(page.nextCursor).toBeTruthy();
    expect((await store.get(rows[0].id))?.checks).toHaveLength(64);
  });
});

describe("recovery transport after migration 20260909041000", () => {
  afterEach(() => { __setConsoleJobStore(undefined); vi.unstubAllEnvs(); vi.unstubAllGlobals(); });
  const row = (over: Record<string, unknown> = {}) => ({ id: "11111111-1111-4111-8111-111111111111", operation: "diagnostics", state: "queued", requested_at: NOW, updated_at: NOW, source_sha: null, target: "deployment", result: { checks: [], summary: "Queued" }, provider_id: null, ...over });
  const armed = (answer: (path: string, body: Record<string, unknown>) => unknown) => {
    __setConsoleJobStore(undefined); vi.stubEnv("SUPABASE_URL", "https://synthetic.invalid"); vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "synthetic-key");
    const calls: Array<{ path: string; body: Record<string, unknown> }> = [];
    vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => { const path = new URL(url).pathname.replace("/rest/v1/", ""); const body = init?.body ? JSON.parse(String(init.body)) : {}; calls.push({ path, body }); return Response.json(answer(path, body)); });
    return { store: consoleJobStore()!, calls };
  };
  it("marks a queued diagnostic uncertain through the store instead of refusing it client-side", async () => {
    const { store, calls } = armed(() => ({ outcome: "marked_uncertain", job: row({ state: "uncertain", result: { checks: [{ name: "diagnostic execution", state: "unavailable", detail: "never claimed" }], summary: "The request that queued this job never claimed it · nothing was dispatched · a new request can proceed" } }) }));
    const recovered = await store.markUncertain("11111111-1111-4111-8111-111111111111");
    expect(recovered.state).toBe("uncertain"); expect(recovered.summary).toContain("never claimed it");
    expect(calls).toEqual([{ path: "rpc/console_job_mark_uncertain", body: { job_id: "11111111-1111-4111-8111-111111111111" } }]);
    expect(parseJobRecovery({ markedUncertain: true, job: recovered }, { ...recovered, state: "queued" })).toEqual(recovered);
  });
  it("still refuses a terminal receipt as invalid with a message that names both admissible states", async () => {
    const { store } = armed(() => ({ outcome: "not_running", job: row({ state: "succeeded" }) }));
    const failure = await store.markUncertain("11111111-1111-4111-8111-111111111111").catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(JobError); expect((failure as JobError).code).toBe("invalid"); expect((failure as JobError).message).toBe("only queued or running commands can be marked uncertain");
  });
  it("carries the receipt named by an active refusal and degrades to the plain refusal on a malformed one", async () => {
    const admission = prepareJobRequest(input);
    const { store } = armed(() => ({ outcome: "active", job: row() }));
    expect(await store.enqueue(admission)).toMatchObject({ outcome: "active", job: { id: "11111111-1111-4111-8111-111111111111", state: "queued" } });
    const { store: older } = armed(() => ({ outcome: "active" }));
    expect(await older.enqueue(admission)).toEqual({ outcome: "active" });
    const { store: broken } = armed(() => ({ outcome: "active", job: { id: "bad" } }));
    expect(await broken.enqueue(admission)).toEqual({ outcome: "active" });
  });
  it("accepts the conflict and resumed publication outcomes as receipts, not malformed replies", async () => {
    const conflict = row({ operation: "deploy.production", state: "uncertain", target: "vercel:prj_fixture:production", provider_id: "dpl_first", result: { checks: [], summary: "Provider still reports this run in progress · a later deploy.production command now owns vercel:prj_fixture:production · this receipt stays uncertain" } });
    const { store } = armed(() => ({ outcome: "conflict", job: conflict }));
    const completion = { state: "running" as const, checks: [], summary: "Provider run in progress", providerId: "dpl_first" };
    expect(await store.publish(conflict.id as string, "22222222-2222-4222-8222-222222222222", completion)).toMatchObject({ outcome: "conflict", job: { state: "uncertain", summary: expect.stringContaining("later deploy.production command") } });
    expect(await store.publishReconciliation!(conflict.id as string, "22222222-2222-4222-8222-222222222222", "44444444-4444-4444-8444-444444444444", completion)).toMatchObject({ outcome: "conflict" });
    const resumed = row({ operation: "deploy.production", state: "running", target: "vercel:prj_fixture:production", provider_id: "dpl_first", result: { checks: [], summary: "Provider run in progress" } });
    const { store: back } = armed(() => ({ outcome: "resumed", job: resumed }));
    expect(await back.publish(resumed.id as string, "22222222-2222-4222-8222-222222222222", completion)).toMatchObject({ outcome: "resumed", job: { state: "running", summary: "Provider run in progress" } });
    expect(await back.publishReconciliation!(resumed.id as string, "22222222-2222-4222-8222-222222222222", "44444444-4444-4444-8444-444444444444", completion)).toMatchObject({ outcome: "resumed", job: { state: "running" } });
  });
});

describe("claim against a database without the owner-aware overload", () => {
  afterEach(() => { __setConsoleJobStore(undefined); vi.unstubAllEnvs(); vi.unstubAllGlobals(); });
  it("reports schema_required and dispatches nothing — the retry after an uncertain reply depends on this", async () => {
    // The retry in executeJobAdmission re-sends the same owner token and trusts the two-argument
    // console_job_claim (migration 20260908163000) to hand back the original dispatch token
    // rather than claim again. A database that only has the one-argument overload must not
    // satisfy that call: PostgREST matches overloads by the named parameters and answers
    // PGRST202 when none fits, and the store turns that into schema_required.
    __setConsoleJobStore(undefined); vi.stubEnv("SUPABASE_URL", "https://synthetic.invalid"); vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "synthetic-key");
    const bodies: string[] = [];
    vi.stubGlobal("fetch", async (_url: string, init?: RequestInit) => {
      bodies.push(String(init?.body));
      return Response.json({ code: "PGRST202", message: "Could not find the function public.console_job_claim(job_id, owner_token) in the schema cache" }, { status: 404 });
    });
    const store = consoleJobStore()!;
    const failure = await store.claim("11111111-1111-4111-8111-111111111111", "22222222-2222-4222-8222-222222222222").catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(JobError);
    expect((failure as JobError).code).toBe("schema_required");
    expect(bodies).toHaveLength(1);
    expect(JSON.parse(bodies[0])).toHaveProperty("owner_token", "22222222-2222-4222-8222-222222222222");
  });
});

describe("existing Ops action response truth",()=>{
  it("accepts only a validated 200 receipt and keeps a prepared link distinct",()=>{
    expect(parseOpsActionResponse(200,{ok:true,receipt:42,opened:"https://claude.ai/new"})).toEqual({outcome:"confirmed",receipt:42,opened:"https://claude.ai/new"});
    expect(parseOpsActionResponse(200,{receipt:42})).toMatchObject({outcome:"uncertain"});
  });
  it("preserves a returned receipt and treats transport-class outcomes as uncertain",()=>{
    expect(parseOpsActionResponse(502,{ok:false,error:"dispatch unavailable",receipt:51})).toMatchObject({outcome:"uncertain",message:expect.stringContaining("receipt 51")});
    expect(parseOpsActionResponse(502,{error:"provider-secret-value"})).toEqual({outcome:"uncertain",message:"Outcome uncertain · recheck receipts before retrying"});
  });
});
