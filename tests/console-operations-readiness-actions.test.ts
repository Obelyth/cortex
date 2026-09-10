import {beforeEach,describe,expect,it,vi} from "vitest";
import type {ReactElement} from "react";

const h=vi.hoisted(()=>({effect:null as null|(()=>void|(()=>void)),refresh:vi.fn()}));
vi.mock("react",()=>({
  useEffect:(effect:()=>void|(()=>void))=>{h.effect=effect;},
  useRef:<T,>(value:T)=>({current:value}),
}));
vi.mock("next/navigation",()=>({
  usePathname:()=>"/s/synthetic%20console/console/settings",
  useRouter:()=>({refresh:h.refresh}),
}));

const {OperationsReadinessActions}=await import("../app/s/[secret]/console/settings/operations-readiness-actions");
type Node=ReactElement<{children?:unknown;href?:string;onClick?:()=>void}>;
function nodes(value:unknown):Node[]{if(Array.isArray(value))return value.flatMap(nodes);if(!value||typeof value!=="object"||!("props" in value))return[];const node=value as Node;return[node,...nodes(node.props.children)];}
function content(value:unknown):string{if(Array.isArray(value))return value.map(content).join(" ");if(typeof value==="string")return value;if(value&&typeof value==="object"&&"props" in value)return content((value as Node).props.children);return"";}

beforeEach(()=>{h.effect=null;h.refresh.mockReset();vi.unstubAllGlobals();});

describe("operations readiness navigation lifecycle",()=>{
  it("scrolls and focuses an initial target, follows same-page hashes, and removes its listener",()=>{
    const focus=vi.fn(),scrollIntoView=vi.fn(),addEventListener=vi.fn(),removeEventListener=vi.fn();
    const location={hash:"#setOperations-source"};
    vi.stubGlobal("document",{getElementById:vi.fn(()=>({focus,scrollIntoView}))});
    vi.stubGlobal("window",{location,addEventListener,removeEventListener});
    OperationsReadinessActions();
    const cleanup=h.effect!();
    expect(scrollIntoView).toHaveBeenCalledWith({block:"start"});
    expect(focus).toHaveBeenCalledWith({preventScroll:true});
    expect(addEventListener).toHaveBeenCalledWith("hashchange",expect.any(Function));
    location.hash="#setOperations-database";
    const listener=addEventListener.mock.calls[0][1] as ()=>void;
    listener();
    expect(scrollIntoView).toHaveBeenCalledTimes(2);
    expect(focus).toHaveBeenCalledTimes(2);
    expect(cleanup).toBeTypeOf("function");
    (cleanup as ()=>void)();
    expect(removeEventListener).toHaveBeenCalledWith("hashchange",listener);
  });

  it("keeps return and refresh actions on the encoded current console route",()=>{
    vi.stubGlobal("window",{location:{hash:""},addEventListener:vi.fn(),removeEventListener:vi.fn()});
    vi.stubGlobal("document",{getElementById:vi.fn()});
    const tree=OperationsReadinessActions();
    expect(nodes(tree).find(node=>node.type==="a"&&content(node)==="Return to Ops")?.props.href).toBe("/s/synthetic%20console/console/ops");
    nodes(tree).find(node=>node.type==="button"&&content(node)==="Refresh setup status")!.props.onClick!();
    expect(h.refresh).toHaveBeenCalledOnce();
  });
});
