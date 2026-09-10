"use client";
import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from "react";
import { Glyph } from "./glyph";
import { Overlay } from "./overlay";

/**
 * The lens — v2's one detail drawer for every entity: a note, a unit, a receipt, an inbox item,
 * a proposal, a tool, a commit, a window of calls. A screen opens it with `useLens().open(...)`
 * and renders its entity's body into it; nothing builds a second drawer.
 *
 * The modality is the platform's now (overlay.tsx, a native dialog opened with showModal). It
 * used to claim `aria-modal="true"` on an aside while leaving focus on whatever opened it, so a
 * screen-reader operator activated a mark and landed nowhere, inside a modal they were not in,
 * with the rest of the page hidden from them. Every screen had it, because every screen uses
 * this one lens.
 */
/** `id` names the entity (`unit:<id>`, `receipt:<n>`…) so the screen that opened it can tell
 *  what the lens is showing — to mark the row, or to publish a fresh body when the board
 *  re-reads underneath it. */
export interface LensContent { id?: string; kind: string; title: string; body: ReactNode; say?: string }
interface LensApi { open: (content: LensContent) => void; close: () => void; lens: LensContent | null }
const LensContext = createContext<LensApi | null>(null);

/** What is on screen, and what opened it. One state, so the two can never disagree: a ref written
 *  in the handler and read during render is not reactive — React is free to render without having
 *  seen the write, and the ref outlives the close, so a later render hands the overlay an opener
 *  belonging to a drawer that is no longer up. */
export interface LensState { content: LensContent; opener: Element | null }

/** A content refresh belongs to the drawer that is already open, so it keeps that drawer's page
 * opener. Capturing the dialog itself while an async body republishes loses the only meaningful
 * place to return focus when the operator closes the finished view. */
export function nextLensState(current: LensState | null, content: LensContent, active: Element | null): LensState {
  return { content, opener: current?.opener ?? active };
}

export function LensProvider({ children }: Readonly<{ children: ReactNode }>) {
  const [state, setState] = useState<LensState | null>(null);

  // Capture synchronously because by the time React commits the dialog, platform inertness has
  // blurred the page control. A body republished while the drawer is already open keeps the
  // original page opener; document.activeElement is the dialog at that point, not a new opener.
  const open = useCallback((content: LensContent) => {
    const active = typeof document === "undefined" ? null : document.activeElement;
    setState((current) => nextLensState(current, content, active));
  }, []);
  const close = useCallback(() => setState(null), []);

  const lens = state?.content ?? null;
  // Memoised: eleven screens read this context, and a fresh object every render reconciles all of
  // them — the Ask explorer's ~200 rows among them — for a value that did not change.
  const api = useMemo<LensApi>(() => ({ open, close, lens }), [open, close, lens]);

  return (
    <LensContext.Provider value={api}>
      {children}
      <Overlay
        open={state !== null}
        onClose={close}
        className="lens"
        label={lens?.title ?? "Detail"}
        opener={state?.opener ?? null}
        say={lens?.say ?? ""}
      >
        {lens && (
          <>
            <div className="lensHead">
              <span className="lensKind">{lens.kind}</span>
              <h2 className="lensTitle">{lens.title}</h2>
              <button type="button" className="lensClose" aria-label="Close" onClick={close}><Glyph name="close" /></button>
            </div>
            <div className="lensBody">{lens.body}</div>
          </>
        )}
      </Overlay>
    </LensContext.Provider>
  );
}

export function useLens(): LensApi {
  const api = useContext(LensContext);
  if (!api) throw new Error("useLens must be used inside the console shell");
  return api;
}
