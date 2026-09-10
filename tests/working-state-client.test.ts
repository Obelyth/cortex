import { afterEach, expect, it, vi } from "vitest";
import { requestWorkingChange, editorCommand, workingStateUrl, readWorkingPage } from "../lib/working-state-client";
import type { WorkingItem } from "../lib/working-state-contract";
const item:WorkingItem={id:7,version:2,kind:"handoff",project:"harbor",body:"password=<redacted>",bodyRedacted:true,projectRedacted:false,status:"open",touchedAt:"2026-09-08T12:00:00Z"};
afterEach(()=>vi.unstubAllGlobals());
it("does not round trip a masked body when editing kind or project",()=>{
  const command=editorCommand({kind:"decision",project:"harbor",body:item.body},item,false,false);
  expect(command).toEqual({action:"edit",id:7,version:2,kind:"decision",project:"harbor"});
});
it("only includes replacement body after an explicit replacement choice",()=>{
  expect(editorCommand({kind:"handoff",project:"harbor",body:"Fresh short notes"},item,true,false)).toMatchObject({body:"Fresh short notes"});
});
it("does not promote an old masked draft to writable text when refresh returns an unredacted item",()=>{
  const refreshed={...item,version:3,body:"Model replaced the secret with ordinary notes",bodyRedacted:false};
  const command=editorCommand({kind:"decision",project:"token=<redacted>",body:"password=<redacted>"},refreshed,false,false,{body:true,project:true});
  expect(command).not.toHaveProperty("body");
  expect(command).not.toHaveProperty("project");
  expect(command).toMatchObject({id:7,version:3,kind:"decision"});
});
it("lost-response retry sends exactly the same add identity and content",async()=>{
  const sent:string[]=[];vi.stubGlobal("fetch",async(_url:string,init:RequestInit)=>{sent.push(String(init.body));if(sent.length===1)throw new Error("lost");return Response.json({outcome:"saved",item:{...item,status:"aged"}});});
  const command={action:"add" as const,requestKey:"bbbbbbbb-1111-4111-8111-bbbbbbbbbbbb",kind:"handoff" as const,project:"harbor",body:"Next: review"};
  await expect(requestWorkingChange("/working-state",command)).rejects.toMatchObject({code:"uncertain"});
  expect((await requestWorkingChange("/working-state",command)).item.status).toBe("aged");expect(sent[0]).toBe(sent[1]);
});
it("rejects malformed success and an edited result for the wrong ID",async()=>{
  const command={action:"drop" as const,id:7,version:1};
  vi.stubGlobal("fetch",async()=>Response.json({outcome:"saved",item:{...item,id:8}}));
  await expect(requestWorkingChange("/working-state",command)).rejects.toMatchObject({code:"uncertain"});
  vi.stubGlobal("fetch",async()=>Response.json({ok:true}));
  await expect(requestWorkingChange("/working-state",command)).rejects.toMatchObject({code:"uncertain"});
});
it("keeps conflict results safe and validates management pages",async()=>{
  vi.stubGlobal("fetch",async()=>Response.json({code:"conflict",error:"password=should-not-display",current:item},{status:409}));
  await expect(requestWorkingChange("/working-state",{action:"drop",id:7,version:1})).rejects.toMatchObject({code:"conflict",current:item});
  vi.stubGlobal("fetch",async()=>Response.json({items:[],total:"unknown",swept:0,next:null}));
  await expect(readWorkingPage("/working-state",null,null)).rejects.toMatchObject({code:"unavailable"});
  expect(workingStateUrl("/s/synthetic/console/ask")).toBe("/s/synthetic/console/working-state");
});
