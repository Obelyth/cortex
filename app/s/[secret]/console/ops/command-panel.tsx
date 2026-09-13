"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { consoleJobPageSchema, consoleJobSchema, jobPreparationSchema,jobOutputSchema,providerCatalogSchema,parseJobAcknowledgement, parseJobRecovery, type ConsoleJob, type ConsoleJobListItem,type JobPreparation,type OperationId } from "@/lib/console-job-contract";
import { consoleRoutePath } from "../route-path";
import { useLens } from "../lens";
import { stampUtc } from "./ops-lens";
import { operationsRequirementAnchor, type OperationsRequirementId } from "@/lib/console-operations-contract";

const POLL_MS = 5_000;
const route = () => `${consoleRoutePath(window.location.pathname)?.root ?? ""}/ops/jobs`;
const active = (state: ConsoleJob["state"]) => state === "queued" || state === "running" || state === "uncertain";
/** The panel's status line carries its tone explicitly — a failure is red because the code that
 *  produced it said so, never because the sentence happened to contain a word. */
type Status = { text: string; tone: "note" | "err" };
const note = (text: string): Status => ({ text, tone: "note" });
const err = (text: string): Status => ({ text, tone: "err" });
const TONE_CLASS: Record<Status["tone"], string> = { note: "opsLensNote", err: "opsErr" };
/** One sentence for the one condition, wherever it is met. */
const SCHEMA_REQUIRED = "Command history needs database setup. An administrator must follow the reviewed fresh-install or upgrade procedure in docs/database-bootstrap.md, then press Refresh. Never reset an existing database.";
export function shouldPollJob(job: ConsoleJob | null, lensId: string | undefined): boolean { return Boolean(job && lensId === `job:${job.id}` && active(job.state)); }
export function beginVisibleJobPolling(poll:()=>void,interval=POLL_MS,onPause?:()=>void):()=>void {
  let timer:ReturnType<typeof setInterval>|null=null;
  const sync=()=>{if(timer)clearInterval(timer);if(document.visibilityState!=="visible")onPause?.();timer=document.visibilityState==="visible"?setInterval(poll,Math.max(POLL_MS,interval)):null;};
  sync();document.addEventListener("visibilitychange",sync);
  return()=>{if(timer)clearInterval(timer);document.removeEventListener("visibilitychange",sync);};
}

export function JobDetail({ job,onAcknowledge,onRecover,onReconcile,onLogs,output }: Readonly<{ job: ConsoleJob;onAcknowledge?:()=>void;onRecover?:()=>void;onReconcile?:()=>void;onLogs?:()=>void;output?:string }>) {
  return <div className="opsJobDetail">
    <p className="opsLensId">{job.id}</p>
    <dl className="opsLensKv">
      <dt>operation</dt><dd>{job.operation}</dd><dt>state</dt><dd>{job.state}</dd>
      <dt>target</dt><dd>{job.target}</dd><dt>requested</dt><dd>{stampUtc(job.requestedAt)}</dd>
      <dt>updated</dt><dd>{stampUtc(job.updatedAt)}</dd><dt>{job.operation==="diagnostics"?"runtime SHA":"application source SHA"}</dt><dd>{job.sourceSha ?? "unavailable"}</dd>
      <dt>provider receipt</dt><dd>{job.providerId ?? "none"}</dd>
    </dl>
    <p className="opsLensDesc">{job.summary}</p>
    <h3 className="opsLensTies">Named checks</h3>
    <ol className="opsJobChecks">
      {job.checks.map((check) => <li key={check.name} className={`opsJobCheck opsJobCheck-${check.state}`}><span>{check.name} · {check.state}</span><small>{check.detail}</small></li>)}
      {job.checks.length === 0 && <li className="opsLensNote">No check results published yet.</li>}
    </ol>
    {job.state === "uncertain" && <><p className="opsErr">Outcome uncertain · no confirmed result came back. While a mutation is unresolved, other migrations and deploys stay blocked until it is looked up or acknowledged as unresolved. An acknowledged run may still finish on the provider — acknowledging does not cancel it and is not success.{onReconcile ? " Press Retry status lookup before you acknowledge." : ""}</p>{onAcknowledge&&<button type="button" className="inkControl opsAct" onClick={onAcknowledge}><span className="inkSweep" aria-hidden="true" />Acknowledge unresolved · allow next mutation</button>}</>}
    {onRecover&&<><p className="opsErr">{job.state==="queued"
      ? `This request never claimed its run — the reply that admitted it was lost before anything was dispatched, and it still holds the one ${job.operation} slot for ${job.target}. Marking it uncertain records that nothing was sent and frees the slot; nothing is cancelled because nothing started.${["migrations.apply","deploy.preview","deploy.production"].includes(job.operation)?" The mutation guard stays until you acknowledge it as unresolved.":""}`
      : "This command may have lost its worker's reply. Marking it uncertain records that and nothing more — it does not cancel the run and does not mean it failed. Other migrations and deploys stay blocked until the run is looked up or acknowledged as unresolved."}</p><button type="button" className="inkControl opsAct" onClick={onRecover}><span className="inkSweep" aria-hidden="true" />Mark lost response uncertain</button></>}
    {(onReconcile||onLogs)&&<div className="opsCommandControls">{onReconcile&&<button type="button" className="inkControl opsAct" onClick={onReconcile}><span className="inkSweep" aria-hidden="true" />Retry status lookup · attach verified result</button>}{onLogs&&<button type="button" className="inkControl opsAct" onClick={onLogs}><span className="inkSweep" aria-hidden="true" />Read safe log excerpt</button>}</div>}
    {output!==undefined&&<pre className="opsJobOutput">{output}</pre>}
  </div>;
}

