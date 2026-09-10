"use client";

import { useEffect, useState } from "react";
import { consoleRoutePath } from "./route-path";
import { STATUS_REFRESH_MS, parseShellStatus, statusView, unavailableStatus, type ShellStatusDto } from "./status-contract";

const STATUS_REQUEST_TIMEOUT_MS = 5_000;

export function StatusChip() {
  const [status, setStatus] = useState<ShellStatusDto | null>(null);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    let active = true, generation=0;
    let controller:AbortController|null=null;
    async function refresh() {
      const own=++generation;
      controller?.abort();controller=new AbortController();
      const owned=()=>active&&generation===own&&document.visibilityState==="visible";
      try {
        const route = consoleRoutePath(window.location.pathname);
        if (!route) throw new Error("console status route is unavailable");
        const res = await fetch(`${route.root}/status`, {
          cache: "no-store",
          headers: { Accept: "application/json" },
          signal: AbortSignal.any([controller.signal,AbortSignal.timeout(STATUS_REQUEST_TIMEOUT_MS)]),
        });
        if (!res.ok) throw new Error("console status request failed");
        const parsed = parseShellStatus(await res.json());
        if (!parsed) throw new Error("console status response was invalid");
        if (owned()) {setNow(Date.now());setStatus(parsed);}
      } catch {
        if (owned()) {setNow(Date.now());setStatus(unavailableStatus(new Date().toISOString()));}
      }
    }

    const visibleRefresh = () => {
      if (document.visibilityState === "visible") {setNow(Date.now());void refresh();}
      else {generation++;controller?.abort();}
    };
    visibleRefresh();
    const interval = window.setInterval(visibleRefresh, STATUS_REFRESH_MS);
    const ageTick=window.setInterval(()=>{if(document.visibilityState==="visible")setNow(Date.now());},1000);
    document.addEventListener("visibilitychange", visibleRefresh);
    return () => {
      active = false;
      generation++;controller?.abort();
      window.clearInterval(interval);
      window.clearInterval(ageTick);
      document.removeEventListener("visibilitychange", visibleRefresh);
    };
  }, []);

  const view = statusView(status, now);
  return (
    <span className="conMode" title={view.title}>
      <i className={`conModeDot conModeDot-${view.mode.tone}`} aria-hidden />
      {view.mode.text}
      {view.sha && (
        <>
          {" · "}
          {view.commitUrl ? (
            <a className="conModeSha" href={view.commitUrl} target="_blank" rel="noopener" title="open the commit on GitHub">{view.sha}</a>
          ) : (
            <span className="conModeSha">{view.sha}</span>
          )}
        </>
      )}
    </span>
  );
}
