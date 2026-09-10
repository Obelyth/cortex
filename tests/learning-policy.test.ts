import { describe, expect, it } from "vitest";
import { cooccurrence, sessionize, candidateScores, baselineScores, pairKey } from "../lib/prediction";

describe("production coaccess policy in replay", () => {
  it("excludes absent endpoints only after classifying the original distinct-path fanout",()=>{
    const available=new Set(["a","b"]);
    const windows=[0,1].map(start=>({start,paths:["a","deleted"]}));
    expect([...cooccurrence(windows,available)]).toEqual([]);
    const oversized=[0,1].map(start=>({start,paths:["a","b","deleted1","deleted2","deleted3","deleted4","deleted5"]}));
    expect([...cooccurrence(oversized,available)]).toEqual([]);
    expect([...cooccurrence([0,1].map(start=>({start,paths:["a","b"]})),available)]).toEqual([[pairKey("a","b"),2]]);
  });
  it("excludes all pushed and maintenance modes before counting distinct UTC-hour paths", () => {
    const rows = ["boot", "handoff", "maintenance"].flatMap(mode => [0,1].map(h => ({at:`2026-09-01T0${h}:00:00Z`,path:mode,mode})));
    rows.push({at:"2026-09-01T01:59:59+01:00",path:"a",mode:"read"}, {at:"2026-09-01T00:59:59Z",path:"a",mode:"read"});
    expect(sessionize(rows)).toEqual([{start:Date.parse("2026-09-01T00:00:00Z"),paths:["a"]}]);
  });
  it("two seven-note windows contribute zero pairs", () => {
    const windows = [0,1].map(start=>({start,paths:Array.from({length:7},(_,i)=>`note${i}`)}));
    expect([...cooccurrence(windows)]).toEqual([]);
  });
  it("requires two distinct windows and ignores duplicate paths and duplicate window inputs", () => {
    expect([...cooccurrence([{start:0,paths:["a","a","b"]},{start:0,paths:["a","b"]}])]).toEqual([]);
    expect([...cooccurrence([{start:0,paths:["a","a","b"]},{start:1,paths:["b","a"]}])]).toEqual([[pairKey("a","b"),2]]);
  });
  it("does not let a one-window pair affect candidate scores", () => {
    const prior=[{at:"2026-09-01T00:01:00Z",path:"a"},{at:"2026-09-01T00:02:00Z",path:"b"}];
    const now=Date.parse("2026-09-01T01:00:00Z");
    expect(candidateScores(prior,sessionize(prior),{links:new Set(),tags:new Map()},now)).toEqual(baselineScores(prior,now));
  });
});