export function JobConfirmation({preparation,onConfirmed,isCurrent}:Readonly<{preparation:JobPreparation;onConfirmed:(job:ConsoleJob)=>void;isCurrent:()=>boolean}>){
  const [confirmed,setConfirmed]=useState(false),[busy,setBusy]=useState(false),[status,setStatus]=useState("");const sending=useRef(false);
  const send=async()=>{if(!confirmed||sending.current)return;sending.current=true;setBusy(true);setStatus("Submitting this request once…");
    try{const response=await fetch(route(),{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({operation:preparation.operation,requestKey:preparation.requestKey,intent:preparation.intent,confirm:true})});const value=await response.json().catch(()=>null);if(!isCurrent())return;
      const parsed=consoleJobSchema.safeParse(value?.job);
      if(!response.ok||!parsed.success||parsed.data.operation!==preparation.operation||parsed.data.target!==preparation.target||parsed.data.sourceSha!==preparation.sourceSha){setStatus(response.status===409?"Confirmation changed or expired. Close and prepare a fresh plan; no unseen plan was approved.":"Outcome unconfirmed. Recheck this same request or command history; do not create another request.");return;}
      onConfirmed(parsed.data);
    }catch{if(isCurrent())setStatus("Outcome uncertain. Recheck this same request or command history; no automatic resend.");}
    finally{sending.current=false;setBusy(false);}
  };
  return <div className="opsJobDetail"><dl className="opsLensKv"><dt>operation</dt><dd>{preparation.operation}</dd><dt>application SHA</dt><dd>{preparation.sourceSha}</dd><dt>fixed target</dt><dd>{preparation.target}</dd><dt>expires</dt><dd>{stampUtc(preparation.expiresAt)}</dd>{preparation.pendingDigest&&<><dt>pending digest</dt><dd>{preparation.pendingDigest}</dd></>}</dl><p className="opsErr">{preparation.warning}</p><label className="opsLensNote"><input type="checkbox" checked={confirmed} disabled={busy} onChange={event=>setConfirmed(event.target.checked)}/> I confirm this source, target and any unresolved prior work warning.</label><div className="opsCommandControls"><button type="button" className="inkControl opsAct opsActPrimary" disabled={!confirmed||busy} onClick={()=>void send()}><span className="inkSweep" aria-hidden="true" />{busy?"Submitting…":status?"Recheck same request":"Confirm and request execution"}</button></div><p role="status" className="opsLensNote">{status}</p></div>;
}

