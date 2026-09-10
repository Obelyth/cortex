"use client";
import { useEffect, useRef, useState } from "react";
import { ClipboardFailure, copyExactText } from "./clipboard";
import { setupFor } from "./setup";
import { CONFIGURATION_GROUPS } from "../../../../../lib/console-configuration-contract";

/**
 * One env row, and the steps behind its caret.
 *
 * The row itself is unchanged — name, what it is for, set or not set. What is new is that it
 * opens: three short steps rather than nine rows of reference text on a screen nobody asked to
 * read. Closed by default, and closed again when it is answered, so the screen states the shape
 * of the deployment and only explains the part you are standing on.
 *
 * Supported services link to their existing write-only setup editor. Root credentials and
 * unsupported services remain provider-managed; these reference rows never accept values.
 */
export function DoorFold({ label, sub, set, value, configurationAvailable = false }: Readonly<{
  label: string; sub: string; set: boolean | null; value?: string; configurationAvailable?: boolean;
}>) {
  const step = setupFor(label);
  const capability = configurationAvailable ? step?.capability : undefined;
  const [copyState, setCopyState] = useState<"idle" | "copied" | "failed">("idle");
  /** The pending "copied" reset. Kept so it can be cancelled: a fold collapsing or the screen
   *  navigating inside the 2s window would otherwise fire setCopied on a component that is gone,
   *  and two quick clicks would stack two resets, the first of which flips the label back early. */
  const reset = useRef<number | null>(null);
  const attempt=useRef(0);
  const invalidate=()=>{attempt.current++;if(reset.current!==null)window.clearTimeout(reset.current);reset.current=null;};
  useEffect(()=>{invalidate();setCopyState("idle");return()=>invalidate();},[label]);

  const copy = async () => {
    if (!step) return;
    invalidate();const own=attempt.current;
    try {
      const result = await copyExactText(step.command);
      if(attempt.current!==own)return;
      if (!result.ok) {
        setCopyState("failed");
        return;
      }
      setCopyState("copied");
      if (reset.current !== null) window.clearTimeout(reset.current);
      reset.current = window.setTimeout(() => {if(attempt.current===own)setCopyState("idle");reset.current=null;}, 2000);
    } catch {
      if(attempt.current===own)setCopyState("failed");
    }
  };

  const val = set === null
    ? <span className="setVal setValMuted">{value}</span>
    : <span className={`setVal ${set ? "setValOn" : "setValOff"}`}>{set ? "set" : "not set"}</span>;

  // An address row has nothing to walk through, so it stays a plain row rather than a dead caret.
  if (!step) {
    return (
      <div className="setRow">
        <span className="setRowBody"><span className="setLabel">{label}</span><span className="setSub">{sub}</span></span>
        {val}
      </div>
    );
  }

  return (
    <details className="setFold" onToggle={event=>{if(!event.currentTarget.open){invalidate();setCopyState("idle");}}}>
      <summary className="setFoldSum">
        <span className="setRowBody"><span className="setLabel">{label}</span><span className="setSub">{sub}</span></span>
        {val}
      </summary>
      <div className="setFoldBody">
        <p className="setFoldWhy">{step.unlocks}</p>
        {capability && <p className="setFoldWhy">
          <a href={`#setConfiguration-${capability}`}>Open {CONFIGURATION_GROUPS[capability].label} setup</a>
          {" — review prerequisites and save this service’s configuration without leaving Cortex. Saving does not deploy it."}
        </p>}
        <details className="setFold" onToggle={event=>{if(!event.currentTarget.open){invalidate();setCopyState("idle");}}}>
          <summary className="setFoldSum">{capability ? "Manual provider setup (advanced)" : "Provider-managed setup"}</summary>
        <ol className="setDoorSteps">
          {step.mint && (
            <li className="setDoorStep">
              <span className="setDoorStepN" aria-hidden>1</span>
              <span>Get the value — <a href={step.mint.href} target="_blank" rel="noopener noreferrer">{step.mint.label}</a></span>
            </li>
          )}
          <li className="setDoorStep">
            <span className="setDoorStepN" aria-hidden>{step.mint ? 2 : 1}</span>
            <span>
              {capability
                ? "Alternatively, add these variables in your hosting provider’s project settings. Optional CLI commands:"
                : "This setting is managed outside Cortex. Add it in your hosting provider’s project settings. Optional CLI commands:"}
              <code className="setCmd">{step.command}</code>
              <button type="button" className="setCopy" onClick={copy} aria-live="polite">
                {copyState === "copied" ? "copied" : copyState === "failed" ? "copy failed" : "copy"}
              </button>
              {copyState === "failed" && <ClipboardFailure />}
            </span>
          </li>
          <li className="setDoorStep">
            <span className="setDoorStepN" aria-hidden>{step.mint ? 3 : 2}</span>
            <span>Deploy the updated environment, then reload Settings. A saved variable is not active in the running app until a new deployment uses it.</span>
          </li>
        </ol>
        </details>
      </div>
    </details>
  );
}
