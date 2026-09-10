import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { __setBubbleStore } from "../lib/bubble";
import { stampValue, STAMP_COOKIE } from "../lib/stamp";
import { POST, GET } from "../app/s/[secret]/console/working-state/route";

const item = { id: 7, version: 1, kind: "handoff", project: "harbor", body: "Next: review", status: "open", touched_at: "2026-09-08T12:00:00Z" };
let writes: unknown[];
beforeEach(() => {
  writes=[]; __setBubbleStore(undefined);
  vi.stubEnv("CONNECTOR_PATH_SECRET","synthetic-secret"); vi.stubEnv("CONSOLE_PASSCODE","synthetic-passcode");
  vi.stubEnv("SUPABASE_URL","https://synthetic.invalid"); vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY","synthetic-key");
  vi.stubGlobal("fetch",async (url: string,init: RequestInit)=>{
    if(url.endsWith("bubble_console_add") || url.endsWith("bubble_console_edit")) { writes.push(JSON.parse(String(init.body))); return Response.json({outcome:"saved",item}); }
    return Response.json({total:1,swept:0,items:[item],next:null});
  });
});
afterEach(()=>{vi.unstubAllEnvs();vi.unstubAllGlobals();__setBubbleStore(undefined);});
const input={action:"add",requestKey:"bbbbbbbb-1111-4111-8111-bbbbbbbbbbbb",kind:"handoff",project:" Projects/Harbor.md ",body:"Next: review"};
function req(body: unknown=input, options: {stamp?:boolean;origin?:string;raw?:string}={}) {
  return new Request("https://console.invalid/s/synthetic-secret/console/working-state",{method:"POST",headers:{"content-type":"application/json",origin:options.origin??"https://console.invalid",...(options.stamp===false?{}:{cookie:`${STAMP_COOKIE}=${stampValue()}`})},body:options.raw??JSON.stringify(body)});
}
const ctx={params:Promise.resolve({secret:"synthetic-secret"})};
it("authorized add returns a validated minimal versioned DTO",async()=>{
  const res=await POST(req(),ctx);
  expect(res.status).toBe(200); expect(res.headers.get("cache-control")).toBe("no-store");
  expect(await res.json()).toEqual({outcome:"saved",item:{id:7,version:1,kind:"handoff",project:"harbor",body:"Next: review",status:"open",touchedAt:"2026-09-08T12:00:00Z",bodyRedacted:false,projectRedacted:false}});
  expect(writes).toEqual([{request_key:input.requestKey,item_kind:"handoff",item_body:"Next: review",project_name:"harbor"}]);
});
it.each([
  [()=>req(input,{stamp:false}),ctx,404],
  [()=>req(),{params:Promise.resolve({secret:"wrong"})},404],
  [()=>req(input,{origin:"https://other.invalid"}),ctx,403],
  [()=>req({...input,action:"file"}),ctx,400],
  [()=>req({...input,body:"x".repeat(2001)}),ctx,400],
  [()=>req(input,{raw:JSON.stringify({...input,body:"x".repeat(30000)})}),ctx,413],
])("refuses invalid or unauthorized writes",async(make,context,status)=>{
  expect((await POST(make(),context)).status).toBe(status); expect(writes).toEqual([]);
});
it("read proves the stamp independently",async()=>{
  const res=await GET(new Request("https://console.invalid/s/synthetic-secret/console/working-state"),ctx);
  expect(res.status).toBe(404);
});
it("never forwards provider details and names a missing migration",async()=>{
  vi.stubGlobal("fetch",async()=>Response.json({code:"PGRST202",message:"password=synthetic-hidden"},{status:404}));
  const res=await POST(req(),ctx); const body=await res.json();
  expect(res.status).toBe(503); expect(body.code).toBe("migration_required"); expect(JSON.stringify(body)).not.toContain("synthetic-hidden");
});
it("a malformed success is uncertain, and errors do not assert rollback",async()=>{
  vi.stubGlobal("fetch",async()=>Response.json({outcome:"saved",item:{...item,version:undefined}}));
  const res=await POST(req(),ctx); expect(res.status).toBe(503); expect((await res.json()).code).toBe("uncertain");
});
it.each(["password=synthetic-hidden","Authorization: Bearer syntheticOpaqueCredential123","github_pat_syntheticOpaqueCredential123"])("redacts browser egress and marks masks: %s",async(secret)=>{
  vi.stubGlobal("fetch",async()=>Response.json({outcome:"saved",item:{...item,body:secret,console_payload_digest:"private-metadata"}}));
  const res=await POST(req(),ctx); const body=await res.json();
  expect(body.item.bodyRedacted).toBe(true); expect(body.item.body).toMatch(/<redacted(?:-token)?>/);
  expect(JSON.stringify(body)).not.toContain(secret); expect(JSON.stringify(body)).not.toContain("private-metadata");
});
it("does not fall back to unversioned writes when optional management support is unavailable",async()=>{
  __setBubbleStore({open:async()=>({items:[],total:0,swept:0}),add:async()=>{throw new Error("unsafe fallback");},update:async()=>null,file:async()=>null,drop:async()=>null});
  const res=await POST(req(),ctx);expect((await res.json()).code).toBe("migration_required");expect(writes).toEqual([]);
});