function ProviderCommandControls({onJob,settingsRoot}:Readonly<{onJob:(job:ConsoleJob)=>void;settingsRoot:string}>){
  const lens=useLens(),current=useRef(lens.lens?.id),generation=useRef(0),viewEpoch=useRef(0);
  if(current.current!==lens.lens?.id)viewEpoch.current++;
  current.current=lens.lens?.id;
  const [providers,setProviders]=useState<Array<{operation:OperationId;configured:boolean;detail:string;setupRequirement?:OperationsRequirementId}>>([]),[status,setStatus]=useState(""),[busy,setBusy]=useState(false);
  const [catalogState,setCatalogState]=useState<"loading"|"ready"|"unavailable">("loading"),catalogGeneration=useRef(0);
  const loadCatalog=async()=>{const own=++catalogGeneration.current;setCatalogState("loading");
    try{const response=await fetch(`${route()}?catalog=1`,{cache:"no-store"});const value=await response.json();if(catalogGeneration.current!==own)return;
      const parsed=providerCatalogSchema.safeParse(value);if(!response.ok||!parsed.success)throw new Error("catalog unavailable");setProviders(parsed.data.providers);setCatalogState("ready");
    }catch{if(catalogGeneration.current===own){setProviders([]);setCatalogState("unavailable");}}
  };
  useEffect(()=>{void loadCatalog();return()=>{catalogGeneration.current++;generation.current++;};},[]);
  const prepare=async(operation:OperationId)=>{if(busy)return;setBusy(true);const own=++generation.current,view=viewEpoch.current,requestKey=crypto.randomUUID();
    const owned=()=>generation.current===own&&viewEpoch.current===view&&document.visibilityState==="visible";
    try{const response=await fetch(route(),{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({action:"prepare",operation,requestKey})});if(!owned())return;const value=await response.json().catch(()=>null);if(!owned())return;
      const parsed=jobPreparationSchema.safeParse(value?.preparation);if(!response.ok||!parsed.success||parsed.data.operation!==operation||parsed.data.requestKey!==requestKey){setStatus(typeof value?.error==="string"?value.error.slice(0,500):"Provider preparation unavailable");return;}
      const lensId=`job-prepare:${parsed.data.requestKey}`;
      lens.open({id:lensId,kind:"command confirmation",title:`Review ${operation}`,body:<JobConfirmation preparation={parsed.data} isCurrent={()=>generation.current===own&&current.current===lensId&&document.visibilityState==="visible"} onConfirmed={onJob}/>});setStatus("");
    }catch{if(owned())setStatus("Provider preparation unavailable; no dispatch requested");}finally{if(generation.current===own)setBusy(false);}
  };
  return <div className="opsProviderControls">{catalogState==="loading"&&<p role="status" className="opsLensNote">Loading provider readiness…</p>}{catalogState==="unavailable"&&<div><p role="status" className="opsErr">Provider readiness unavailable.</p><button type="button" className="inkControl opsAct" onClick={()=>void loadCatalog()}><span className="inkSweep" aria-hidden="true" />Retry readiness</button></div>}{providers.map(provider=><div key={provider.operation}><button type="button" className="inkControl opsAct" disabled={busy||catalogState!=="ready"||!provider.configured} onClick={()=>void prepare(provider.operation)}><span className="inkSweep" aria-hidden="true" />Prepare {provider.operation}</button>{!provider.configured&&<a className="inkControl opsAct" href={`${settingsRoot}#${provider.setupRequirement?operationsRequirementAnchor(provider.setupRequirement):"setOperations"}`}><span className="inkSweep" aria-hidden="true" />Set up permissions</a>}<span className="opsLensNote">{provider.detail}</span></div>)}{status&&<p className="opsErr" role="status">{status}</p>}<p className="opsLensNote">{catalogState==="ready"&&providers.some(provider=>!provider.configured)?"Unavailable commands need one-time hosting permissions configured outside Cortex. The service forms in Settings do not grant those permissions. ":""}A key being present does not prove it works or has the rights it needs. Nothing here runs tests or deploys on its own — every run waits for your confirmation.</p></div>;
}

function asList(job: ConsoleJob): ConsoleJobListItem {
  const { checks, ...rest } = job; return { ...rest, checkCount: checks.length };
}

