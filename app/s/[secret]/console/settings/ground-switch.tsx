"use client";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import type { Ground } from "../ground";
import { Row } from "./rows";
import { Switch } from "./settings-client";
import { CURSOR_EVENT, readCursorPreference, saveCursorPreference } from "../cursor-preference";

function CursorSwitch() {
  const [enabled, setEnabled] = useState(false);
  const [unsaved, setUnsaved] = useState(false);
  useEffect(() => {
    const sync = () => setEnabled(readCursorPreference());
    sync(); window.addEventListener("storage", sync); window.addEventListener(CURSOR_EVENT, sync);
    return () => { window.removeEventListener("storage", sync); window.removeEventListener(CURSOR_EVENT, sync); };
  }, []);
  return <Row label="Cursor accent" sub={<>Optional slow-turning orange and teal outline around your desktop pointer. Your normal cursor stays visible. Off for touch, reduced motion and high contrast.{unsaved && <span role="status"> This visit only; browser storage is unavailable.</span>}</>}>
    <Switch label="Cursor accent" on={enabled} disabled={false} onClick={() => setUnsaved(!saveCursorPreference(!enabled))} />
  </Row>;
}

/** The one switch that changes the world: paper on, ink off. The choice is a cookie on this
 *  device; the root attribute flips at once so the change is seen before the refresh lands.
 *  It writes through settings/ground, not the store — this is the device's choice, never the
 *  deployment's. */
export function GroundSwitch({ ground }: Readonly<{ ground: Ground }>) {
  const [g, setG] = useState<Ground>(ground);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const router = useRouter();
  const flip = async () => {
    const next: Ground = g === "paper" ? "ink" : "paper";
    setBusy(true);
    setErr(null);
    try {
      const res = await fetch("settings/ground", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ground: next }) });
      if (!res.ok) { setErr(`${res.status} · nothing written · try again`); return; }
      setG(next);
      document.querySelector(".conRoot")?.setAttribute("data-ground", next);
      router.refresh();
    } catch (e) {
      setErr(`${e instanceof Error ? e.message : "network"} · nothing written · try again`);
    } finally {
      setBusy(false);
    }
  };
  return (
    <><Row
      label="Light mode"
      sub={
        <>
          On uses Paper; off uses Ink. Saved for this browser only.
          {err && <span role="alert"> · {err}</span>}
        </>
      }
    >
      <Switch label="Light mode" on={g === "paper"} disabled={false} busy={busy} onClick={() => void flip()} />
    </Row><CursorSwitch /></>
  );
}
