import {afterEach,it,expect,vi} from "vitest";
import {edgesPulse,edgesSummary,edgesFor,coaccessEdges} from "../lib/edges";
afterEach(()=>{vi.unstubAllEnvs();vi.unstubAllGlobals();vi.useRealTimers();});
// A PostgREST behind db-max-rows=1000 (Supabase's default) answers an un-Ranged GET with the
// first 1000 rows and a 200. One request cannot tell 1000-of-1000 from 1000-of-1500.
function capped(total:number,cap=1000){
  const rows=Array.from({length:total},(_,n)=>({src:"hub.md",dst:`n${String(n).padStart(4,"0")}.md`,kind:"coaccess",weight:5,evidence:"synthetic"}));
  const calls:Array<{url:string;range:string|null}>=[];
  vi.stubEnv("SUPABASE_URL","https://synthetic.invalid");vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY","synthetic");
  vi.stubGlobal("fetch",async(url:string,init?:RequestInit)=>{
    const range=new Headers(init?.headers).get("range");calls.push({url,range});
    const from=range?Number(range.split("-")[0]):0;
    return Response.json(rows.slice(from,from+cap));
  });
  return calls;
}
it("edgesFor pages past a provider max-rows cap of 1000 and keeps its filter on every page",async()=>{
  const calls=capped(1500);
  const got=await edgesFor("hub.md");
  expect(got?.length).toBe(1500);
  // The third page starts where the short second one ended, and comes back empty: the stop.
  expect(calls.map(c=>c.range)).toEqual(["0-999","1000-1999","1500-2499"]);
  expect(calls.every(c=>c.url.includes("or=")&&c.url.includes(encodeURIComponent('"hub.md"'))&&new URL(c.url).searchParams.get("order")==="src.asc,dst.asc,kind.asc")).toBe(true);
});
it("coaccessEdges pages past a provider max-rows cap of 1000 in its weight order",async()=>{
  const calls=capped(1500);
  const got=await coaccessEdges();
  expect(got?.length).toBe(1500);
  // The third page starts where the short second one ended, and comes back empty: the stop.
  expect(calls.map(c=>c.range)).toEqual(["0-999","1000-1999","1500-2499"]);
  expect(calls.every(c=>c.url.includes("kind=eq.coaccess")&&new URL(c.url).searchParams.get("order")==="weight.desc,src.asc,dst.asc")).toBe(true);
});
it.each(["edgesFor","coaccessEdges"] as const)("%s still answers null, quietly, when the table is not there yet",async(fn)=>{
  vi.stubEnv("SUPABASE_URL","https://synthetic.invalid");vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY","synthetic");
  vi.stubGlobal("fetch",async()=>Response.json({},{status:404}));
  const error=vi.spyOn(console,"error").mockImplementation(()=>{});
  expect(await(fn==="edgesFor"?edgesFor("hub.md"):coaccessEdges())).toBeNull();
  expect(error).not.toHaveBeenCalled();
});
it.each(["detail","summary"] as const)("reads all 650 %s edges behind a provider max-rows of 500",async(mode)=>{
  vi.stubEnv("SUPABASE_URL","https://synthetic.invalid");vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY","synthetic");
  const edges=Array.from({length:650},(_,n)=>({src:`n${String(n).padStart(4,"0")}.md`,dst:"target.md",kind:"link",weight:1,evidence:"synthetic"}));
  const offsets:number[]=[];const orders:string[]=[];
  vi.stubGlobal("fetch",async(url:string,init?:RequestInit)=>{
    if(url.includes("edges_state?"))return Response.json([{built_head:"head",built_at:"stamp"}]);
    if(url.endsWith("edges_freshness"))return Response.json({state:"current",policy:"coaccess-v2-90d-closed-utc-6-2",structure:"structural-v2-unicode-bm25-1.5-1",builtStructure:"structural-v2-unicode-bm25-1.5-1",builtAt:"stamp"});
    const from=Number(new Headers(init?.headers).get("range")?.split("-")[0]);offsets.push(from);orders.push(new URL(url).searchParams.get("order")??"");
    return Response.json(edges.slice(from,from+500));
  });
  const result=mode==="detail"?await edgesPulse():await edgesSummary();
  expect(result.state).toBe("built");
  if("total" in result)expect(result.total).toBe(650);
  else expect("byNote" in result&&Array.isArray(result.byNote["n0649.md"])).toBe(true);
  expect(offsets).toEqual([0,500,650]);expect(orders.every(o=>o==="src.asc,dst.asc,kind.asc")).toBe(true);
});
it.each(["detail","summary"] as const)("refuses a mixed %s generation when an atomic publication happens between pages",async(mode)=>{
  vi.stubEnv("SUPABASE_URL","https://synthetic.invalid");vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY","synthetic");
  vi.stubGlobal("fetch",async(url:string,init?:RequestInit)=>{
    if(url.includes("edges_state?"))return Response.json([{built_head:"head",built_at:"original"}]);
    if(url.endsWith("edges_freshness"))return Response.json({state:"current",policy:"coaccess-v2-90d-closed-utc-6-2",structure:"structural-v2-unicode-bm25-1.5-1",builtStructure:"structural-v2-unicode-bm25-1.5-1",builtAt:"new-publication"});
    return Response.json(new Headers(init?.headers).get("range")==="0-999"?[{src:"a",dst:"b",kind:"link",weight:1,evidence:"synthetic"}]:[]);
  });
  expect(await(mode==="detail"?edgesPulse():edgesSummary())).toEqual({state:"unavailable"});
});
it("bounds a never-ending response across the complete read, including body time",async()=>{
  vi.useFakeTimers();vi.stubEnv("SUPABASE_URL","https://synthetic.invalid");vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY","synthetic");
  const cancel=vi.fn();vi.stubGlobal("fetch",async()=>new Response(new ReadableStream({cancel})));
  const pending=edgesPulse();await vi.advanceTimersByTimeAsync(10001);
  expect(await pending).toEqual({state:"unavailable"});expect(cancel).toHaveBeenCalledOnce();
});
it("refuses streamed aggregate bytes before parsing an oversized response",async()=>{
  vi.stubEnv("SUPABASE_URL","https://synthetic.invalid");vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY","synthetic");
  let pulls=0;const cancel=vi.fn();
  vi.stubGlobal("fetch",async()=>new Response(new ReadableStream({pull(c){pulls++;c.enqueue(new Uint8Array(1024*1024));},cancel})));
  expect(await edgesSummary()).toEqual({state:"unavailable"});expect(pulls).toBeLessThanOrEqual(66);expect(cancel).toHaveBeenCalledOnce();
});
