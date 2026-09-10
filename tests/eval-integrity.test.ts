import { expect, it, vi } from "vitest";
import * as evaluation from "../scripts/eval";
import * as predictionEval from "../scripts/eval-prediction";
import type { Corpus } from "../lib/corpus";
import { baselineScores } from "../lib/prediction";

it("the replay scorer pins endpoint availability without leaking the scored window",()=>{
  const prior=[0,1].flatMap(h=>["a.md","deleted.md"].map(path=>({at:`2026-09-01T0${h}:00:00Z`,path})));
  const now=Date.parse("2026-09-01T02:00:00Z");
  const rows=[...prior,{at:new Date(now).toISOString(),path:"future.md"}];
  const structure={links:new Set<string>(),tags:new Map<string,number>()};
  const scores=predictionEval.predictionScoresForWindow(rows,new Set(["a.md"]),structure,now)!;
  expect(scores.baseline).toEqual(baselineScores(prior,now));
  expect(scores.candidate).toEqual(scores.baseline);
  expect(scores.candidate.has("future.md")).toBe(false);
  const live=predictionEval.predictionScoresForWindow(rows,new Set(["a.md","deleted.md"]),structure,now)!;
  expect(live.candidate.get("a.md")).toBeGreaterThan(scores.candidate.get("a.md")!);
});

it("pins one full corpus object across rows, excludes stale label IDs, and counts explicit protocol errors", async () => {
  const pinned:Corpus={sha:"a".repeat(40),files:new Map([["notes/current.md","The current fact is blue."]]),bytes:25,fetchedAt:0};
  let live=pinned;
  const load=vi.fn(async()=>live);
  const seen:Corpus[]=[];
  const labels=[
    {id:"missing",q:"Same display question",expected:"notes/missing.md",expect_contains:"blue",difficulty:"easy" as const,why:""},
    {id:"changed",q:"Same display question",expected:"notes/current.md",expect_contains:"red",difficulty:"easy" as const,why:""},
    {id:"fresh",q:"Same display question",expected:"notes/current.md",expect_contains:"blue",difficulty:"easy" as const,why:""},
    {id:"absent",q:"Absent?",expected:"NONE",difficulty:"easy" as const,why:""},
  ];
  const judge=vi.fn(async()=>({correct:true,why:"synthetic verdict"}));
  const result=await evaluation.evaluateRows({all:labels,labels,runs:1,concurrency:2,model:"synthetic",reader:async()=>"invalid protocol",load,
    ask:async(q,reader,options)=>{seen.push(options!.corpus!);live={...pinned,sha:"b".repeat(40)};const {ask}=await import("../lib/ask");return ask(q,reader,options);},panel:[{model:"synthetic",provider:"anthropic"}],judge});
  expect(load).toHaveBeenCalledTimes(1);
  expect(seen).toHaveLength(4);expect(seen.every(c=>c===pinned)).toBe(true);
  expect(result.rows.map(r=>r.corpusCommit)).toEqual(Array(4).fill(pinned.sha));
  expect(result.stale.map(s=>s.id)).toEqual(["missing","changed"]);
  expect(result.rows.slice(0,2).map(r=>[r.routing,r.sameBlock,r.answerOk])).toEqual([[null,null,null],[null,null,null]]);
  expect(judge).toHaveBeenCalledTimes(1);
  expect(result.rows[3].protocolFailure).toBe(true);expect(result.rows[3].absence).toBe(false);
});

it("reads history through a smaller server cap and stops at a pinned upper row identity", async()=>{
  const rows=Array.from({length:5},(_,i)=>({id:String(i+1),at:`2026-09-01T0${i}:00:00Z`,path:`n${i}`,mode:"read"}));
  const fetched:string[]=[];
  const read:typeof fetch=async(url,init)=>{
    const u=new URL(String(url));fetched.push(u.search);
    if(u.searchParams.get("order")==="id.desc") return Response.json([{id:"5"}]);
    expect(u.searchParams.get("id")).toBe("lte.5");
    const from=Number(new Headers(init?.headers).get("Range")!.split("-")[0]);
    return Response.json(rows.slice(from,from+2));
  };
  expect(await predictionEval.readPredictionHistory("https://synthetic.invalid","synthetic",null,read)).toEqual(rows);
  expect(fetched).toHaveLength(5);
  expect(fetched[1]).toContain("maintenance");
});

it("accepts a gateway's exhausted range only when it proves the exact end of history",async()=>{
  const read:typeof fetch=async(url,init)=>{
    if(String(url).includes("order=id.desc"))return Response.json([{id:"1"}]);
    const from=new Headers(init?.headers).get("Range")!.split("-")[0];
    return from==="0"?Response.json([{id:"1",at:"2026-09-01T00:00:00Z",path:"a",mode:"read"}]):Response.json({code:"PGRST103"},{status:416,headers:{"Content-Range":"*/1"}});
  };
  expect(await predictionEval.readPredictionHistory("https://synthetic.invalid","synthetic",null,read)).toHaveLength(1);
});