export function CommandPanel({ secret }: Readonly<{ secret: string }>) {
  const settingsRoot=`/s/${encodeURIComponent(secret)}/console/settings`;
  const lens = useLens();
  const [items, setItems] = useState<ConsoleJobListItem[]>([]);
  const [policy, setPolicy] = useState("Terminal diagnostics and checks are retained for 30 days.");
  const [cursor,setCursor]=useState<string|null>(null);
  const [status, setStatus] = useState<Status>(note("Loading command history…"));
  const [selected, setSelected] = useState<ConsoleJob | null>(null);
  const [busy, setBusy] = useState(false);
  // Declared last on purpose: tests/console-job-panel-lifecycle.test.ts addresses hooks by position.
  // False until the first history fetch settles either way. The list holds its full height only
  // while that is pending, so rows arriving move nothing beneath; once the answer is known the
  // region sizes to what it holds — an empty history is a sentence, not a band of nothing.
  const [settled, setSettled] = useState(false);
  const currentSelection = useRef<ConsoleJob | null>(selected);
  const currentLensId = useRef<string | undefined>(lens.lens?.id);
  const polling = useRef<{ effect: number; request: number; controller: AbortController | null }>({ effect: 0, request: 0, controller: null });
  const presentation = useRef(0);
  const mounted=useRef(true);
  const opening=useRef<{request:number;controller:AbortController|null}>({request:0,controller:null});
  // Keep just the latest explicit, already-redacted excerpt. A status poll must not erase it.
  const lastExcerpt=useRef<{id:string;text:string}|null>(null);
  currentSelection.current = selected;
  currentLensId.current = lens.lens?.id;
  const invalidatePoll = useCallback((effect?:number) => {
    if (effect !== undefined && polling.current.effect !== effect) return;
    polling.current.effect += 1;
    polling.current.request += 1;
    polling.current.controller?.abort();
    polling.current.controller = null;
  }, []);
  const pausePoll = useCallback(() => {
    presentation.current += 1;
    polling.current.request += 1;
    polling.current.controller?.abort();
    polling.current.controller = null;
  }, []);

  const load = useCallback(async (next:string|null,append:boolean) => {
    try {
      const res = await fetch(`${route()}${next?`?cursor=${encodeURIComponent(next)}`:""}`, { cache: "no-store" });
      const value = await res.json().catch(() => null);
      if (!res.ok) {
        const code = value && typeof value === "object" ? (value as Record<string, unknown>).code : null;
        setStatus(err(code === "schema_required" ? SCHEMA_REQUIRED : "Command history did not answer · press Refresh."));
        return;
      }
      const page = consoleJobPageSchema.safeParse(value);
      if (!page.success) { setStatus(err("Command history answered in an unknown shape · press Refresh.")); return; }
      setItems(current=>append?[...current,...page.data.items]:page.data.items);setCursor(page.data.nextCursor); setPolicy(page.data.historyPolicy); setStatus(note(page.data.items.length||append ? "" : "no command receipts yet · Run diagnostics writes the first row"));
    } catch { setStatus(err("Command history did not answer · press Refresh.")); }
    finally { setSettled(true); }
  }, []);
  const refresh=useCallback(()=>load(null,false),[load]);

  useEffect(() => {
    mounted.current=true;void refresh();
    const hide=()=>{if(document.visibilityState!=="visible"){opening.current.request++;opening.current.controller?.abort();}};
    document.addEventListener("visibilitychange",hide);
    return()=>{mounted.current=false;presentation.current++;opening.current.request++;opening.current.controller?.abort();document.removeEventListener("visibilitychange",hide);};
  }, [refresh]);

  const acknowledge=useCallback(async(job:ConsoleJob)=>{
    const own=presentation.current += 1;
    invalidatePoll();
    const owned=()=>mounted.current&&presentation.current===own&&currentLensId.current===`job:${job.id}`&&document.visibilityState==="visible";
    try{const res=await fetch(`${route()}/${job.id}`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({action:"acknowledge-unresolved"})});if(!owned())return;const value=await res.json().catch(()=>null);if(!owned())return;const confirmed=parseJobAcknowledgement(value,job);if(!res.ok||!confirmed){setStatus(err("Acknowledgment did not go through · press Refresh and reopen the receipt."));return;}setSelected(confirmed);setStatus(note("Acknowledged as unresolved · the receipt stays uncertain; the next migration or deploy may start."));}
    catch{if(owned())setStatus(err("Acknowledgment did not go through · press Refresh and reopen the receipt."));}
  },[invalidatePoll]);
  const recover=useCallback(async(job:ConsoleJob)=>{
    invalidatePoll();
    const generation=presentation.current+=1;const expectedLens=`job:${job.id}`;
    const owned=()=>presentation.current===generation&&document.visibilityState==="visible"&&currentLensId.current===expectedLens;
    try{const res=await fetch(`${route()}/${job.id}`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({action:"mark-uncertain"})});if(!owned())return;const value=await res.json().catch(()=>null);if(!owned())return;const recovered=parseJobRecovery(value,job);if(!res.ok||!recovered){setStatus(err("Marking uncertain did not go through · press Refresh and reopen the receipt."));return;}setSelected(recovered);setStatus(note(recovered.operation==="diagnostics"?"Lost diagnostic finalized as uncertain · a new labeled run can proceed.":"Lost response marked uncertain · press Retry status lookup before running it again."));lens.open({id:`job:${recovered.id}`,kind:`command · ${recovered.operation}`,title:recovered.summary,body:<JobDetail job={recovered} onAcknowledge={["migrations.apply","deploy.preview","deploy.production"].includes(recovered.operation)?()=>void acknowledge(recovered):undefined}/>});}
    catch{if(owned())setStatus(err("Marking uncertain did not go through · press Refresh and reopen the receipt."));}
  },[invalidatePoll,lens,acknowledge]);
  const providerAction=async(job:ConsoleJob,action:"reconcile"|"logs")=>{
    if(polling.current.controller){setStatus(note("Provider lookup already running · wait for this receipt."));return;}
    invalidatePoll();const own=++presentation.current;
    const controller=new AbortController();polling.current.controller=controller;
    const owned=()=>presentation.current===own&&document.visibilityState==="visible"&&currentLensId.current===`job:${job.id}`;
    try{const response=await fetch(`${route()}/${job.id}`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({action}),signal:controller.signal});if(!owned())return;const value=await response.json().catch(()=>null);if(!owned())return;
      const parsed=consoleJobSchema.safeParse(value?.job),output=jobOutputSchema.safeParse(value?.output);
      if(!response.ok||!parsed.success||parsed.data.id!==job.id||parsed.data.operation!==job.operation||parsed.data.target!==job.target){setStatus(err("Provider lookup did not answer · the receipt shown is unchanged. Press Retry status lookup."));return;}
      if(output.success)lastExcerpt.current={id:job.id,text:output.data.text};
      setSelected(parsed.data);lens.open({id:`job:${job.id}`,kind:`command · ${job.operation}`,title:parsed.data.summary,body:<JobDetail job={parsed.data} output={lastExcerpt.current?.id===job.id?lastExcerpt.current.text:undefined} onReconcile={()=>void providerAction(parsed.data,"reconcile")} onLogs={()=>void providerAction(parsed.data,"logs")} onAcknowledge={parsed.data.state==="uncertain"&&["migrations.apply","deploy.preview","deploy.production"].includes(parsed.data.operation)?()=>void acknowledge(parsed.data):undefined}/>});
      // `reconciled: "conflict"` (lib/console-job-providers.ts): the provider still reports this
      // acknowledged run in progress while a later command owns its target. The receipt now says so.
      if(value?.reconciled==="conflict")setStatus(err("Provider still reports this run in progress, but a later command now owns its target · this receipt stays uncertain and cannot return to running. Follow the provider run directly; the later command may duplicate its work."));
      else if(value?.reconciled==="resumed")setStatus(note("Provider reports this run still in progress · the receipt is back to running under its original token; nothing was dispatched twice."));
    }catch{if(owned())setStatus(err("Provider lookup did not answer · the receipt shown is unchanged. Press Retry status lookup."));}
    finally{if(polling.current.controller===controller)polling.current.controller=null;}
  };
  const publishLens = useCallback((job: ConsoleJob) => {
    lens.open({ id: `job:${job.id}`, kind: `command · ${job.operation}`, title: job.summary || job.operation, body: <JobDetail job={job} output={lastExcerpt.current?.id===job.id?lastExcerpt.current.text:undefined} onAcknowledge={job.state==="uncertain"&&["migrations.apply","deploy.preview","deploy.production"].includes(job.operation)?()=>void acknowledge(job):undefined} onRecover={job.state==="running"||job.state==="queued"?()=>void recover(job):undefined} onReconcile={job.operation!=="diagnostics"?()=>void providerAction(job,"reconcile"):undefined} onLogs={job.operation!=="diagnostics"?()=>void providerAction(job,"logs"):undefined}/> });
  }, [lens,acknowledge,recover]);

  const open = async (id: string) => {
    presentation.current += 1;
    invalidatePoll();
    opening.current.controller?.abort();
    const controller=new AbortController(),request=++opening.current.request;
    opening.current.controller=controller;
    const expectedLens=`job:${id}`;
    // Open the presentation immediately so it can be dismissed while the bounded read runs.
    currentLensId.current=expectedLens;
    lens.open({id:expectedLens,kind:"command receipt",title:"Loading command receipt…",body:<p className="opsLensNote">Reading this receipt. Closing does not cancel outside work.</p>});
    const owned=()=>mounted.current&&opening.current.request===request&&currentLensId.current===expectedLens&&document.visibilityState==="visible";
    try {
      const res = await fetch(`${route()}/${id}`, { cache: "no-store",signal:controller.signal });if(!owned())return;
      const value = await res.json().catch(() => null);if(!owned())return;
      const parsed = consoleJobSchema.safeParse(value && typeof value === "object" ? (value as Record<string, unknown>).job : null);
      if (!res.ok || !parsed.success || parsed.data.id!==id) { setStatus(err("Command receipt did not load · press Refresh."));lens.open({id:expectedLens,kind:"command receipt",title:"Command receipt unavailable",body:<p className="opsErr">No matching receipt was confirmed. Close and refresh history.</p>});return; }
      setSelected(parsed.data); publishLens(parsed.data);
    } catch { if(owned())setStatus(err("Command receipt did not load · press Refresh.")); }
    finally{if(opening.current.controller===controller)opening.current.controller=null;}
  };

  useEffect(() => {
    if (!shouldPollJob(selected,lens.lens?.id)) return;
    const polled=selected!;
    const effect = polling.current.effect += 1;
    const poll = async () => {
      if (document.visibilityState !== "visible" || polling.current.effect !== effect || polling.current.controller) return;
      const request = polling.current.request += 1;
      const controller = new AbortController();
      polling.current.controller = controller;
      const owned = () => polling.current.effect === effect
        && polling.current.request === request
        && document.visibilityState === "visible"
        && currentSelection.current?.id === polled.id
        && currentLensId.current === `job:${polled.id}`;
      try {
        const res = await fetch(`${route()}/${polled.id}`, { cache: "no-store", signal: controller.signal });
        if (!owned()) return;
        const value = await res.json().catch(() => null);
        if (!owned()) return;
        const parsed = consoleJobSchema.safeParse(value && typeof value === "object" ? (value as Record<string, unknown>).job : null);
        if (res.ok && parsed.success && parsed.data.id===polled.id && parsed.data.operation===polled.operation && parsed.data.target===polled.target) { setSelected(parsed.data); publishLens(parsed.data); }
      } catch { /* the open receipt remains truthful; explicit Refresh can retry */ }
      finally{if(polling.current.controller===controller)polling.current.controller=null;}
    };
    const cleanup=beginVisibleJobPolling(()=>void poll(),POLL_MS,pausePoll);
    return () => { presentation.current += 1; cleanup(); invalidatePoll(effect); };
  }, [selected, lens.lens?.id, publishLens, pausePoll, invalidatePoll]);

  const run = async () => {
    if (busy) return;const own=presentation.current += 1,expectedLens=currentLensId.current;invalidatePoll();opening.current.request++;opening.current.controller?.abort();setBusy(true); setStatus(note("Running diagnostics…"));
    const owned=()=>mounted.current&&presentation.current===own&&currentLensId.current===expectedLens&&document.visibilityState==="visible";
    try {
      const res = await fetch(route(), { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ operation: "diagnostics", requestKey: crypto.randomUUID(), target: "deployment" }) });
      const value = await res.json().catch(() => null);
      if(!owned())return;
      const parsed = consoleJobSchema.safeParse(value && typeof value === "object" ? (value as Record<string, unknown>).job : null);
      if (!res.ok || !parsed.success || parsed.data.operation!=="diagnostics" || parsed.data.target!=="deployment") {
        const code = value && typeof value === "object" ? (value as Record<string, unknown>).code : null;
        // 409 `active`: a receipt still holds the diagnostics slot. The route names it (activeId) when
        // the database can; a queued one whose request never claimed it is fenced from its receipt.
        const activeId = value && typeof value === "object" && typeof (value as Record<string, unknown>).activeId === "string" ? (value as Record<string, unknown>).activeId as string : null;
        setStatus(err(code === "schema_required" ? SCHEMA_REQUIRED : code === "capacity" ? "Command capacity reached · wait for an active receipt to finish, then press Run diagnostics again." : code === "active" ? `Diagnostics already have an active receipt${activeId ? ` · ${activeId}` : ""} · open it; if its request never claimed it, press Mark lost response uncertain to free the slot.` : "Diagnostics did not confirm a receipt · press Refresh and check history before running again."));
        if (activeId) void open(activeId);
        return;
      }
      setItems((current) => [asList(parsed.data), ...current.filter((item) => item.id !== parsed.data.id)].slice(0, 25)); setStatus(note("")); setSelected(parsed.data); publishLens(parsed.data);
    } catch { if(owned())setStatus(err("Diagnostics outcome uncertain · a run may exist. Press Refresh and check history before running again.")); }
    finally { if(mounted.current)setBusy(false); }
  };

  return <section className="opsCommands" aria-labelledby="ops-commands">
    <div className="opsPanelHead"><span className="opsHeadLead"><span className="opsTag"><span className="opsTagN">04</span><h2 id="ops-commands" className="opsTagLabel">Commands</h2></span></span><span className="opsHeadMeta">durable receipts · bounded diagnostics</span></div>
    <div className="opsCommandControls"><button type="button" className="inkControl opsAct opsActPrimary" onClick={() => void run()} disabled={busy}><span className="inkSweep" aria-hidden="true" />{busy ? "Running diagnostics" : "Run diagnostics"}</button><button type="button" className="inkControl opsAct" onClick={() => void refresh()} disabled={busy}><span className="inkSweep" aria-hidden="true" />Refresh</button><span className="opsLensNote">Checks, migrations and deploy require explicit provider configuration; no dispatch occurs without it.</span></div>
    <ProviderCommandControls settingsRoot={settingsRoot} onJob={job=>{presentation.current++;invalidatePoll();setSelected(job);setItems(current=>[asList(job),...current.filter(item=>item.id!==job.id)].slice(0,25));publishLens(job);}}/>
    {/* Always mounted, text swapped: a live region that appears with its content is not reliably announced. */}
    <p className={`opsCommandStatus ${TONE_CLASS[status.tone]}`} role="status">{status.text}</p>
    {/* Full height while the first fetch is pending, so rows arriving move nothing beneath; sized to its rows once settled. */}
    <div className={`opsJobScroll${settled ? "" : " opsJobScroll-pending"}`}>
      <ol className="opsJobList">{items.map((job) => <li key={job.id}><button type="button" className="opsJobRow" aria-haspopup="dialog" onClick={() => void open(job.id)}><span><b>{job.operation}</b><small>{stampUtc(job.requestedAt)} · {job.checkCount} check{job.checkCount === 1 ? "" : "s"}</small></span><span className={`opsChip opsChip-${job.state === "succeeded" ? "ok" : job.state === "failed" ? "crit" : job.state === "uncertain" ? "warn" : "live"}`}>{job.state}</span></button></li>)}</ol>
      {cursor&&<button type="button" className="inkControl opsAct" onClick={()=>void load(cursor,true)}><span className="inkSweep" aria-hidden="true" />Load older receipts</button>}
    </div>
    <p className="opsLensNote">{policy}</p>
  </section>;
}
