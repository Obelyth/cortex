"use client";
import { useEffect, useRef } from "react";
import { CURSOR_EVENT, readCursorPreference } from "./cursor-preference";
import "./cursor-accent.css";

/** An optional outline at the native pointer. Tracking stays event-driven; CSS owns rotation. */
export function CursorAccent() {
  const ref = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    const accent = ref.current;
    const root = accent?.closest(".conRoot");
    if (!accent || !root) return;
    const fine = window.matchMedia("(min-width: 1100px) and (hover: hover) and (pointer: fine)");
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)");
    const forced = window.matchMedia("(forced-colors: active)");
    let enabled = readCursorPreference(), frame = 0, x = 0, y = 0;
    let stop: (() => void) | undefined;
    const hide = () => { cancelAnimationFrame(frame); frame = 0; accent.hidden = true; };
    const update = () => {
      stop?.(); stop = undefined; hide();
      if (!enabled || !fine.matches || reduced.matches || forced.matches || document.visibilityState === "hidden") return;
      const move = (event: Event) => {
        const e = event as PointerEvent;
        const target = e.target instanceof Element ? e.target : null;
        if (e.pointerType !== "mouse" || e.buttons || !target || target.closest('input, textarea, select, [contenteditable]:not([contenteditable="false"]), [draggable="true"], dialog') || !window.getSelection()?.isCollapsed) { hide(); return; }
        const cursor = getComputedStyle(target).cursor;
        if (cursor === "text" || cursor === "vertical-text" || e.clientX < 0 || e.clientY < 0 || e.clientX >= window.innerWidth || e.clientY >= window.innerHeight) { hide(); return; }
        x = e.clientX; y = e.clientY;
        if (!frame) frame = requestAnimationFrame(() => {
          frame = 0; accent.style.transform = `translate3d(${x}px, ${y}px, 0)`; accent.hidden = false;
        });
      };
      root.addEventListener("pointermove", move, { passive: true });
      root.addEventListener("pointerleave", hide);
      root.addEventListener("pointerdown", hide);
      root.addEventListener("dragstart", hide);
      root.addEventListener("keydown", hide);
      window.addEventListener("blur", hide);
      document.addEventListener("selectionchange", hide);
      window.addEventListener("scroll", hide, { passive: true });
      const mo = new MutationObserver(hide);
      mo.observe(root, { childList: true, subtree: true });
      stop = () => {
        mo.disconnect();
        root.removeEventListener("pointermove", move); root.removeEventListener("pointerleave", hide);
        root.removeEventListener("pointerdown", hide); root.removeEventListener("dragstart", hide);
        root.removeEventListener("keydown", hide); window.removeEventListener("blur", hide);
        document.removeEventListener("selectionchange", hide); window.removeEventListener("scroll", hide);
      };
    };
    const storage = () => { enabled = readCursorPreference(); update(); };
    window.addEventListener(CURSOR_EVENT, storage); window.addEventListener("storage", storage);
    document.addEventListener("visibilitychange", update);
    for (const mq of [fine, reduced, forced]) mq.addEventListener("change", update);
    update();
    return () => {
      stop?.(); hide(); window.removeEventListener(CURSOR_EVENT, storage); window.removeEventListener("storage", storage);
      document.removeEventListener("visibilitychange", update);
      for (const mq of [fine, reduced, forced]) mq.removeEventListener("change", update);
    };
  }, []);
  return <span ref={ref} className="cxCursor" aria-hidden="true" hidden>
    <svg className="cxCursorOutline" viewBox="0 0 32 32" fill="none" strokeWidth="1" strokeLinecap="round" focusable="false">
      <circle className="cxCursorOrange" cx="16" cy="16" r="14.5" pathLength="100" strokeDasharray="46 54" />
      <circle className="cxCursorTeal" cx="16" cy="16" r="14.5" pathLength="100" strokeDasharray="46 54" strokeDashoffset="-50" />
    </svg>
  </span>;
}
