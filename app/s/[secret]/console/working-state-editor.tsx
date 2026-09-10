"use client";
import { useRef, useState } from "react";
import { BUBBLE_KINDS, type BubbleKind } from "@/lib/bubble";
import { safeText } from "@/lib/frontmatter";
import { editorCommand, readWorkingItem, requestWorkingChange, workingStateUrl, WorkingClientError, type WorkingDraft } from "@/lib/working-state-client";
import type { WorkingCommand, WorkingItem } from "@/lib/working-state-contract";
import { useLens } from "./lens";
import styles from "./working-state-editor.module.css";

/** The same editor lives in the shared focus-restoring drawer on Ask and Overview.
 * Drafts and pending add identities are memory-only; no URL, storage, analytics or logging. */
export function WorkingStateEditor({project="",item,onSaved}:{project?:string;item?:WorkingItem;onSaved:()=>void}) {
  const lens=useLens();
  const [current,setCurrent]=useState(item);
  const [draft,setDraft]=useState<WorkingDraft>({kind:item?.kind??"handoff",project:item?.project??project,body:item?.body??""});
  const [replaceBody,setReplaceBody]=useState(false);
  const [replaceProject,setReplaceProject]=useState(false);
  // Mask provenance belongs to the draft, even when a later refresh changes the stored flags.
  const [maskedDraft,setMaskedDraft]=useState({body:Boolean(item?.bodyRedacted),project:Boolean(item?.projectRedacted)});
  const [busy,setBusy]=useState(false);
  const inFlight=useRef(false);
  const [error,setError]=useState<WorkingClientError|null>(null);
  const [review,setReview]=useState<WorkingItem|null>(null);
  const [saved,setSaved]=useState<WorkingItem|null>(null);
  const [dropConfirm,setDropConfirm]=useState(false);
  const pendingAdd=useRef<WorkingCommand|null>(null);
  const requestKey=useRef<string|null>(null);
  const protectedBody=Boolean((current?.bodyRedacted||maskedDraft.body)&&!replaceBody);
  const protectedProject=Boolean((current?.projectRedacted||maskedDraft.project)&&!replaceProject);
  // A draft the command would not carry. After a conflict refresh brings back a redacted item,
  // the field shows the operator's own text read-only while editorCommand omits it — so a save
  // kept the stored text and reported "Saved" over a draft that went nowhere. Held means: the
  // stored text is redacted, replacement was not chosen, and what is on screen is authored
  // rather than the mask or the text the editor opened with. Saving waits until the operator
  // either chooses replacement (sending the draft) or closes the editor (discarding it), and
  // the status says which.
  const heldBody=protectedBody&&!maskedDraft.body&&draft.body.trim()!==""&&draft.body!==(item?.body??"");
  const heldProject=protectedProject&&!maskedDraft.project&&draft.project!==(item?.project??project);
  const held=heldBody||heldProject;
  const heldNote=heldBody&&heldProject
    ?"Your notes and project are held back: the stored notes and project are redacted, so the draft above will not be sent. Press Replace hidden notes and Replace project to send it."
    :heldBody
      ?"Your notes are held back: the stored notes are redacted, so the notes above will not be sent. Press Replace hidden notes to send them."
      :"Your project is held back: the stored project is redacted, so the project above will not be sent. Press Replace project to send it.";
  const disabled=busy||Boolean(saved)||Boolean(current&&current.status!=="open");
  const needsRefresh=Boolean(error&&(error.code==="conflict"||error.code==="uncertain")&&current);
  const endpoint=()=>workingStateUrl(window.location.pathname);

  async function save(drop=false) {
    if(inFlight.current||saved||needsRefresh||review||(held&&!drop))return;
    inFlight.current=true;setBusy(true);setError(null);
    try {
      let command:WorkingCommand;
      if(current)command=drop?{action:"drop",id:current.id,version:current.version}:editorCommand(draft,current,replaceBody,replaceProject,maskedDraft);
      else {
        requestKey.current??=crypto.randomUUID();
        command=pendingAdd.current??{action:"add",requestKey:requestKey.current,...draft};
      }
      // Validation refusal has no write; transport uncertainty freezes the attempted add payload.
      const result=await requestWorkingChange(endpoint(),command).catch(e=>{
        if(command.action==="add"&&e instanceof WorkingClientError&&e.code!=="invalid")pendingAdd.current=command;
        throw e;
      });
      pendingAdd.current=null;setSaved(result.item);setDropConfirm(false);onSaved();
    }catch(e){setError(e instanceof WorkingClientError?e:new WorkingClientError("uncertain"));}
    finally{inFlight.current=false;setBusy(false);}
  }
  async function refresh() {
    if(!current||inFlight.current)return;
    inFlight.current=true;setBusy(true);
    try{setReview(await readWorkingItem(endpoint(),current.id));setError(null);}
    catch(e){setError(e instanceof WorkingClientError?e:new WorkingClientError("unavailable"));}
    finally{inFlight.current=false;setBusy(false);}
  }
  return <form className={styles.form} onSubmit={e=>{e.preventDefault();void save();}}>
    <p className={styles.note}>Short working notes: where things stand, the next action, the constraints that matter. Open items ride into their project's context and handoff (brain_context, brain_handoff). Untouched items age out after 14 days; history remains.</p>
    {current&&<div className={styles.note}>Draft based on item #{current.id} · version {current.version} · {current.status}</div>}
    <label className={styles.field}>Kind<select value={draft.kind} disabled={disabled} onChange={e=>setDraft({...draft,kind:e.target.value as BubbleKind})}>{BUBBLE_KINDS.map(k=><option key={k} value={k}>{k}</option>)}</select></label>
    <label className={styles.field}>Project<input value={protectedProject&&maskedDraft.project?current!.project:draft.project} maxLength={80} disabled={disabled} readOnly={protectedProject} onChange={e=>setDraft({...draft,project:e.target.value})} autoComplete="off" placeholder="Project name; blank means general"/></label>
    {protectedProject&&<div className={styles.note}>The project field is protected from replacing hidden text. The current stored project will be preserved until you choose replacement; any authored draft stays here. <button type="button" className={styles.button} disabled={disabled} onClick={()=>{setReplaceProject(true);setMaskedDraft({...maskedDraft,project:false});if(maskedDraft.project)setDraft({...draft,project:""});}}>Replace project</button></div>}
    <label className={styles.field}>Short notes<textarea value={protectedBody&&maskedDraft.body?current!.body:draft.body} maxLength={2000} disabled={disabled} readOnly={protectedBody} onChange={e=>setDraft({...draft,body:e.target.value})} placeholder={"Where things stand:\nNext action:\nImportant constraints:"}/></label>
    {protectedBody&&<div className={styles.note}>These notes are protected from replacing hidden text. Editing other fields preserves the current stored notes. Choose replacement to supply your own notes; any authored draft stays here. <button type="button" className={styles.button} disabled={disabled} onClick={()=>{setReplaceBody(true);setMaskedDraft({...maskedDraft,body:false});if(maskedDraft.body)setDraft({...draft,body:""});}}>Replace hidden notes</button></div>}
    <div className={styles.note}>{draft.body.length} / 2,000 characters · saved working state is separate from Preview context</div>
    <div role="status" aria-live="polite">{busy?"Saving or refreshing working state…":saved?`Verified item #${saved.id} · version ${saved.version} · ${saved.status}. ${saved.status==="open"?"Saved and eligible for project context while current.":"Retained as history; it does not ride open context."}`:held?heldNote:""}</div>
    {saved&&<section><p className={styles.note}>Current stored item (the draft above is no longer being edited):</p><div className={styles.current}>{safeText(saved.project||"general",40)} · {safeText(saved.kind,20)}{"\n"}{saved.body}</div></section>}
    {error&&<div role="alert">{error.message}{pendingAdd.current&&<p className={styles.note}>Retry original save resolves the exact earlier notes. Any newer draft text stays here and is not sent by that retry.</p>}</div>}
    {review&&<section>
      <p>Current stored item #{review.id} · version {review.version} · {review.status}</p>
      <div className={styles.current}>{safeText(review.project||"general",40)} · {safeText(review.kind,20)}{"\n"}{review.body}</div>
      {review.status==="open"?<button type="button" className={styles.button} onClick={()=>{setCurrent(review);setReview(null);setError(null);setReplaceBody(false);setReplaceProject(false);}}>Use refreshed version; keep my draft</button>:<p className={styles.note}>This item is no longer open. Your draft remains visible above; it cannot overwrite filed or aged history.</p>}
    </section>}
    <div className={styles.actions}>
      {!saved&&<button type="submit" className={`${styles.button} ${styles.primary}`} disabled={disabled||needsRefresh||Boolean(review)||held}>{busy?"Working…":pendingAdd.current?"Retry original save":current?"Save changes":"Add working state"}</button>}
      {current&&!saved&&<button type="button" className={styles.button} disabled={busy} onClick={()=>void refresh()}>Refresh item</button>}
      {current?.status==="open"&&!saved&&!dropConfirm&&<button type="button" className={styles.button} disabled={disabled||needsRefresh||Boolean(review)} onClick={()=>setDropConfirm(true)}>Drop item…</button>}
      {dropConfirm&&<><p className={styles.note}>Age this item out of working context? Its history stays in the store.</p><button type="button" className={styles.button} disabled={disabled||needsRefresh||Boolean(review)} onClick={()=>void save(true)}>Confirm age out</button><button type="button" className={styles.button} onClick={()=>setDropConfirm(false)}>Keep item</button></>}
      <button type="button" className={styles.button} disabled={busy} onClick={lens.close}>{saved?"Done":"Close editor"}</button>
    </div>
  </form>;
}
