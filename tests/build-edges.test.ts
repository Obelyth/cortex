import {afterEach,expect,it,vi} from "vitest";
import * as script from "../scripts/build-edges";
import type {RebuildResult} from "../lib/edges";
afterEach(()=>vi.unstubAllEnvs());
it.each(["capacity","budget","busy","stale-input","stale-head"] as const)("manual rebuild reports %s as failure without an unbounded preview",async(state)=>{
  vi.stubEnv("SUPABASE_URL","https://synthetic.invalid");vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY","synthetic");
  const files=new Map<string,string>();files[Symbol.iterator]=()=>{throw new Error("unbounded CLI preview");};
  const corpus={files,sha:"a".repeat(40),bytes:0,fetchedAt:0};
  const errors:string[]=[];
  const rebuild=vi.fn(async(_files:Map<string,string>,_head:string,_options?:{force?:boolean})=>({state,head:corpus.sha} as RebuildResult));
  expect(await script.runBuildEdges({force:true,load:async()=>corpus,rebuild,log:()=>{},error:s=>errors.push(s)})).toBe(1);
  expect(errors.join(" ")).toContain(state);expect(rebuild.mock.calls[0][0]).toBe(files);
  expect(rebuild.mock.calls[0][1]).toBe(corpus.sha);expect(rebuild.mock.calls[0][2]).toEqual({force:true});
});
it.each(["off","missing","current","rebuilt"] as const)("manual rebuild preserves the %s exit contract",async(state)=>{
  vi.stubEnv("SUPABASE_URL","https://synthetic.invalid");vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY","synthetic");
  const corpus={files:new Map<string,string>(),sha:"a".repeat(40),bytes:0,fetchedAt:0};
  const rebuild=async()=>({state,head:corpus.sha,derived:0} as RebuildResult);
  expect(await script.runBuildEdges({force:false,load:async()=>corpus,rebuild,log:()=>{},error:()=>{}})).toBe(["off","missing"].includes(state)?2:0);
});
