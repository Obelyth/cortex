import { afterEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beginVisibleJobPolling, JobDetail, shouldPollJob } from "../app/s/[secret]/console/ops/command-panel";
import type { ConsoleJob } from "../lib/console-job-contract";

const job:ConsoleJob={id:"11111111-1111-4111-8111-111111111111",operation:"diagnostics",state:"running",requestedAt:"2026-09-08T18:00:00.000Z",updatedAt:"2026-09-08T18:00:01.000Z",sourceSha:"abcdef12",target:"deployment",checks:[{name:"source identity",state:"passed",detail:"runtime SHA abcdef12 · corpus SHA 12345678"}],summary:"1 passed",providerId:null};
afterEach(()=>{vi.useRealTimers();vi.unstubAllGlobals();});

describe("Ops command detail and polling",()=>{
  it("renders the finite receipt and every named check in the shared-drawer body",()=>{
    const html=renderToStaticMarkup(createElement(JobDetail,{job}));
    expect(html).toContain("source identity · passed");expect(html).toContain("runtime SHA abcdef12 · corpus SHA 12345678");expect(html).toContain("provider receipt");
  });
  it("names the consequence of explicitly acknowledging an unresolved mutation",()=>{
    const html=renderToStaticMarkup(createElement(JobDetail,{job:{...job,operation:"deploy.production",state:"uncertain"},onAcknowledge:()=>{}}));
    expect(html).toContain("Acknowledge unresolved · allow next mutation");expect(html).toContain("Outcome uncertain");
    expect(html).toContain("may still finish");
  });
  it("offers explicit status lookup and bounded logs without suggesting redispatch",()=>{
    const html=renderToStaticMarkup(createElement(JobDetail,{job:{...job,operation:"checks",state:"uncertain"},onReconcile:()=>{},onLogs:()=>{}} as never));
    expect(html).toContain("Retry status lookup");expect(html).toContain("Read safe log excerpt");expect(html).not.toContain("Run again");
  });
  it("confirms acknowledgement only from a strict true marker and the expected job identity",async()=>{
    const contract=await import("../lib/console-job-contract");const parse=contract.parseJobAcknowledgement;
    const uncertain={...job,operation:"deploy.production" as const,state:"uncertain" as const,target:"production"};
    expect(parse({acknowledged:true,job:uncertain},uncertain)).toEqual(uncertain);
    expect(parse({job:uncertain},uncertain)).toBeNull();
    expect(parse({acknowledged:true,job:{...uncertain,id:"33333333-3333-4333-8333-333333333333"}},uncertain)).toBeNull();
    expect(parse({acknowledged:true,job:{...uncertain,target:"preview"}},uncertain)).toBeNull();
  });
  it("confirms lost-response recovery only from its strict marker and identity",async()=>{
    const {parseJobRecovery}=await import("../lib/console-job-contract");const recovered={...job,state:"uncertain" as const,summary:"outcome uncertain"};
    expect(parseJobRecovery({markedUncertain:true,job:recovered},job)).toEqual(recovered);
    expect(parseJobRecovery({recovered:true,job:recovered},job)).toBeNull();
    expect(parseJobRecovery({markedUncertain:true,job:{...recovered,target:"other"}},job)).toBeNull();
    const queued={...job,operation:"checks" as const,state:"queued" as const};
    expect(parseJobRecovery({markedUncertain:true,job:{...queued,state:"uncertain"}},queued)).toEqual({...queued,state:"uncertain"});
    // A queued diagnostic whose request never claimed it is fenced like any other queued receipt
    // (console_job_mark_uncertain, migration 20260909041000); only a terminal receipt is refused.
    expect(parseJobRecovery({markedUncertain:true,job:recovered},{...job,state:"queued"})).toEqual(recovered);
    expect(parseJobRecovery({markedUncertain:true,job:recovered},{...job,state:"succeeded"})).toBeNull();
  });
  it("polls only an open active or uncertain receipt",()=>{
    expect(shouldPollJob(job,`job:${job.id}`)).toBe(true);
    expect(shouldPollJob({...job,state:"uncertain"},`job:${job.id}`)).toBe(true);
    expect(shouldPollJob({...job,state:"succeeded"},`job:${job.id}`)).toBe(false);
    expect(shouldPollJob(job,undefined)).toBe(false);
  });
  it("uses at least five seconds, pauses while hidden and stops after cleanup",()=>{
    vi.useFakeTimers();let state:DocumentVisibilityState="visible";let listener:(()=>void)|null=null;
    vi.stubGlobal("document",{get visibilityState(){return state;},addEventListener:(_name:string,fn:()=>void)=>{listener=fn;},removeEventListener:()=>{listener=null;}});
    const poll=vi.fn(),cleanup=beginVisibleJobPolling(poll,100);
    vi.advanceTimersByTime(4_999);expect(poll).not.toHaveBeenCalled();vi.advanceTimersByTime(1);expect(poll).toHaveBeenCalledTimes(1);
    const visibility=()=>{expect(listener).not.toBeNull();(listener as ()=>void)();};
    state="hidden";visibility();vi.advanceTimersByTime(10_000);expect(poll).toHaveBeenCalledTimes(1);
    state="visible";visibility();vi.advanceTimersByTime(5_000);expect(poll).toHaveBeenCalledTimes(2);
    cleanup();vi.advanceTimersByTime(10_000);expect(poll).toHaveBeenCalledTimes(2);
  });
});
