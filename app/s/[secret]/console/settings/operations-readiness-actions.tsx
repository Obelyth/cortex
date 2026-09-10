"use client";

import {useEffect} from "react";
import {usePathname,useRouter} from "next/navigation";
import {consoleRoutePath} from "../route-path";

const OPERATIONS_TARGET=/^setOperations(?:-(?:source|github|vercel|database))?$/;

export function focusOperationsHash(hash:string,getById:(id:string)=>HTMLElement|null=(id)=>document.getElementById(id)):boolean {
  let id="";
  try{id=hash.startsWith("#")?decodeURIComponent(hash.slice(1)):"";}catch{return false;}
  if(!OPERATIONS_TARGET.test(id))return false;
  const target=getById(id);
  if(!target)return false;
  target.scrollIntoView({block:"start"});
  target.focus({preventScroll:true});
  return true;
}

export function OperationsReadinessActions() {
  const pathname=usePathname();
  const router=useRouter();
  const root=consoleRoutePath(pathname)?.root;
  useEffect(()=>{
    const focusTarget=()=>focusOperationsHash(window.location.hash);
    focusTarget();
    window.addEventListener("hashchange",focusTarget);
    return()=>window.removeEventListener("hashchange",focusTarget);
  },[]);
  return <div className="setOpsActions">
    <a className="setOpsAction" href={root?`${root}/ops`:pathname}>Return to Ops</a>
    <button className="setOpsAction" type="button" onClick={()=>router.refresh()}>Refresh setup status</button>
    <span>Refresh only reloads this Settings route. It does not run tests, deploy, or write to a provider.</span>
  </div>;
}
