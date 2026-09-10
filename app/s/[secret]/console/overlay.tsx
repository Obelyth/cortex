"use client";
import { useCallback, useEffect, useRef, type ReactNode } from "react";
import { chooseReturn } from "./focus-return";

/**
 * The console's one overlay: a native <dialog> opened with showModal(), plus the four things the
 * platform does not give.
 *
 * WHY NATIVE, AND WHY IT STAYS PUT. showModal() supplies the whole modal contract — the top
 * layer, inertness for everything outside, focus confined to the dialog, focus moved in on open,
 * Escape via the cancel event, and ::backdrop. What it does NOT supply is a restore that survives
 * the opener being unmounted, a light dismiss, scroll locking, or a live region.
 *
 * It must NOT be portalled, and does not need to be. theme.css declares the entire token
 * dictionary on `.conRoot` (:19), `[data-ground="paper"]` is a descendant override (:132), and
 * both focus rules are `.conRoot`-scoped. A dialog moved to document.body would lose every token —
 * `background: var(--surface)` renders transparent, a `font:` shorthand naming an undefined var
 * invalidates whole, paper renders as ink, and the focus ring this work exists to fix disappears.
 * The top layer is a paint and stacking concept, not a DOM move: the element stays a child of
 * `.conRoot` and still draws above the masthead.
 *
 * THE RESTORE RUNS EXACTLY ONCE, AND ONLY ON A REAL CLOSE. That is harder than it sounds, because
 * three different things end a dialog and only one of them should move focus:
 *   - the operator closes it (Escape, the backdrop, the button, or a screen calling close()) —
 *     restore;
 *   - React unmounts the tree under it — do NOT restore: the opener is going away too, and
 *     focusing a disappearing node lands on <body>, which is focus nowhere.
 * The platform already separates these for us. Removing an open dialog from the document runs the
 * "removing steps", which destroy its close watcher WITHOUT firing close — so an unmount is silent
 * by construction and the restore simply never runs. All this file has to do is not undo that: the
 * close() call lives in the effect's body, never in its cleanup, because a cleanup runs on unmount
 * too and would turn a silent teardown back into a close event.
 */
export interface OverlayProps {
  open: boolean;
  onClose: () => void;
  /** The class the screen styles it with — .lens today. */
  className: string;
  label: string;
  /** The element that opened it, captured by the caller in the same commit that opened it. */
  opener?: Element | null;
  /** Live text for content that arrives after the first paint. Empty until there is something. */
  say?: string;
  children: ReactNode;
}

export function Overlay({ open, onClose, className, label, opener, say = "", children }: Readonly<OverlayProps>) {
  const ref = useRef<HTMLDialogElement>(null);
  /** The opener's id, captured when the overlay opens rather than on every render, so a later
   *  opener with no id cannot inherit the previous one's. */
  const openerId = useRef<string | null>(null);

  const restore = useCallback(() => {
    const el = ref.current;
    const choice = chooseReturn({
      active: document.activeElement,
      opener: opener ?? null,
      openerId: openerId.current,
      overlay: el,
      floor: document.body,
    });
    if (choice.to === "stand-down") return;
    const target =
      choice.to === "opener"
        ? (opener as HTMLElement | null)
        : choice.to === "opener-id"
          ? document.getElementById(choice.id)
          : document.querySelector<HTMLElement>("main.conBody");
    target?.focus();
  }, [opener]);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (!open) {
      // A state-driven close, and the only path that should move focus: close() fires the close
      // event, which runs restore. Doing this in the effect BODY rather than its cleanup matters —
      // a cleanup also runs on unmount, and closing there would restore focus into a tree that is
      // being removed.
      if (el.open) el.close();
      return;
    }
    openerId.current = opener instanceof HTMLElement && opener.id ? opener.id : null;
    // showModal() on an already-open dialog throws InvalidStateError. It stays open when a lens
    // body opens a second entity: content and opener change together, the dialog does not blink.
    if (!el.open) el.showModal();
    // Deterministic rather than engine-dependent: the "focus the dialog itself" fallback replaced
    // an older "first focusable descendant" rule and engines crossed over at different versions.
    // A body that wants an input focused opts in with autofocus and we get out of the way. Never
    // the close button: it announces "Close, button" over the title of a drawer just asked for.
    if (!el.querySelector("[autofocus]")) el.focus();
    // Saved and put back rather than cleared, so a page that was already locked stays locked. Two
    // overlays would nest correctly by the same arithmetic; there is only ever one.
    const lock = document.documentElement.style.overflow;
    document.documentElement.style.overflow = "hidden";
    return () => { document.documentElement.style.overflow = lock; };
  }, [open, opener]);

  return (
    <dialog
      ref={ref}
      className={className}
      tabIndex={-1}
      aria-label={label}
      onCancel={(e) => { e.preventDefault(); onClose(); }}
      onClose={restore}
      onMouseDown={(e) => { if (e.target === ref.current) onClose(); }}
    >
      {children}
      {/* Mounted empty and filled a commit later: a live region inserted together with its own
          text is not reliably announced. It sits last so its text follows the drawer's body in the
          reading order rather than preceding it. Empty is the case today — no screen passes `say`
          yet — and an empty status region announces nothing and reads as nothing. A screen that
          starts using it must not repeat text already in the body, or an operator reading the
          drawer through will hear that line twice: once live, once on the way past. */}
      <p className="srOnly" role="status" aria-live="polite">{say}</p>
    </dialog>
  );
}
