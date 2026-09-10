"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { DEVICE_CATEGORIES, deviceLabel, DeviceError, type DeviceCommand, type DeviceItem, type DeviceRoster } from "@/lib/device-contract";
import { deviceEndpoint, readDevices, requestDevice } from "@/lib/device-client";
import { stampUtc } from "./ops-lens";
import styles from "./devices.module.css";

const endpoint=()=>deviceEndpoint(window.location.pathname);
const safeError=(e:unknown)=>e instanceof DeviceError?e:new DeviceError("uncertain");
const changed=()=>window.dispatchEvent(new Event("cortex-inventory-change"));

/** Loaded independently: an unavailable inventory cannot hide or delay the reporter board. */
export function Devices() {
  const [roster,setRoster]=useState<DeviceRoster|null>(null),[loading,setLoading]=useState(true),[loadError,setLoadError]=useState<string|null>(null);
  const [label,setLabel]=useState(""),[category,setCategory]=useState<DeviceItem["category"]>(null);
  const [busy,setBusy]=useState(false),[error,setError]=useState<DeviceError|null>(null),[message,setMessage]=useState("");
  const pending=useRef<Extract<DeviceCommand,{action:"register"}>|null>(null),inFlight=useRef(false),generation=useRef(0);
  const load=useCallback(async()=>{
    const request=++generation.current;setLoading(true);setLoadError(null);
    try{const r=await readDevices(endpoint());if(request===generation.current)setRoster(r);}
    catch{if(request===generation.current){setRoster(null);setLoadError(new DeviceError("unavailable").message);}}
    finally{if(request===generation.current)setLoading(false);}
  },[]);
  useEffect(()=>{void load();return()=>{generation.current++;};},[load]);
  async function register() {
    if(inFlight.current||document.visibilityState!=="visible")return;
    const valid=deviceLabel.safeParse(label);if(!pending.current&&!valid.success){setError(new DeviceError("invalid"));return;}
    inFlight.current=true;setBusy(true);setError(null);setMessage("");
    try {
      if(!pending.current) {
        const prepared=await requestDevice(endpoint(),{action:"prepare"});
        if(prepared.outcome!=="prepared")throw new DeviceError("uncertain");
        pending.current={action:"register",intent:prepared.intent,label:valid.success?valid.data:label,category};
      }
      const saved=await requestDevice(endpoint(),pending.current);
      if(saved.outcome!=="registered")throw new DeviceError("uncertain");
      pending.current=null;setMessage(`Registered this browser as ${saved.item.label}. This is inventory, not a health or access claim.`);changed();await load();
    }catch(e){setError(safeError(e));}
    finally{inFlight.current=false;setBusy(false);}
  }
  return <section className={styles.panel} aria-labelledby="devices-heading">
    <div className="opsPanelHead"><span className="opsHeadLead"><span className="opsTag"><span className="opsTagN">05</span><h2 id="devices-heading" className="opsTagLabel">Devices</h2></span></span><span className="opsHeadMeta">explicit browser inventory · up to 50</span></div>
    <p className={styles.note}>Opening Cortex through Claude alone does not enroll the phone. Open this dashboard on the phone and register its browser. Multiple browsers on one device can be separate entries; no hardware discovery is performed.</p>
    <form className={styles.form} onSubmit={e=>{e.preventDefault();void register();}}>
      <label>Name<input value={label} maxLength={60} autoComplete="off" disabled={busy||Boolean(pending.current)} onChange={e=>setLabel(e.target.value)} placeholder="For example, Phone browser"/></label>
      <label>Category (optional)<select value={category??""} disabled={busy||Boolean(pending.current)} onChange={e=>setCategory((e.target.value||null) as DeviceItem["category"])}><option value="">Not specified</option>{DEVICE_CATEGORIES.map(c=><option key={c}>{c}</option>)}</select></label>
      <button type="submit" className={styles.primary} disabled={busy||Boolean(roster?.currentId)&&!pending.current}>{busy?"Registering…":pending.current?"Retry original registration":"Register this browser"}</button>
    </form>
    {roster?.currentId&&<p className={styles.note}>This browser already has an inventory record. Rename or Forget it below.</p>}
    <p role="status" aria-live="polite" className={styles.note}>{message}</p>
    {error&&<p role="alert" className="opsErr">{error.message}</p>}
    {pending.current&&<div className={styles.note}>Retries keep the original name, category and 24-hour intent. An earlier request may have completed. Refresh and review the roster before discarding this retry.<button type="button" disabled={busy} onClick={()=>{pending.current=null;setError(null);setMessage("Retry discarded explicitly. Review the roster before registering again.");}}>Discard retry; start a new registration</button></div>}
    <div className={styles.header}><span role="status" className={styles.note}>{loading?"Loading device inventory…":roster?`${roster.items.length} of 50 browsers registered`:"Device inventory did not answer · nothing shown"}</span><button type="button" disabled={loading} onClick={()=>void load()}>Refresh inventory</button></div>
    {loadError&&<p role="alert" className="opsErr">{loadError}</p>}
    {!loading&&roster?.items.length===0&&<p className="opsEmpty">no browsers registered yet · Register this browser writes the first row</p>}
    {roster?.items.map(item=><DeviceRow key={item.id} item={item} current={roster.currentId===item.id} onChanged={load}/>)}
    <p className={styles.note}>Last dashboard visit is a throttled observation of an enrolled visible dashboard, not online, health or authentication status. Forget removes this inventory record only; it does not change access, notes, runs or receipts.</p>
  </section>;
}

