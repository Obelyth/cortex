import { beforeEach,describe,expect,it,vi } from "vitest";

const harness=vi.hoisted(()=>({effects:[] as Array<()=>void|(()=>void)>,callbacks:[] as unknown[],setters:[] as ReturnType<typeof vi.fn>[],states:[] as unknown[],refs:[] as Array<{current:unknown}>,stateCall:0,refCall:0,open:vi.fn(),lens:{id:"job:11111111-1111-4111-8111-111111111111"} as {id:string}|null,interval:null as null|(()=>void),visibility:null as null|(()=>void)}));
vi.mock("react",async(importOriginal)=>{const actual=await importOriginal<typeof import("react")>();return{...actual,useState:<T,>(initial:T)=>{const index=harness.stateCall++;if(!(index in harness.states))harness.states[index]=index===4?JOB:initial;const setter=harness.setters[index]??vi.fn((value:T|((current:T)=>T))=>{harness.states[index]=typeof value==="function"?(value as (current:T)=>T)(harness.states[index] as T):value;});harness.setters[index]=setter;return[harness.states[index] as T,setter] as const;},useEffect:(effect:()=>void|(()=>void))=>harness.effects.push(effect),useCallback:<T,>(fn:T)=>{harness.callbacks.push(fn);return fn;},useRef:<T,>(value:T)=>{const index=harness.refCall++;return (harness.refs[index]??={current:value}) as {current:T};}};});
vi.mock("../app/s/[secret]/console/lens",()=>({useLens:()=>({lens:harness.lens,open:harness.open,close:vi.fn()})}));

const JOB={id:"11111111-1111-4111-8111-111111111111",operation:"diagnostics",state:"running",requestedAt:"2026-09-08T18:00:00.000Z",updatedAt:"2026-09-08T18:00:01.000Z",sourceSha:"abcdef12",target:"deployment",checks:[],summary:"running",providerId:null};
const {CommandPanel}=await import("../app/s/[secret]/console/ops/command-panel");
let resolveFetch:(value:Response)=>void;
const renderPanel=()=>{harness.effects.length=0;harness.callbacks.length=0;harness.stateCall=0;harness.refCall=0;return CommandPanel({secret:"secret"});};
beforeEach(()=>{harness.effects.length=0;harness.callbacks.length=0;harness.setters.length=0;harness.states.length=0;harness.refs.length=0;harness.stateCall=0;harness.refCall=0;harness.open.mockReset();harness.lens={id:`job:${JOB.id}`};harness.interval=null;harness.visibility=null;resolveFetch=()=>{};vi.stubGlobal("window",{location:{pathname:"/s/secret/console/ops"}});vi.stubGlobal("document",{visibilityState:"visible",addEventListener:(_n:string,fn:()=>void)=>{harness.visibility=fn;},removeEventListener:vi.fn()});vi.stubGlobal("setInterval",vi.fn((fn:()=>void)=>{harness.interval=fn;return 1;}));vi.stubGlobal("clearInterval",vi.fn());vi.stubGlobal("fetch",vi.fn(()=>new Promise<Response>(resolve=>{resolveFetch=resolve;})));});

