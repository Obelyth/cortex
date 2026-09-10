import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { __setConsoleJobStore } from "../lib/console-job-store";
import { type ConsoleJob, type ConsoleJobStore } from "../lib/console-jobs";
import { STAMP_COOKIE, stampValue } from "../lib/stamp";
import { GET, POST } from "../app/s/[secret]/console/ops/jobs/route";
import { GET as GET_ONE,POST as ACK_ONE } from "../app/s/[secret]/console/ops/jobs/[id]/route";

const now = "2026-09-08T18:00:00.000Z";
const id = "11111111-1111-4111-8111-111111111111";
const job: ConsoleJob = { id, operation: "diagnostics", state: "succeeded", requestedAt: now, updatedAt: now, sourceSha: "abcdef12", target: "deployment", checks: [{ name: "source", state: "passed", detail: "observed now" }], summary: "1 passed", providerId: null };
let writes: number;
function store(): ConsoleJobStore {
  return {
    enqueue: async () => ({ outcome: "enqueued", job: { ...job, state: "queued", checks: [], summary: "Queued" } }),
    claim: async () => ({ outcome: "claimed", job: { ...job, state: "running", checks: [], summary: "Queued" }, token: "22222222-2222-4222-8222-222222222222" }),
    publish: async (_id, _token, completion) => { writes++; return { outcome: "published", job: { ...job, ...completion } }; },
    get: async (value) => value === id ? job : null,
    findByRequest: async () => null,
    list: async () => ({ items: [{...job,checks:undefined,checkCount:1} as never], nextCursor: "next-safe-cursor" }),
    acknowledgeUncertain: async () => job,
    markUncertain: async () => ({...job,state:"uncertain",summary:"Diagnostic outcome uncertain"}),
  };
}
const ctx = { params: Promise.resolve({ secret: "synthetic-secret" }) };
const oneCtx = { params: Promise.resolve({ secret: "synthetic-secret", id }) };
function request(method = "GET", body?: unknown, options: { stamp?: boolean; origin?: string } = {}) {
  return new Request("https://console.invalid/s/synthetic-secret/console/ops/jobs", { method, headers: { ...(body ? { "content-type": "application/json" } : {}), ...(method === "POST" ? { origin: options.origin ?? "https://console.invalid" } : {}), ...(options.stamp === false ? {} : { cookie: `${STAMP_COOKIE}=${stampValue()}` }) }, ...(body ? { body: JSON.stringify(body) } : {}) });
}

beforeEach(() => {
  writes = 0;
  __setConsoleJobStore(store());
  vi.stubEnv("CONNECTOR_PATH_SECRET", "synthetic-secret");
  vi.stubEnv("CONSOLE_PASSCODE", "synthetic-passcode");
});
afterEach(() => { __setConsoleJobStore(undefined); vi.unstubAllEnvs();vi.unstubAllGlobals(); });

