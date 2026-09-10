// @vitest-environment happy-dom
import {act,createElement} from "react";
import {createRoot,type Root} from "react-dom/client";
import {afterEach,beforeEach,describe,expect,it,vi} from "vitest";
import {OperationsReadinessPanel} from "../app/s/[secret]/console/settings/operations-readiness";
import {getOperationsReadiness} from "../lib/console-operations-readiness";

vi.mock("next/navigation",()=>({useRouter:()=>({refresh:vi.fn()}),usePathname:()=>"/s/synthetic-console/console/settings"}));

let host:HTMLDivElement,root:Root;
beforeEach(async()=>{
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT",true);
  host=document.createElement("div");document.body.append(host);root=createRoot(host);
  await act(async()=>root.render(createElement(OperationsReadinessPanel,{view:getOperationsReadiness({CORTEX_VERCEL_TOKEN:"secret-canary"})})));
});
afterEach(async()=>{await act(async()=>root.unmount());host.remove();vi.unstubAllGlobals();});

describe("readiness copy-name controls",()=>{
  it("copies only the selected variable name after an explicit click and announces success",async()=>{
    const writeText=vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator",{clipboard:{writeText}});
    const button=host.querySelector<HTMLButtonElement>('button[aria-label="Copy name CORTEX_VERCEL_TOKEN"]');
    expect(button).not.toBeNull();
    expect(writeText).not.toHaveBeenCalled();
    await act(async()=>button!.click());
    expect(writeText).toHaveBeenCalledExactlyOnceWith("CORTEX_VERCEL_TOKEN");
    expect(button!.closest("tr")!.textContent).toContain("Name copied");
    expect(host.textContent).not.toContain("secret-canary");
  });

  it("keeps the exact name selectable and announces a denied clipboard write without success",async()=>{
    const writeText=vi.fn().mockRejectedValue(new Error("denied-canary"));
    vi.stubGlobal("navigator",{clipboard:{writeText}});
    const button=host.querySelector<HTMLButtonElement>('button[aria-label="Copy name CORTEX_VERCEL_PROJECT_ID"]');
    expect(button).not.toBeNull();
    await act(async()=>button!.click());
    const row=button!.closest("tr")!;
    expect(row.textContent).toContain("select the name");
    expect(row.querySelector("code")!.textContent).toBe("CORTEX_VERCEL_PROJECT_ID");
    expect(row.textContent).not.toContain("Name copied");
    expect(host.textContent).not.toContain("denied-canary");
  });
});
