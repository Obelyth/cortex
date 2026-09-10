// @vitest-environment happy-dom
import {act,createElement} from "react";
import {createRoot} from "react-dom/client";
import {it,expect,vi} from "vitest";
vi.mock("next/navigation",()=>({useRouter:()=>({refresh:vi.fn()}),usePathname:()=>"/s/synthetic/console/settings"}));
import {GuestRows,SettingsWrites} from "../app/s/[secret]/console/settings/settings-client";

it("loads a concurrent guest-policy conflict into mounted controls before the next explicit edit",async()=>{
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT=true;
  const host=document.createElement("div");document.body.append(host);const root=createRoot(host);
  const first="a".repeat(40),second="b".repeat(40);const posts:any[]=[];
  const current={scope:["notes/a.md"],citations:false,dailyAsks:50,maxK:8,revision:second};
  vi.stubGlobal("fetch",vi.fn(async(_url:unknown,init?:RequestInit)=>{
    const body=JSON.parse(String(init?.body));posts.push(body);
    return posts.length===1?Response.json({code:"conflict",family:"guest",current},{status:409}):Response.json({ok:true,guest:{...current,citations:true,revision:"c".repeat(40)}});
  }));
  try{
    await act(async()=>root.render(createElement(SettingsWrites,null,createElement(GuestRows,{g:{open:true,storeState:"store",scope:["projects/","notes/a.md"],citations:false,dailyAsks:50,maxK:8,revision:first,usedToday:0,queued:0}}))));
    const projects=()=>[...host.querySelectorAll("button")].find(b=>b.textContent==="projects/")!;
    await act(async()=>projects().click());
    expect(posts[0].guest.expectedRevision).toBe(first);
    expect(projects().getAttribute("aria-pressed")).toBe("false");
    const citations=host.querySelector<HTMLButtonElement>('[aria-label="Show sources with answers"]')!;
    await act(async()=>citations.click());
    expect(posts[1]).toEqual({guest:{citations:true,expectedRevision:second}});
    expect(projects().getAttribute("aria-pressed")).toBe("false");
  }finally{await act(async()=>root.unmount());host.remove();vi.unstubAllGlobals();}
});
