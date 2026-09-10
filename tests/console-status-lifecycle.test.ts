// @vitest-environment happy-dom
import {act,createElement} from "react";
import {createRoot} from "react-dom/client";
import {it,expect,vi} from "vitest";
import {StatusChip} from "../app/s/[secret]/console/status-chip";
it("publishes only the latest visible response at receipt time and ages it without another response",async()=>{
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT=true;vi.useFakeTimers();vi.setSystemTime(new Date("2026-09-09T00:00:00Z"));
  window.history.replaceState(null,"","/s/synthetic/console/ask");
  const replies:Array<(res:Response)=>void>=[];vi.stubGlobal("fetch",()=>new Promise<Response>(resolve=>replies.push(resolve)));
  const host=document.createElement("div");document.body.append(host);const root=createRoot(host);
  try{
    await act(async()=>root.render(createElement(StatusChip)));
    await act(async()=>document.dispatchEvent(new Event("visibilitychange")));
    expect(replies).toHaveLength(2);
    await act(async()=>{await vi.advanceTimersByTimeAsync(2000);replies[1](Response.json({state:"live",sha:"bbbbbbbb",commitUrl:null,checkedAt:new Date(Date.now()+4000).toISOString()}));});
    expect(host.textContent).toContain("bbbbbbbb");expect(host.textContent).toContain("mirror in sync");
    await act(async()=>replies[0](Response.json({state:"live",sha:"aaaaaaaa",commitUrl:null,checkedAt:new Date().toISOString()})));
    expect(host.textContent).toContain("bbbbbbbb");expect(host.textContent).not.toContain("aaaaaaaa");
    await act(async()=>vi.advanceTimersByTimeAsync(55000));expect(host.textContent).toContain("status unavailable");
  }finally{await act(async()=>root.unmount());host.remove();vi.unstubAllGlobals();vi.useRealTimers();}
});