function DeviceRow({item,current,onChanged}:{item:DeviceItem;current:boolean;onChanged:()=>Promise<void>}) {
  const [label,setLabel]=useState(""),[version,setVersion]=useState(item.updatedAt),[busy,setBusy]=useState(false),[confirm,setConfirm]=useState(false),[error,setError]=useState<DeviceError|null>(null),[message,setMessage]=useState("");
  const inFlight=useRef(false);
  async function change(forget=false) {
    if(inFlight.current)return;inFlight.current=true;setBusy(true);setError(null);setMessage("");
    try {
      const command:DeviceCommand=forget?{action:"forget",id:item.id,updatedAt:version}:{action:"rename",id:item.id,updatedAt:version,label};
      const result=await requestDevice(endpoint(),command);
      if(result.outcome==="renamed"){setVersion(result.item.updatedAt);setLabel("");setMessage("Rename verified.");}
      if(result.outcome==="forgotten")setMessage("Inventory record forgotten. Access is unchanged.");
      setConfirm(false);changed();await onChanged();
    }catch(e){setError(safeError(e));}
    finally{inFlight.current=false;setBusy(false);}
  }
  const blocked=Boolean(error&&(error.code==="conflict"||error.code==="uncertain"));
  return <article className={styles.row}>
    <div><strong>{item.label}</strong>{current&&<span className={styles.current}>This browser</span>}<span className={styles.note}> · {item.category??"category unspecified"}</span></div>
    <p className={styles.note}>Last dashboard visit: {item.lastSeenAt?<time dateTime={item.lastSeenAt}>{stampUtc(item.lastSeenAt)}</time>:"not yet observed"}</p>
    <form className={styles.form} onSubmit={e=>{e.preventDefault();void change();}}><label>New name for {item.label}<input value={label} maxLength={60} autoComplete="off" disabled={busy} onChange={e=>setLabel(e.target.value)} placeholder="Enter a replacement name"/></label><button disabled={busy||blocked} type="submit">Rename</button><button type="button" disabled={busy||blocked} onClick={()=>setConfirm(true)}>Forget…</button></form>
    {confirm&&<div className={styles.note}>Forget {item.label} from inventory only? This does not sign anyone out or revoke access.<button type="button" disabled={busy} onClick={()=>void change(true)}>Confirm Forget</button><button type="button" disabled={busy} onClick={()=>setConfirm(false)}>Keep record</button></div>}
    {error&&<p role="alert" className="opsErr">{error.message}</p>}
    {blocked&&<div className={styles.note}>Refresh the inventory, compare its current name with your draft, then explicitly use the current version.<button type="button" disabled={busy} onClick={()=>{setVersion(item.updatedAt);setError(null);}}>Use current version</button></div>}
    <p role="status" aria-live="polite" className={styles.note}>{busy?"Updating inventory…":message}</p>
  </article>;
}
