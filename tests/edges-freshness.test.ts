import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
const lifecycle=vi.hoisted(()=>({after:vi.fn()}));
it("the migration and the deployment name one structural identity, literally",async()=>{
  // STRUCTURAL_EDGE_VERSION is what rebuilds send and freshness checks compare; the SQL has the
  // same string inlined four times. Parity used to be asserted only in the Postgres-gated suite,
  // so a drift landed anywhere without a database would read as every graph being stale-input.
  const {STRUCTURAL_EDGE_VERSION}=await import("../lib/edges");
  const sql=readFileSync(new URL("../supabase/migrations/20260909032252_structural_edge_identity.sql",import.meta.url),"utf8");
  const literals=[...sql.matchAll(/'(structural-v[^']*)'/g)].map(m=>m[1]);
  expect(literals.length).toBeGreaterThanOrEqual(4);
  expect(new Set(literals)).toEqual(new Set([STRUCTURAL_EDGE_VERSION]));
});
vi.mock("next/server",()=>({after:lifecycle.after}));
beforeEach(()=>{vi.resetModules();vi.stubEnv("SUPABASE_URL","https://synthetic.invalid");vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY","synthetic");lifecycle.after.mockReset();});
afterEach(()=>{vi.restoreAllMocks();vi.unstubAllGlobals();vi.unstubAllEnvs();vi.useRealTimers();});
const identity={state:"stale",structural:false,watermark:"clock",cutoff:"2026-09-08T12:00:00Z",policy:"coaccess-v2-90d-closed-utc-6-2",structure:"structural-v2-unicode-bm25-1.5-1",builtStructure:"structural-v2-unicode-bm25-1.5-1"};
it("usage-only refresh never iterates corpus contents and preserves structural rows via null payload",async()=>{
  const {rebuildEdges}=await import("../lib/edges");const bodies:any[]=[];
  vi.stubGlobal("fetch",async(url:string,init:RequestInit)=>{if(url.endsWith("edges_freshness"))return Response.json(identity);bodies.push(JSON.parse(String(init.body)));return Response.json("rebuilt");});
  const files=new Map<string,string>();files[Symbol.iterator]=()=>{throw new Error("usage refresh derived structure");};
  expect((await rebuildEdges(files,"head")).state).toBe("rebuilt");expect(bodies[0].edges).toBeNull();
});
it("defers checks until after the response, deduplicates, and bounds same-head checks to one per minute",async()=>{
  vi.useFakeTimers();const {scheduleEdgeRebuild}=await import("../lib/edges");const fetcher=vi.fn(async()=>Response.json({...identity,state:"current"}));vi.stubGlobal("fetch",fetcher);
  scheduleEdgeRebuild(new Map(),"head");scheduleEdgeRebuild(new Map(),"head");
  expect(fetcher).not.toHaveBeenCalled();expect(lifecycle.after).toHaveBeenCalledTimes(1);
  await lifecycle.after.mock.calls[0][0]();expect(fetcher).toHaveBeenCalledTimes(1);
  scheduleEdgeRebuild(new Map(),"head");expect(lifecycle.after).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(60000);scheduleEdgeRebuild(new Map(),"head");expect(lifecycle.after).toHaveBeenCalledTimes(2);
});
it("changed-head derivation refuses oversized inputs without publishing",async()=>{
  const {rebuildEdges}=await import("../lib/edges");let writes=0;
  vi.stubGlobal("fetch",async(url:string)=>{if(url.endsWith("edges_freshness"))return Response.json({...identity,structural:true});writes++;return Response.json("rebuilt");});
  expect((await rebuildEdges(new Map(Array.from({length:2001},(_,i)=>[`${i}.md`,"x"])),"new-head")).state).toBe("capacity");expect(writes).toBe(0);
});
it("throttles changing heads across the minute and consumes the newest pending corpus",async()=>{
  vi.useFakeTimers();vi.setSystemTime(0);
  const {scheduleEdgeRebuild}=await import("../lib/edges");
  const heads:string[]=[];
  vi.stubGlobal("fetch",async(_url:string,init:RequestInit)=>{heads.push(JSON.parse(String(init.body)).new_head);return Response.json({...identity,state:"current"});});
  scheduleEdgeRebuild(new Map(),"first");await lifecycle.after.mock.calls[0][0]();
  for(const head of ["second","third","fourth"]) {
    await vi.advanceTimersByTimeAsync(10000);scheduleEdgeRebuild(new Map(),head);
    expect(lifecycle.after).toHaveBeenCalledTimes(1);
  }
  await vi.advanceTimersByTimeAsync(30000);
  scheduleEdgeRebuild(new Map(),"fourth");
  scheduleEdgeRebuild(new Map(),"latest");
  expect(lifecycle.after).toHaveBeenCalledTimes(2);
  await lifecycle.after.mock.calls[1][0]();
  expect(heads).toEqual(["first","latest"]);
  expect(vi.getTimerCount()).toBe(0);
});
it("shares concurrent same-head work but does not falsely satisfy a different head or forced rebuild",async()=>{
  const {rebuildEdges}=await import("../lib/edges");let complete!:(r:Response)=>void;
  const fetcher=vi.fn(()=>new Promise<Response>(resolve=>{complete=resolve;}));vi.stubGlobal("fetch",fetcher);
  const pending=rebuildEdges(new Map(),"head");
  expect(rebuildEdges(new Map(),"head")).toBe(pending);
  expect(await rebuildEdges(new Map(),"different")).toEqual({state:"busy",head:"different"});
  expect(await rebuildEdges(new Map(),"head",{force:true})).toEqual({state:"busy",head:"head"});
  complete(Response.json({...identity,state:"current"}));expect((await pending).state).toBe("current");
  expect(fetcher).toHaveBeenCalledTimes(1);
});
it("the yielding bounded deriver preserves all structural and lexical relationships",async()=>{
  const {deriveEdges,deriveEdgesBounded}=await import("../lib/edges");
  const files=new Map([["notes/a.md","---\ntags: [shared]\n---\nSee [[b]]. Shared topic. Fixed (was: \"notes/b.md was wrong\")."],["notes/b.md","---\ntags: [shared]\n---\nShared topic."]]);
  let yielded=false;setImmediate(()=>{yielded=true;});
  expect(await deriveEdgesBounded(files)).toEqual(deriveEdges(files));expect(yielded).toBe(true);
});
it("refuses a checked execution budget and stops dense tag output before allocating every pair",async()=>{
  const {deriveEdgesBounded}=await import("../lib/edges");
  const now=vi.spyOn(performance,"now").mockReturnValueOnce(0).mockReturnValue(5001);
  expect(await deriveEdgesBounded(new Map([["a.md","text"]]))).toBe("budget");now.mockRestore();
  expect(await deriveEdgesBounded(new Map(Array.from({length:2000},(_,i)=>[`${i}.md`,"---\ntags: [shared]\n---\ntext"])))).toBe("capacity");
});
it("same-SHA cached corpus returns still register the bounded background freshness check",async()=>{
  const {loadCorpus,__setCache}=await import("../lib/corpus");
  const corpus={files:new Map([["a.md","text"]]),sha:"pinned",bytes:4,fetchedAt:0};
  __setCache(corpus);vi.stubEnv("GITHUB_TOKEN","synthetic");vi.stubEnv("BRAIN_REPO","synthetic/brain");
  const get=vi.fn(async(_url:RequestInfo|URL)=>Response.json({sha:"pinned"}));vi.stubGlobal("fetch",get);
  expect(await loadCorpus()).toBe(corpus);expect(lifecycle.after).toHaveBeenCalledTimes(1);
  expect(get).toHaveBeenCalledTimes(1);expect(String(get.mock.calls[0][0])).toContain("/commits/");
});
it.each(["edgesPulse","edgesSummary"] as const)("%s cannot advertise head-only freshness or a mixed build",async(name)=>{
  const edges=await import("../lib/edges");
  let freshness={...identity,state:"stale",builtAt:"stamp"};
  vi.stubGlobal("fetch",async(url:string)=>{
    if(url.includes("edges_state"))return Response.json([{built_head:"head",built_at:"stamp"}]);
    if(url.endsWith("edges_freshness"))return Response.json(freshness);
    return Response.json([]);
  });
  expect(await edges[name]()).toEqual({state:"unavailable"});
  freshness={...freshness,state:"current",builtAt:"different-build"};
  expect(await edges[name]()).toEqual({state:"unavailable"});
  freshness={...freshness,builtAt:"stamp"};
  expect(await edges[name]()).toMatchObject({state:"built",head:"head"});
});