describe("in-flight command receipt ownership",()=>{
  it("does not abort or replace a healthy lookup at the next five-second poll",async()=>{
    renderPanel();const cleanup=harness.effects[1]() as ()=>void;
    harness.interval?.();await Promise.resolve();const firstSignal=(vi.mocked(fetch).mock.calls[0][1] as RequestInit).signal!;
    harness.interval?.();await Promise.resolve();
    expect(fetch).toHaveBeenCalledTimes(1);expect(firstSignal.aborted).toBe(false);
    resolveFetch(Response.json({job:{...JOB,state:"succeeded",summary:"slow verified result"}}));for(let i=0;i<20;i++)await Promise.resolve();
    expect(harness.open).toHaveBeenCalledWith(expect.objectContaining({title:"slow verified result"}));cleanup();
  });
  it.each(["logs","reconcile"] as const)("keeps delayed %s replies out of dismissed or replaced drawers and accepts immediate results",async(action)=>{
    const provider={...JOB,operation:"checks",sourceSha:"b".repeat(40),target:"github:fixture/app"};
    for(const event of ["close","selection","immediate"]){
      harness.lens=null;renderPanel();(harness.callbacks[6] as (j:typeof provider)=>void)(provider);
      const drawer=harness.open.mock.calls.at(-1)![0];const callback=drawer.body.props[action==="logs"?"onLogs":"onReconcile"];
      harness.lens={id:`job:${JOB.id}`};renderPanel();harness.open.mockClear();callback();await Promise.resolve();
      if(event!=="immediate"){harness.lens=event==="close"?null:{id:"job:33333333-3333-4333-8333-333333333333"};renderPanel();}
      resolveFetch(Response.json({job:{...provider,state:"succeeded",summary:"verified"},...(action==="logs"?{output:{available:true,text:"safe excerpt",clipped:false}}:{})}));for(let i=0;i<20;i++)await Promise.resolve();
      if(event==="immediate"){expect(harness.open).toHaveBeenCalledWith(expect.objectContaining({id:`job:${JOB.id}`,title:"verified"}));if(action==="logs"){
        expect(harness.open.mock.calls[0][0].body.props.output).toBe("safe excerpt");
        renderPanel();(harness.callbacks[6] as (j:typeof provider)=>void)(provider);
        expect(harness.open.mock.calls.at(-1)![0].body.props.output).toBe("safe excerpt");
      }}
      else expect(harness.open).not.toHaveBeenCalled();
    }
  });
  it.each(["close","selection","hidden","unmount"])("does not publish a delayed poll after %s",async(event)=>{
    renderPanel();const cleanup=harness.effects[1]() as ()=>void;harness.interval?.();await Promise.resolve();
    if(event==="hidden"){Object.defineProperty(document,"visibilityState",{value:"hidden",configurable:true});harness.visibility?.();}else{if(event==="close")harness.lens=null;if(event==="selection")harness.lens={id:"job:33333333-3333-4333-8333-333333333333"};cleanup();}
    resolveFetch(Response.json({job:{...JOB,state:"succeeded",summary:"done"}}));for(let i=0;i<10;i++)await Promise.resolve();expect(harness.open).not.toHaveBeenCalled();
  });
  it.each(["close","selection","hidden","unmount"])("keeps a delayed durable recovery out of stale UI after %s",async(event)=>{
    renderPanel();const cleanup=harness.effects[1]() as ()=>void;const recover=harness.callbacks[5] as (job:typeof JOB)=>Promise<void>;const pending=recover(JOB);await Promise.resolve();
    if(event==="hidden"){Object.defineProperty(document,"visibilityState",{value:"hidden",configurable:true});harness.visibility?.();}else{if(event==="close")harness.lens=null;if(event==="selection")harness.lens={id:"job:33333333-3333-4333-8333-333333333333"};cleanup();}
    resolveFetch(Response.json({markedUncertain:true,job:{...JOB,state:"uncertain",summary:"uncertain"}}));await pending;for(let i=0;i<5;i++)await Promise.resolve();expect(fetch).toHaveBeenCalledTimes(1);expect(harness.open).not.toHaveBeenCalled();expect(harness.setters[3]).not.toHaveBeenCalled();expect(harness.setters[4]).not.toHaveBeenCalled();
  });
  it("publishes a valid immediate recovery from the drawer callback created before opening",async()=>{
    harness.lens=null;renderPanel();const publish=harness.callbacks[6] as (job:typeof JOB)=>void;publish(JOB);const drawer=harness.open.mock.calls[0][0];const recover=(drawer.body as {props:{onRecover:()=>void}}).props.onRecover;
    harness.lens={id:`job:${JOB.id}`};renderPanel();harness.open.mockClear();recover();await Promise.resolve();resolveFetch(Response.json({markedUncertain:true,job:{...JOB,state:"uncertain",summary:"uncertain"}}));for(let i=0;i<10;i++)await Promise.resolve();
    expect(harness.open).toHaveBeenCalledWith(expect.objectContaining({id:`job:${JOB.id}`,title:"uncertain"}));expect(harness.setters[3]).toHaveBeenCalledWith({text:"Lost diagnostic finalized as uncertain · a new labeled run can proceed.",tone:"note"});expect(harness.setters[4]).toHaveBeenCalledWith(expect.objectContaining({state:"uncertain"}));
  });
});
