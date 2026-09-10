"use client";
import { useState } from "react";

export interface ClipboardWriter {
  writeText(text: string): Promise<void>;
}

export type ClipboardResult = { ok: true } | { ok: false; fallback: string };

/** Attempt the browser write while retaining the exact text for a manual fallback. */
export async function copyExactText(text: string, writer?: ClipboardWriter): Promise<ClipboardResult> {
  const target = writer ?? (typeof navigator === "undefined" ? undefined : navigator.clipboard);
  if (!target) return { ok: false, fallback: text };
  try {
    await target.writeText(text);
    return { ok: true };
  } catch {
    return { ok: false, fallback: text };
  }
}

/**
 * A refused copy. With `text`, the exact value (the connector URL, secret included) is held
 * behind an explicit Reveal and can be hidden again: a screenshot of the failure state carries
 * nothing, the same posture as the masked snippet above it. Without `text`, the exact value is
 * already on screen and the line says to select it.
 */
export function ClipboardFailure({ text = null }: Readonly<{ text?: string | null }>) {
  const [shown, setShown] = useState(false);
  return (
    <div className="setRefused" role="alert">
      <div className="setRefusedRow">
        <span>
          copy failed · {text ? (shown ? "select the exact text below and copy it by hand · hide it before a screenshot" : "reveal to select the exact text by hand") : "select the exact text shown above"}
        </span>
        {text && (
          <button type="button" className="setBtn" aria-expanded={shown} onClick={() => setShown((s) => !s)}>
            {shown ? "hide" : "reveal"}
          </button>
        )}
      </div>
      {text && shown && <pre className="setPre setRefusedPre">{text}</pre>}
    </div>
  );
}
