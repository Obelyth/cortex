"use client";
import { useEffect } from "react";
import { CursorAccent } from "./cursor-accent";

/** One shared, fail-open entrance layer. data-cx marks sections, never visibility gates.
 * Only their structural headings move; bodies and controls are readable at every frame. */
export function Kinetic() {
  useEffect(() => {
    const root = document.querySelector(".conRoot");
    if (!root) return;
    const motion = window.matchMedia("(prefers-reduced-motion: reduce)");
    const entered = new WeakSet<Element>();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let stop: (() => void) | undefined;
    const pause = () => {
      clearTimeout(timer); timer = undefined;
      stop?.(); stop = undefined;
      root.classList.remove("cxReady");
      // Clearing completed accents prevents a visibility/media resume replay. WeakSet keeps
      // these same nodes out of the observer; new route/stream nodes still enter once.
      root.querySelectorAll(".cxIn").forEach(el => el.classList.remove("cxIn"));
    };
    const start = () => {
      pause();
      if (document.visibilityState === "hidden" || motion.matches || typeof IntersectionObserver === "undefined") return;
      const io = new IntersectionObserver(entries => {
        for (const entry of entries) if (entry.isIntersecting) {
          entered.add(entry.target);
          entry.target.classList.add("cxIn");
          io.unobserve(entry.target);
        }
      }, { threshold: 0, rootMargin: "0px 0px -32px 0px" });
      const watch = (el: Element) => {
        if (!entered.has(el) && !el.classList.contains("cxIn")) io.observe(el);
      };
      root.querySelectorAll("[data-cx]").forEach(watch);
      const mo = new MutationObserver(mutations => {
        for (const mutation of mutations) {
          for (const n of mutation.removedNodes) if (n instanceof Element) {
            io.unobserve(n); n.querySelectorAll("[data-cx]").forEach(el => io.unobserve(el));
          }
          for (const n of mutation.addedNodes) if (n instanceof Element) {
            if (n.matches("[data-cx]")) watch(n);
            n.querySelectorAll("[data-cx]").forEach(watch);
          }
        }
      });
      mo.observe(root, { childList: true, subtree: true });
      root.classList.add("cxReady");
      stop = () => { io.disconnect(); mo.disconnect(); };
    };
    const resume = () => {
      pause();
      if (document.readyState === "complete" && document.visibilityState !== "hidden" && !motion.matches) timer = setTimeout(start, 80);
    };
    window.addEventListener("load", resume);
    document.addEventListener("visibilitychange", resume);
    motion.addEventListener("change", resume);
    resume();
    return () => {
      pause();
      window.removeEventListener("load", resume);
      document.removeEventListener("visibilitychange", resume);
      motion.removeEventListener("change", resume);
    };
  }, []);
  return <CursorAccent />;
}
