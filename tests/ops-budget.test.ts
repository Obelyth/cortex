import {afterEach,beforeEach,expect,it,vi} from "vitest";
import {__setOpsStore,type OpsStore} from "../lib/ops";
import {__setMailer} from "../lib/mail";
import {GET} from "../app/api/ops/sweep/route";
import {runSweep} from "../lib/sweep";
const dating=vi.hoisted(()=>({undated:vi.fn(),setCommitDate:vi.fn(),lookup:vi.fn()}));
vi.mock("../lib/mirror",async importOriginal=>({...await importOriginal<typeof import("../lib/mirror")>(),noteDater:()=>({undated:dating.undated,setCommitDate:dating.setCommitDate}),lastCommitDateOf:dating.lookup}));
const tick=(ms:number)=>vi.setSystemTime(Date.now()+ms);
const unit={id:"u",kind:"routine",name:"Unit",pages:true,max_run_s:60,grace_s:0,period_s:null,tolerance:1,owner:"none",paused_until:null,run_now:null,notes:null} as const;
beforeEach(()=>{vi.useFakeTimers();vi.setSystemTime(0);vi.stubEnv("CRON_SECRET","c".repeat(32));vi.stubEnv("GITHUB_TOKEN","synthetic");__setMailer(null);vi.clearAllMocks();});
afterEach(()=>{vi.useRealTimers();vi.unstubAllEnvs();__setOpsStore(undefined);__setMailer(undefined);});
const store=(slow=false):OpsStore=>({
  listUnits:async()=>{if(slow)tick(8000);return slow?[unit]:[];},
  sweepSnapshot:async()=>{tick(8000);return {token:"1",unit,run:null,ack:null,monitor:{visual:"scheduled",failures:0,accepted_alert:0,recovered_alert:0}};},
  recordSweep:async()=>{tick(8000);return {state:"recorded",transition:false};},
  claimAlert:async()=>null,completeAlert:async()=>"accepted",
} as unknown as OpsStore);
it("defers note dating when slow Ops calls have consumed its worst-case remaining budget",async()=>{
  __setOpsStore(store(true));
  const res=await GET(new Request("https://synthetic.invalid/api/ops/sweep",{headers:{authorization:`Bearer ${"c".repeat(32)}`}}));
  const body=await res.json();expect(body.dating).toEqual({deferred:"request budget"});expect(body.unavailable).toContain("delivery_deferred_budget");
  expect(dating.undated).not.toHaveBeenCalled();expect(Date.now()).toBe(24000);
});
it("reserves the full dating lookup and write before beginning another path",async()=>{
  __setOpsStore(store());
  dating.undated.mockImplementation(async()=>{tick(10000);return ["one.md","two.md","three.md"];});
  dating.lookup.mockImplementation(async()=>{tick(15000);return "2026-09-01T00:00:00Z";});
  dating.setCommitDate.mockImplementation(async()=>{tick(10000);});
  const res=await GET(new Request("https://synthetic.invalid/api/ops/sweep",{headers:{authorization:`Bearer ${"c".repeat(32)}`}}));
  expect((await res.json()).dating.dated).toBe(1);expect(dating.lookup).toHaveBeenCalledTimes(1);expect(Date.now()).toBe(35000);
});
it("does not begin a provider claim when the shared deadline cannot fit claim/send/completion",async()=>{
  const s=store();s.claimAlert=vi.fn(async()=>null);
  const result=await runSweep(s,{envelope:{from:"a",to:"b",credential:"a".repeat(64)},send:vi.fn()},new Date(),"https://synthetic.invalid/",23000);
  expect(result.unavailable).toContain("delivery_deferred_budget");expect(s.claimAlert).not.toHaveBeenCalled();
});
it("counts an observed prefix and services its queued alert before the next slow tick can starve delivery",async()=>{
  const s=store(true);s.listUnits=async()=>{tick(8000);return [unit,{...unit,id:"later"}];};
  const envelope={from:"a",to:"b",credential:"a".repeat(64)};let queued=false;
  s.recordSweep=async()=>{tick(8000);queued=true;return {state:"recorded"};};
  s.claimAlert=vi.fn(async()=>queued?{state:"sending" as const,unit_id:"u",id:1,claim_token:"token",subject:"s",body:"b",provider_key:"stable",envelope,first_claim_at:new Date().toISOString(),lease_until:new Date(Date.now()+60000).toISOString()}:null);
  s.completeAlert=async()=>{queued=false;return "accepted";};
  const mail={envelope,send:vi.fn(async()=>({ok:true as const,id:"accepted"}))};
  const first=await runSweep(s,mail,new Date(),"https://synthetic.invalid/");
  expect(first.checked).toBe(1);expect(first.unavailable).toEqual(["sweep_budget","delivery_deferred_budget"]);expect(mail.send).not.toHaveBeenCalled();
  const second=await runSweep(s,mail,new Date(),"https://synthetic.invalid/");
  expect(second.checked).toBe(1);expect(second.paged).toEqual(["u"]);expect(mail.send).toHaveBeenCalledTimes(1);
});
