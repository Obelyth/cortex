// @vitest-environment happy-dom
import {act,createElement} from "react";
import {createRoot} from "react-dom/client";
import {it,expect,vi} from "vitest";
vi.mock("../app/s/[secret]/console/overlay",()=>({Overlay:({open,children}:any)=>open?createElement("aside",null,children):null}));
import {LensProvider} from "../app/s/[secret]/console/lens";
import {CommandPanel} from "../app/s/[secret]/console/ops/command-panel";
const a="11111111-1111-4111-8111-111111111111",b="22222222-2222-4222-8222-222222222222";
const job=(id:string)=>({id,operation:"diagnostics",state:"succeeded",requestedAt:"2026-09-08T18:00:00.000Z",updatedAt:"2026-09-08T18:00:01.000Z",sourceSha:"abcdef12",target:"deployment",checks:[],summary:id===a?"Receipt A":"Receipt B",providerId:null});
it.each(["selection","close","unmount","mismatch","immediate"])("owns the actual mounted initial job request after %s",async(event)=>{
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT=true;window.history.replaceState(null,"","/s/synthetic/console/ops");
  const pending=new Map<string,(r:Response)=>void>();
  vi.stubGlobal("fetch",async(url:string)=>{
    if(url.endsWith("?catalog=1"))return Response.json({providers:[]});
    if(url.endsWith("/jobs"))return Response.json({items:[a,b].map(id=>({...job(id),checks:undefined,checkCount:0})),nextCursor:null,historyPolicy:"synthetic"});
    return new Promise<Response>(resolve=>pending.set(url.split("/").at(-1)!,resolve));
  });
  const host=document.createElement("div");document.body.append(host);const root=createRoot(host);
  const render=(panel=true)=>createElement(LensProvider,null,panel?createElement(CommandPanel,{secret:"synthetic"}):createElement("span",null,"navigated"));
  const click=async(id:string)=>act(async()=>{(host.querySelectorAll<HTMLButtonElement>(".opsJobRow")[id===a?0:1]).click();});
  const resolve=async(id:string,value=job(id))=>act(async()=>pending.get(id)!(Response.json({job:value})));
  try{
    await act(async()=>root.render(render()));
    if(event==="close"){await click(b);await resolve(b);}
    await click(a);
    if(event==="selection"){await click(b);await resolve(b);}
    if(event==="close")await act(async()=>host.querySelector<HTMLButtonElement>('[aria-label="Close"]')!.click());
    if(event==="unmount")await act(async()=>root.render(render(false)));
    await resolve(a,event==="mismatch"?job(b):job(a));
    const title=host.querySelector(".lensTitle")?.textContent;
    if(event==="immediate")expect(title).toBe("Receipt A");
    else if(event==="selection")expect(title).toBe("Receipt B");
    else expect(title).not.toBe("Receipt A");
    if(event==="close")expect(host.querySelector(".lensTitle")).toBeNull();
    if(event==="mismatch")expect(title).not.toBe("Receipt B");
  }finally{await act(async()=>root.unmount());host.remove();vi.unstubAllGlobals();}
});
