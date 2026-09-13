import {afterEach,beforeEach,describe,expect,it,vi} from "vitest";
import {createElement,type ReactElement} from "react";
const h=vi.hoisted(()=>({states:[] as unknown[],refs:[] as Array<{current:unknown}>,effects:[] as Array<()=>void|(()=>void)>,state:0,ref:0,lens:{id:"existing"} as {id:string}|null,open:vi.fn()}));
vi.mock("react",async(original)=>({...await original<typeof import("react")>(),useState:<T,>(initial:T)=>{const i=h.state++;if(!(i in h.states))h.states[i]=initial;return[h.states[i],(v:T|((x:T)=>T))=>{h.states[i]=typeof v==="function"?(v as (x:T)=>T)(h.states[i] as T):v;}];},useRef:<T,>(v:T)=>h.refs[h.ref++]??(h.refs[h.ref-1]={current:v}),useEffect:(fn:()=>void|(()=>void))=>h.effects.push(fn),useCallback:<T,>(fn:T)=>fn}));
vi.mock("../app/s/[secret]/console/lens",()=>({useLens:()=>({lens:h.lens,open:h.open,close:vi.fn()})}));
const {CommandPanel,JobConfirmation}=await import("../app/s/[secret]/console/ops/command-panel");
type Node=ReactElement<{children?:unknown;"aria-hidden"?:boolean|string;onClick?:()=>void;onChange?:(e:{target:{checked:boolean}})=>void;disabled?:boolean;isCurrent?:()=>boolean}>;
function nodes(value:unknown):Node[]{if(Array.isArray(value))return value.flatMap(nodes);if(!value||typeof value!=="object"||!("props" in value))return[];const n=value as Node;return[n,...nodes(n.props.children)];}
function text(value:unknown):string{if(Array.isArray(value))return value.map(text).join("");if(typeof value==="string")return value;if(value&&typeof value==="object"&&"props" in value){const node=value as Node;return node.props["aria-hidden"]===true||node.props["aria-hidden"]==="true"?"":text(node.props.children);}return "";}
function render<T>(component:()=>T):T{h.state=0;h.ref=0;h.effects=[];return component();}
const preparation={operation:"checks" as const,requestKey:"22222222-2222-4222-8222-222222222222",sourceSha:"b".repeat(40),target:"github:fixture/app",pendingDigest:null,expiresAt:"2026-09-08T01:00:00Z",intent:"fixed.synthetic.intent",warning:"Review source and target"};
const job={id:"11111111-1111-4111-8111-111111111111",operation:"checks",state:"running",requestedAt:"2026-09-08T00:00:00Z",updatedAt:"2026-09-08T00:00:00Z",sourceSha:preparation.sourceSha,target:preparation.target,summary:"accepted",providerId:"123",checks:[]};
let respond:(r:Response)=>void;
beforeEach(()=>{h.states=[];h.refs=[];h.lens={id:"existing"};h.open.mockReset();vi.stubGlobal("crypto",{randomUUID:()=>preparation.requestKey});vi.stubGlobal("window",{location:{pathname:"/s/secret/console/ops"}});vi.stubGlobal("document",{visibilityState:"visible",addEventListener:vi.fn(),removeEventListener:vi.fn()});vi.stubGlobal("fetch",vi.fn(()=>new Promise<Response>(r=>{respond=r;})));});
afterEach(()=>vi.unstubAllGlobals());
function controls(secret="secret"){const panel=render(()=>CommandPanel({secret}));const child=nodes(panel).find(n=>typeof n.type==="function"&&n.type.name==="ProviderCommandControls")!;h.states=[[{operation:"checks",configured:true,detail:"configured"}],"",false,"ready"];h.refs=[];return()=>render(()=> (child.type as (p:unknown)=>ReactElement)(child.props));}
const flush=async()=>{for(let i=0;i<20;i++)await Promise.resolve();};
describe("provider presentation ownership",()=>{
  it("keeps aria-hidden false labels while excluding decorative true labels",()=>{
    for(const hidden of [false,"false",undefined])expect(text(createElement("span",{"aria-hidden":hidden as false},"Prepare"))).toBe("Prepare");
    for(const hidden of [true,"true"])expect(text(createElement("span",{"aria-hidden":hidden as true},"Decoration"))).toBe("");
  });
  it.each([
    {catalog:{operation:"deploy.production",configured:false,detail:"Missing configuration",setupRequirement:"vercel"},anchor:"setOperations-vercel"},
    {catalog:{operation:"checks",configured:false,detail:"Missing configuration"},anchor:"setOperations"},
  ])("links a blocked command to its local Settings requirement: $anchor",async({catalog,anchor})=>{
    const view=controls("synthetic-console");h.states=[];expect(text(view())).toContain("Loading provider readiness");h.effects[0]();
    respond(Response.json({providers:[catalog]}));await flush();
    const blocked=view();
    const link=nodes(blocked).find(n=>n.type==="a"&&text(n)==="Set up permissions");
    expect(link).toBeDefined();
    expect((link!.props as {href?:string}).href).toBe(`/s/synthetic-console/console/settings#${anchor}`);
    const prepare=nodes(blocked).find(n=>n.type==="button"&&text(n).startsWith("Prepare "));
    expect(prepare).toBeDefined();
    expect(prepare!.props.disabled).toBe(true);
  });

  it("encodes the authenticated route segment before linking to Settings",async()=>{
    const view=controls("synthetic/console value");h.states=[];view();h.effects[0]();
    respond(Response.json({providers:[{operation:"checks",configured:false,detail:"Missing configuration",setupRequirement:"github"}]}));await flush();
    const link=nodes(view()).find(n=>n.type==="a"&&text(n)==="Set up permissions");
    expect((link!.props as {href?:string}).href).toBe("/s/synthetic%2Fconsole%20value/console/settings#setOperations-github");
  });

  it.each(["http error","malformed"])("shows unavailable catalog and a working retry after %s instead of silent setup",async(failure)=>{
    const view=controls();h.states=[];expect(text(view())).toContain("Loading provider readiness");h.effects[0]();
    const catalog={providers:[{operation:"checks",configured:true,detail:"Configured presence only"}]};
    respond(Response.json(failure==="http error"?catalog:{unexpected:true},{status:failure==="http error"?503:200}));await flush();
    const failed=view();expect(text(failed)).toContain("Provider readiness unavailable");const retry=nodes(failed).find(n=>n.type==="button"&&text(n).includes("Retry readiness"));expect(retry).toBeDefined();retry!.props.onClick!();
    respond(Response.json(catalog));await flush();const ready=view();expect(text(ready)).not.toContain("One-time provider setup is required");expect(nodes(ready).find(n=>n.type==="button"&&text(n).includes("Prepare")&&text(n).includes("checks"))?.props.disabled).toBe(false);
  });
  it("does not present another preparation's identity or operation",async()=>{
    const view=controls();nodes(view()).find(n=>n.type==="button")!.props.onClick!();
    respond(Response.json({preparation:{...preparation,requestKey:"33333333-3333-4333-8333-333333333333",operation:"deploy.production"}}));await flush();expect(h.open).not.toHaveBeenCalled();
  });
  it.each(["dismiss","other receipt"])("does not reopen a drawer after preparation loses ownership to %s",async(event)=>{
    const view=controls();const tree=view();nodes(tree).find(n=>n.type==="button")!.props.onClick!();
    h.lens=event==="dismiss"?null:{id:"job:another"};view();respond(Response.json({preparation}));await flush();expect(h.open).not.toHaveBeenCalled();
  });
  it("keeps an immediate prepared confirmation live after opening the drawer",async()=>{
    const view=controls();nodes(view()).find(n=>n.type==="button")!.props.onClick!();respond(Response.json({preparation}));await flush();
    expect(h.open).toHaveBeenCalledTimes(1);const drawer=h.open.mock.calls[0][0];h.lens={id:drawer.id};view();expect((drawer.body as Node).props.isCurrent!()).toBe(true);
  });
  it("retains the same signed intent after a lost result and suppresses a dismissed confirmation's late success",async()=>{
    let current=true;const confirmed=vi.fn();const view=()=>render(()=>JobConfirmation({preparation,onConfirmed:confirmed,isCurrent:()=>current}));
    nodes(view()).find(n=>n.type==="input")!.props.onChange!({target:{checked:true}});nodes(view()).find(n=>n.type==="button")!.props.onClick!();
    respond(Response.json({error:"uncertain"},{status:503}));await flush();nodes(view()).find(n=>n.type==="button")!.props.onClick!();
    expect(vi.mocked(fetch).mock.calls.map(c=>JSON.parse(c[1]!.body as string))).toEqual(Array(2).fill({operation:"checks",requestKey:preparation.requestKey,intent:preparation.intent,confirm:true}));
    current=false;respond(Response.json({job}));await flush();expect(confirmed).not.toHaveBeenCalled();
    current=true;expect(nodes(view()).find(n=>n.type==="button")!.props.disabled).toBe(false);
  });
  it("accepts an immediate exact confirmed receipt but refuses changed source",async()=>{
    const confirmed=vi.fn();const view=()=>render(()=>JobConfirmation({preparation,onConfirmed:confirmed,isCurrent:()=>true}));
    nodes(view()).find(n=>n.type==="input")!.props.onChange!({target:{checked:true}});nodes(view()).find(n=>n.type==="button")!.props.onClick!();respond(Response.json({job:{...job,sourceSha:"c".repeat(40)}}));await flush();expect(confirmed).not.toHaveBeenCalled();
    nodes(view()).find(n=>n.type==="button")!.props.onClick!();respond(Response.json({job}));await flush();expect(confirmed).toHaveBeenCalledWith(job);
  });
});
