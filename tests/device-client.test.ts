import { expect, it, vi } from "vitest";
import { createDeviceVisitor, requestDevice } from "../lib/device-client";

it("does not poll hidden visits, throttles visible events, and never registers automatically",async()=>{
  let visible=false,now=1_000_000;
  const sent:unknown[]=[];
  const visit=createDeviceVisitor(()=>visible,async command=>{sent.push(command);},()=>now);
  await visit();expect(sent).toEqual([]);
  visible=true;await visit();await visit();expect(sent).toEqual([{action:"visit",visible:true}]);
  now+=299_999;await visit();expect(sent).toHaveLength(1);
  now++;await visit();expect(sent).toHaveLength(2);
  visible=false;now+=300_000;await visit(true);expect(sent).toHaveLength(2);
});
it("suppresses parallel visits and bounds retry traffic even after transport failure",async()=>{
  let now=1_000_000,finish:()=>void=()=>{};const send=vi.fn(()=>new Promise<void>(resolve=>{finish=resolve;}));
  const visit=createDeviceVisitor(()=>true,send,()=>now);
  const first=visit();await visit(true);expect(send).toHaveBeenCalledTimes(1);finish();await first;
  now+=300_000;send.mockRejectedValueOnce(new Error("unavailable"));await visit();await visit();expect(send).toHaveBeenCalledTimes(2);
});
it("keeps the exact enrollment intent/input on response-loss retry and refuses malformed success",async()=>{
  const command={action:"register" as const,intent:"signed-synthetic-intent",label:"Phone",category:"phone" as const};
  const sent:string[]=[];
  vi.stubGlobal("fetch",async(_url:string,init:RequestInit)=>{sent.push(String(init.body));throw new Error("lost");});
  await expect(requestDevice("/devices",command)).rejects.toMatchObject({code:"uncertain"});
  await expect(requestDevice("/devices",command)).rejects.toMatchObject({code:"uncertain"});
  expect(sent[1]).toBe(sent[0]);
  vi.stubGlobal("fetch",async()=>Response.json({outcome:"registered",item:{id:"wrong"}}));
  await expect(requestDevice("/devices",command)).rejects.toMatchObject({code:"uncertain"});
});
