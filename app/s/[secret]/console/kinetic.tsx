"use client";
import { useEffect } from "react";

/**
 * The kinetic layer — scroll-entrance choreography for anything carrying a `data-cx` attribute.
 *
 * Server components opt an element in with `data-cx="rise|print|rule|flood"` (and an optional
 * `--cx-d` custom property for stagger); this one client component arms and reveals them. The
 * arming class is added HERE, after mount, never in the server markup — so with JavaScript off,
 * or before hydration, every element is simply visible. Nothing on this console may depend on
 * motion to be readable.
 *
 * Reduced motion is a hard gate, not a shorter animation: when the user asks for reduced motion
 * the elements are never armed and the page is the finished sheet from the first paint.
 *
 * Reveal-once by design — the observer unobserves on entry. A console section that re-animated
 * on every scroll-by would be a dashboard performing; this is a page settling as it is read.
 */
export function Kinetic() {
  useEffect(() => {
    const root = document.querySelector(".conRoot");
    if (!root) return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    // Arm strictly AFTER the document loads: the stream is complete and every boundary has
    // hydrated, so the reveal class can never land mid-hydration (the "1 Issue" badge was
    // exactly that). Server-rendered markup only carries data-cx — client components are
    // excluded by construction, because a client re-render would strip the reveal and
    // re-hide settled content.
    let cancelled = false;
    let cleanup: (() => void) | null = null;
    const start = () => {
      if (cancelled) return;
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (e.isIntersecting) {
            e.target.classList.add("cxIn");
            io.unobserve(e.target);
          }
        }
      },
      { threshold: 0.12, rootMargin: "0px 0px -8% 0px" }
    );
    // ARMING IS ONE CLASS ON THE ROOT, never a per-node mutation. The pages stream, and a
    // classList.add on a node React has not hydrated yet is a hydration mismatch — found live
    // as settings/ask/trends rendering blank when React reasserted className and the reveal
    // was lost. CSS scopes the hidden state to `.cxReady [data-cx]:not(.cxIn)`, so a streamed
    // section is hidden by the ancestor class the moment it arrives (no mutation to race),
    // and the only class this layer ever writes on content is the reveal, which the observer
    // adds strictly after the node is live in the document.
    root.classList.add("cxReady");
    const watch = (el: HTMLElement) => io.observe(el);
    root.querySelectorAll<HTMLElement>("[data-cx]").forEach(watch);
    const mo = new MutationObserver((muts) => {
      for (const m of muts) {
        for (const n of m.addedNodes) {
          if (!(n instanceof HTMLElement)) continue;
          if (n.matches("[data-cx]")) watch(n);
          n.querySelectorAll<HTMLElement>("[data-cx]").forEach(watch);
        }
      }
    });
    mo.observe(root, { childList: true, subtree: true });
      cleanup = () => {
        mo.disconnect();
        io.disconnect();
        root.classList.remove("cxReady");
      };
    };
    if (document.readyState === "complete") setTimeout(start, 80);
    else window.addEventListener("load", () => setTimeout(start, 80), { once: true });
    return () => {
      cancelled = true;
      cleanup?.();
    };
  }, []);
  return null;
}