describe("guarded console job routes", () => {
  it("prepares a fixed app-source intent then preserves one uncertain receipt across response-lost provider retries",async()=>{
    vi.stubEnv("CORTEX_APP_REPO","fixture/app");vi.stubEnv("CORTEX_APP_BRANCH","main");vi.stubEnv("CORTEX_ACTIONS_TOKEN","synthetic-actions");
    let receipt:ConsoleJob|null=null,fingerprint="",posts=0;const source="b".repeat(40),s=store();
    s.findByRequest=async()=>receipt?{job:receipt,fingerprint}:null;
    s.enqueue=async(input)=>{fingerprint=input.fingerprint;receipt={...job,state:"queued",operation:input.operation,target:input.target,sourceSha:input.sourceSha};return{outcome:"enqueued",job:receipt};};
    s.claim=async()=>{receipt={...receipt!,state:"running"};return{outcome:"claimed",job:receipt,token:"22222222-2222-4222-8222-222222222222"};};
    s.publish=async(_id,_token,c)=>{receipt={...receipt!,...c};return{outcome:"published",job:receipt};};s.get=async()=>receipt;__setConsoleJobStore(s);
    vi.stubGlobal("fetch",async(_url:string,init?:RequestInit)=>{if(init?.method==="POST"){posts++;throw new Error("response lost");}return Response.json({sha:source});});
    const prepared=await POST(request("POST",{action:"prepare",operation:"checks",requestKey:id}),ctx);expect(prepared.status).toBe(200);
    const value=await prepared.json();expect(value.preparation.sourceSha).toBe(source);
    const command={operation:"checks",requestKey:id,intent:value.preparation.intent,confirm:true};
    for(let n=0;n<2;n++){const response=await POST(request("POST",command),ctx);expect(response.status).toBe(200);expect((await response.json()).job.state).toBe("uncertain");}
    expect(posts).toBe(1);
  });
  it("returns validated, no-store list and detail DTOs", async () => {
    const list = await GET(request(), ctx);
    expect(list.status).toBe(200); expect(list.headers.get("cache-control")).toBe("no-store");
    expect(await list.json()).toMatchObject({ items: [{id,checkCount:1}], nextCursor: "next-safe-cursor", historyPolicy: expect.stringContaining("30 days") });
    const detail = await GET_ONE(new Request(`https://console.invalid/s/synthetic-secret/console/ops/jobs/${id}`, { headers: { cookie: `${STAMP_COOKIE}=${stampValue()}` } }), oneCtx);
    expect(await detail.json()).toEqual({ job });
  });

  it("runs an authorized diagnostic and validates the response shape", async () => {
    const res = await POST(request("POST", { operation: "diagnostics", requestKey: id, target: "deployment" }), ctx);
    expect(res.status).toBe(200); expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.json()).toMatchObject({job:{operation:"diagnostics",state:expect.stringMatching(/^(succeeded|failed)$/)}}); expect(writes).toBe(1);
  });

  it.each([
    [()=>request("GET", undefined, { stamp: false }), ctx, GET, 404],
    [()=>request("POST", { operation: "diagnostics", requestKey: id }, { stamp: false }), ctx, POST, 404],
    [()=>request("POST", { operation: "diagnostics", requestKey: id }, { origin: "https://other.invalid" }), ctx, POST, 403],
  ])("independently refuses unauthorized and cross-origin requests", async (make, context, handler, status) => {
    expect((await handler(make(), context)).status).toBe(status); expect(writes).toBe(0);
  });

  it("stops reading a streaming body once the 8 KiB limit is exceeded", async () => {
    let pulls = 0, cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) { pulls++; controller.enqueue(new Uint8Array(5_000)); if (pulls > 5) controller.close(); },
      cancel() { cancelled = true; },
    });
    const req = new Request("https://console.invalid/s/synthetic-secret/console/ops/jobs", { method: "POST", headers: { "content-type": "application/json", origin: "https://console.invalid", cookie: `${STAMP_COOKIE}=${stampValue()}` }, body: stream, duplex: "half" } as RequestInit & { duplex: "half" });
    const res = await POST(req, ctx);
    expect(res.status).toBe(413); expect(cancelled).toBe(true); expect(pulls).toBeLessThanOrEqual(3); expect(writes).toBe(0);
  });
  it("bounds elapsed body-read time before command admission",async()=>{
    vi.useFakeTimers();
    const stream=new ReadableStream<Uint8Array>({pull(){return new Promise(()=>{});}});
    const req=new Request("https://console.invalid/s/synthetic-secret/console/ops/jobs",{method:"POST",headers:{"content-type":"application/json",origin:"https://console.invalid",cookie:`${STAMP_COOKIE}=${stampValue()}`},body:stream,duplex:"half"} as RequestInit&{duplex:"half"});
    const pending=POST(req,ctx);await vi.advanceTimersByTimeAsync(8_000);const res=await pending;
    expect(res.status).toBe(400);expect(await res.json()).toMatchObject({code:"invalid",error:"command body read timed out"});expect(writes).toBe(0);vi.useRealTimers();
  });

  it.each(["checks", "migrations.check", "migrations.apply", "deploy.preview", "deploy.production"] as const)("refuses a bare %s request — provider work arrives only through a signed intent", async (operation) => {
    // Before this pin a bare request naming a provider operation, with a target and SHA of its
    // own choosing, was admitted: it took the mutation guard and landed in history as a failed
    // receipt against a target nothing had checked. Without an intent this door runs diagnostics.
    const res = await POST(request("POST", { operation, requestKey: id, target: "vercel:prj_real:production", sourceSha: "a".repeat(40) }), ctx);
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ code: "invalid" });
    expect(writes).toBe(0);
  });

  it("names the one-time provider bootstrap when admission RPC is absent", async () => {
    const missing = store(); missing.enqueue = async () => { const { JobError } = await import("../lib/console-jobs"); throw new JobError("schema_required"); };
    __setConsoleJobStore(missing);
    const res = await POST(request("POST", { operation: "diagnostics", requestKey: id }), ctx);
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ code: "schema_required", migration: "supabase/migrations/20260908160000_console_jobs.sql",migrations:["supabase/migrations/20260908160000_console_jobs.sql","supabase/migrations/20260908163000_console_job_claim_recovery.sql","supabase/migrations/20260908205956_console_job_providers.sql","supabase/migrations/20260908221155_console_job_provider_fences.sql","supabase/migrations/20260909041000_console_job_recovery_exits.sql","supabase/migrations/20260909043000_console_job_guard_invariant.sql"] });
    expect(writes).toBe(0);
  });

  it("maps malformed success to a fixed safe error", async () => {
    const malformed = store(); malformed.enqueue = async () => ({ outcome: "enqueued", job: { ...job, id: "bad" } });
    __setConsoleJobStore(malformed);
    const res = await POST(request("POST", { operation: "diagnostics", requestKey: id }), ctx);
    expect(res.status).toBe(502); expect(await res.json()).toEqual({ code: "malformed", error: "command store returned an invalid response" });
  });
  it("guards explicit unresolved acknowledgment and returns a minimal confirmation",async()=>{
    const ackStore=store();ackStore.acknowledgeUncertain=async()=>({...job,operation:"deploy.production",state:"uncertain",summary:"unresolved"});__setConsoleJobStore(ackStore);
    const req=new Request(`https://console.invalid/s/synthetic-secret/console/ops/jobs/${id}`,{method:"POST",headers:{"content-type":"application/json",origin:"https://console.invalid",cookie:`${STAMP_COOKIE}=${stampValue()}`},body:JSON.stringify({action:"acknowledge-unresolved"})});
    const res=await ACK_ONE(req,oneCtx);expect(res.status).toBe(200);expect(await res.json()).toMatchObject({acknowledged:true,job:{id,state:"uncertain"}});
  });
  it("explicitly fences an abandoned read-only diagnostic before a new run",async()=>{
    const req=new Request(`https://console.invalid/s/synthetic-secret/console/ops/jobs/${id}`,{method:"POST",headers:{"content-type":"application/json",origin:"https://console.invalid",cookie:`${STAMP_COOKIE}=${stampValue()}`},body:JSON.stringify({action:"mark-uncertain"})});
    const res=await ACK_ONE(req,oneCtx);expect(res.status).toBe(200);expect(await res.json()).toMatchObject({markedUncertain:true,job:{id,operation:"diagnostics",state:"uncertain"}});
  });
  it.each([["mark-uncertain"],{kind:"mark-uncertain"},null])("rejects a non-string action without invoking either mutation RPC",async(action)=>{
    const guarded=store();guarded.acknowledgeUncertain=vi.fn(guarded.acknowledgeUncertain);guarded.markUncertain=vi.fn(guarded.markUncertain);__setConsoleJobStore(guarded);
    const req=new Request(`https://console.invalid/s/synthetic-secret/console/ops/jobs/${id}`,{method:"POST",headers:{"content-type":"application/json",origin:"https://console.invalid",cookie:`${STAMP_COOKIE}=${stampValue()}`},body:JSON.stringify({action})});
    const res=await ACK_ONE(req,oneCtx);expect(res.status).toBe(400);expect(guarded.acknowledgeUncertain).not.toHaveBeenCalled();expect(guarded.markUncertain).not.toHaveBeenCalled();
  });
});
