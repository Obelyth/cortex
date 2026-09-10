// @vitest-environment happy-dom
import {act,createElement} from "react";
import {createRoot} from "react-dom/client";
import {it,expect,vi} from "vitest";
const copy=vi.hoisted(()=>vi.fn());
vi.mock("../app/s/[secret]/console/settings/clipboard",async original=>({...await original<any>(),copyExactText:copy}));
import {WireClient} from "../app/s/[secret]/console/settings/wire-client";
import {DoorFold} from "../app/s/[secret]/console/settings/door-fold";
it.each(["wire","door"] as const)("owns %s copy completion by selection, attempt, and mount",async(kind)=>{
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT=true;vi.useFakeTimers();copy.mockReset();
  const completions:Array<(r:any)=>void>=[];copy.mockImplementation(()=>new Promise(resolve=>completions.push(resolve)));
  const host=document.createElement("div");document.body.append(host);const root=createRoot(host);
  const view=(label="MCP_TOKEN")=>kind==="wire"?createElement(WireClient,{guestOpen:false}):createElement(DoorFold,{label,sub:"synthetic",set:false});
  const button=(text:string)=>[...host.querySelectorAll("button")].find(b=>b.textContent===text)!;
  try{
    await act(async()=>root.render(view()));await act(async()=>button("copy").click());
    await act(async()=>{if(kind==="wire")button("Cursor").click();else root.render(view("CONNECTOR_PATH_SECRET"));});
    await act(async()=>completions[0]({ok:false,fallback:"obsolete-synthetic"}));
    expect(host.textContent).not.toContain("copy failed");expect(host.textContent).not.toContain("obsolete-synthetic");
    await act(async()=>button("copy").click());await act(async()=>completions[1]({ok:true}));expect(host.textContent).toContain("copied");
    await act(async()=>{await vi.advanceTimersByTimeAsync(1000);button("copied").click();});
    await act(async()=>completions[2]({ok:false,fallback:"current-synthetic"}));
    await act(async()=>vi.advanceTimersByTimeAsync(2000));expect(host.textContent).toContain("copy failed");
  }finally{await act(async()=>root.unmount());host.remove();vi.useRealTimers();}
});

it("discards late clipboard feedback when the manual setup fold closes",async()=>{
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT=true;copy.mockReset();
  let finish!:(result:any)=>void;
  copy.mockImplementation(()=>new Promise(resolve=>{finish=resolve;}));
  const host=document.createElement("div");document.body.append(host);const root=createRoot(host);
  try{
    await act(async()=>root.render(createElement(DoorFold,{label:"MCP_TOKEN",sub:"synthetic",set:false})));
    const [outer,manual]=host.querySelectorAll("details");
    await act(async()=>{outer.open=true;manual.open=true;});
    await act(async()=>host.querySelector("button")!.click());
    await act(async()=>{manual.open=false;manual.dispatchEvent(new Event("toggle"));});
    await act(async()=>finish({ok:false}));
    expect(host.textContent).not.toContain("copy failed");
  }finally{await act(async()=>root.unmount());host.remove();}
});
