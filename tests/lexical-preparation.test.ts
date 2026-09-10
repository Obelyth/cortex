import {afterEach,describe,expect,it,vi} from "vitest";
import {rank,rankTerms,narrowDetail,tokenize} from "../lib/narrow";
import {ask} from "../lib/ask";
import type {Corpus} from "../lib/corpus";
import {scopedLexicalFiles} from "../lib/lexical";

afterEach(()=>vi.restoreAllMocks());

// Independent frozen pre-change ASCII scorer; never calls the production tokenizer/index.
function reference(files:Map<string,string>,query:string){
  const words=(s:string)=>s.toLowerCase().replace(/\bc\+\+/g," cplusplus ").replace(/\bc#/g," csharp ").replace(/\bf#/g," fsharp ").replace(/\bobjective-c\b/g," objectivec ").replace(/\.net\b/g," dotnet ").replace(/[^a-z0-9]+/g," ").split(" ").filter(Boolean);
  const documents=[...files].map(([path,body])=>({path,words:words(body)}));
  const n=documents.length||1,avg=documents.reduce((s,d)=>s+d.words.length,0)/n||1;
  return documents.map(d=>{
    let score=0;const terms:string[]=[];
    for(const term of new Set(words(query))){
      const tf=d.words.filter(w=>w===term).length;if(!tf)continue;
      const df=documents.filter(x=>x.words.includes(term)).length;
      score+=Math.log(1+(n-df+0.5)/(df+0.5))*(tf*2.5)/(tf+1.5*d.words.length/avg);terms.push(term);
    }
    return {path:d.path,score,terms};
  }).filter(d=>d.score>0).sort((a,b)=>b.score-a.score||a.path.localeCompare(b.path));
}

describe("prepared lexical ranking",()=>{
  it("preserves independent ASCII/symbolic scores, terms and deterministic tie ordering",()=>{
    const files=new Map([["b.md","C++ C# F# Objective-C .NET R H router router"],["a.md","C++ C# F# Objective-C .NET R H router router"],["c.md","router memory x 42"],["empty.md",""]]);
    for(const q of ["C++ C# F# Objective-C .NET R H","router x 42 router","???","memory"]){
      const expected=reference(files,q);
      expect(rankTerms(files,q)).toEqual(expected);
      expect(rank(files,q)).toEqual(expected.map(({path,score})=>({path,score})));
    }
  });
  it("reuses actual document tokenization across real narrowDetail questions",()=>{
    const body="cacheprobe alpha alpha checkpoint",files=new Map([["a.md",body],["b.md","other beta"]]);
    const lower=vi.spyOn(String.prototype,"toLowerCase");
    narrowDetail(files,"alpha");narrowDetail(files,"checkpoint");
    expect(lower.mock.contexts.filter(value=>String(value)===body)).toHaveLength(1);
  });
  it("invalidates same-size replacement, deletion/addition and new Map generations",()=>{
    const body="mutationprobe alpha",files=new Map([["a.md",body],["b.md","beta"]]);
    const lower=vi.spyOn(String.prototype,"toLowerCase");
    expect(rank(files,"alpha").map(x=>x.path)).toEqual(["a.md"]);
    files.set("a.md","gamma");expect(rank(files,"alpha")).toEqual([]);expect(rank(files,"gamma").map(x=>x.path)).toEqual(["a.md"]);
    files.delete("a.md");files.set("c.md",body);expect(rank(files,"alpha").map(x=>x.path)).toEqual(["c.md"]);
    const next=new Map(files);rank(next,"alpha");
    expect(lower.mock.contexts.filter(value=>String(value)===body)).toHaveLength(3);
  });
  it("never returns mutable cached scoring results",()=>{
    const files=new Map([["a.md","alpha"]]);const first=rankTerms(files,"alpha");
    first[0].score=-99;first[0].terms.push("private");first.push({path:"injected",score:999,terms:[]});
    expect(rankTerms(files,"alpha")).toEqual(reference(files,"alpha"));
  });
  it("preserves current Map order for comparator-equal paths after delete/reinsert",()=>{
    const first="é.md",second="e\u0301.md",body="orderprobe alpha";
    expect(first).not.toBe(second);expect(first.localeCompare(second)).toBe(0);
    const files=new Map([[first,body],[second,body]]);
    const lower=vi.spyOn(String.prototype,"toLowerCase");
    expect(narrowDetail(files,"alpha",1).paths).toEqual([first]);
    files.delete(first);files.set(first,body);
    expect(rankTerms(files,"alpha").map(x=>x.path)).toEqual([second,first]);
    expect(narrowDetail(files,"alpha",1).paths).toEqual([second]);
    // Reordering may rebuild view statistics, but unchanged documents stay tokenized once.
    expect(lower.mock.contexts.filter(value=>String(value)===body)).toHaveLength(2);
    expect(rankTerms(files,"alpha")).toEqual(rankTerms(new Map(files),"alpha"));
  });
  it("preserves current visible order for comparator-equal paths through scoped ask reuse",async()=>{
    const first="guest/é.md",second="guest/e\u0301.md";
    expect(first).not.toBe(second);expect(first.localeCompare(second)).toBe(0);
    const files=new Map([[first,"alpha"],["private/hidden.md","alpha"],[second,"alpha"]]);
    const corpus:Corpus={sha:"d".repeat(40),files,bytes:15,fetchedAt:0};
    const reader=async()=>JSON.stringify({answer:"NOT IN BRAIN",tag:"",quote:""});
    expect((await ask("alpha",reader,{corpus,scope:["guest/"],k:1})).candidates).toEqual([first]);
    files.delete(first);files.set(first,"alpha");
    expect((await ask("alpha",reader,{corpus,scope:["guest/"],k:1})).candidates).toEqual([second]);
    expect([...scopedLexicalFiles(files,["guest/"],corpus.sha).keys()]).toEqual([second,first]);
  });
  it("evicts old views and rebuilds correct results after eviction",()=>{
    const body="evictionprobe alpha",first=new Map([["a.md",body]]);
    const lower=vi.spyOn(String.prototype,"toLowerCase");rank(first,"alpha");
    const retained=[];
    for(let i=0;i<4;i++){const view=new Map([[`n${i}.md`,`other ${i}`]]);retained.push(view);rank(view,"other");}
    expect(rankTerms(first,"alpha")).toEqual(reference(first,"alpha"));
    // One initial preparation, one after eviction, and the independent reference above.
    expect(lower.mock.contexts.filter(value=>String(value)===body)).toHaveLength(3);
  });
  it("does not retain over-capacity preparation or evict unrelated warm views to admit it",()=>{
    const warm=new Map([["warm.md","retentionprobe alpha"]]);rank(warm,"alpha");
    const oversized=new Map(Array.from({length:20001},(_,i)=>[`n${i}.md`,i===0?"oversizeprobe alpha":"beta"]));
    const lower=vi.spyOn(String.prototype,"toLowerCase");
    expect(rank(oversized,"alpha").map(x=>x.path)).toEqual(["n0.md"]);
    expect(rank(oversized,"alpha").map(x=>x.path)).toEqual(["n0.md"]);
    expect(lower.mock.contexts.filter(value=>String(value)==="oversizeprobe alpha")).toHaveLength(2);
    rank(warm,"alpha");expect(lower.mock.contexts.filter(value=>String(value)==="retentionprobe alpha")).toHaveLength(0);
  });
  it("counts auxiliary scoped view records against the same retention budget",()=>{
    const source=new Map(Array.from({length:10001},(_,i)=>[`guest/n${i}.md`,i===0?"scopeboundprobe alpha":"beta"]));
    source.set("hidden/secret.md","not visible");
    const lower=vi.spyOn(String.prototype,"toLowerCase");
    for(let i=0;i<2;i++){
      const visible=scopedLexicalFiles(source,["guest/"],"one");
      expect(rank(visible,"alpha").map(x=>x.path)).toEqual(["guest/n0.md"]);
    }
    expect(lower.mock.contexts.filter(value=>String(value)==="scopeboundprobe alpha")).toHaveLength(2);
    expect(lower.mock.contexts.filter(value=>String(value)==="not visible")).toHaveLength(0);
  });
});

describe("Unicode lexical signal",()=>{
  it.each([
    ["项目交接","打开项目交接文档，查看部署状态。"],
    ["حالة النشر","توثيق حالة النشر للمشروع"],
    ["состояние проекта","текущее состояние проекта готово"],
    ["café","le cafe\u0301 est ouvert"],
    ["部署 router","项目部署 router configuration"],
  ])("finds lexical signal for %s instead of largest-note fallback",(query,body)=>{
    const files=new Map([["hit.md",body],["large.md","unrelated gardening ".repeat(50)]]);
    const result=narrowDetail(files,query,1);
    expect(tokenize(query).length).toBeGreaterThan(0);expect(result.mode).toBe("scored");expect(result.paths).toEqual(["hit.md"]);
  });
  it("normalizes canonically equivalent accents while preserving ASCII symbolic tokens",()=>{
    expect(tokenize("cafe\u0301")).toEqual(tokenize("café"));
    expect(tokenize("C++ C# F# Objective-C .NET R H")).toEqual(["cplusplus","csharp","fsharp","objectivec","dotnet","r","h"]);
  });
  it("requires native segmentation only for unspaced scripts",()=>{
    const segmenter=Intl.Segmenter;
    try{
      Object.defineProperty(Intl,"Segmenter",{value:undefined,configurable:true,writable:true});
      expect(tokenize("حالة состояние café C++")).toEqual(["حالة","состояние","café","cplusplus"]);
      expect(()=>tokenize("项目交接")).toThrow(/segmentation unavailable/);
    }finally{Object.defineProperty(Intl,"Segmenter",{value:segmenter,configurable:true,writable:true});}
  });
  it("bounds each native subrun without refusing adjacent long ordinary spans",()=>{
    expect(()=>tokenize("界".repeat(65537))).toThrow("Unicode segmentation run exceeds 65536 UTF-16 units");
    expect(tokenize("界".repeat(65536)).length).toBeGreaterThan(0);
    for(const ordinary of ["a".repeat(65537),"ب".repeat(65537)]){
      const tokens=tokenize(ordinary+"项目");expect(tokens).toContain(ordinary);expect(tokens).toContain("项目");
    }
  });
  it("does not publish partial statistics or poison other views after an oversized visible subrun",async()=>{
    const files=new Map([["public/a.md","alpha"],["private/b.md","beta"]]);rank(files,"alpha");
    files.set("private/b.md","界".repeat(65537));
    for(let i=0;i<2;i++)expect(()=>rank(files,"alpha")).toThrow("Unicode segmentation run exceeds 65536 UTF-16 units");
    expect(files.get("public/a.md")).toBe("alpha");
    const corpus:Corpus={sha:"c".repeat(40),files,bytes:200000,fetchedAt:0};
    const answer=await ask("alpha",async()=>JSON.stringify({answer:"NOT IN BRAIN",tag:"",quote:""}),{corpus,scope:["public/"]});
    expect(answer.candidates).toEqual(["public/a.md"]);
    files.set("private/b.md","beta");expect(rank(files,"beta").map(x=>x.path)).toEqual(["private/b.md"]);
  });
});

it("reuses a real scoped ask view and keeps guest statistics independent of hidden documents",async()=>{
  const visible="guestprobe alpha checkpoint",files=new Map([["guest/a.md",visible],["guest/b.md","beta"],["private/x.md","alpha ".repeat(50)]]);
  const corpus:Corpus={sha:"a".repeat(40),files,bytes:100,fetchedAt:0};
  const reader=async()=>JSON.stringify({answer:"NOT IN BRAIN",tag:"",quote:""});
  const lower=vi.spyOn(String.prototype,"toLowerCase");
  const first=await ask("alpha",reader,{corpus,scope:["guest/"]});
  const second=await ask("checkpoint",reader,{corpus,scope:["guest/"]});
  expect(second.candidates).toEqual(["guest/a.md"]);
  expect(lower.mock.contexts.filter(value=>String(value)===visible)).toHaveLength(1);
  files.set("private/x.md","beta private-only");
  const after=await ask("alpha",reader,{corpus,scope:["guest/"]});
  expect(after.shortlist).toEqual(first.shortlist);expect(after.zeroCount).toBe(1);
  expect(lower.mock.contexts.filter(value=>String(value)===visible)).toHaveLength(1);
  const other=await ask("alpha",reader,{corpus,scope:["private/"]});
  expect(other.narrowing.mode).toBe("fallback");expect(other.candidates).toEqual(["private/x.md"]);
  expect(after.shortlist.map(({path,score,terms})=>({path,score,terms}))).toEqual(reference(new Map([["guest/a.md",visible],["guest/b.md","beta"]]),"alpha"));
  const changed="guestprobe gamma";files.set("guest/a.md",changed);
  expect((await ask("gamma",reader,{corpus,scope:["guest/"]})).candidates).toEqual(["guest/a.md"]);
  const generation={...corpus,sha:"b".repeat(40)};
  expect((await ask("gamma",reader,{corpus:generation,scope:["guest/"]})).candidates).toEqual(["guest/a.md"]);
  expect(lower.mock.contexts.filter(value=>String(value)===changed)).toHaveLength(2);
  files.delete("guest/b.md");files.set("guest/c.md","delta");
  expect((await ask("delta",reader,{corpus:generation,scope:["guest/"]})).candidates).toEqual(["guest/c.md"]);
});
