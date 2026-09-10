"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import type { Ground } from "../ground";
import { Row } from "./rows";
import { Switch } from "./settings-client";

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
    <Row
      label="Light mode"
      sub={
        <>
          On uses Paper; off uses Ink. Saved for this browser only.
          {err && <span role="alert"> · {err}</span>}
        </>
      }
    >
      <Switch label="Light mode" on={g === "paper"} disabled={false} busy={busy} onClick={() => void flip()} />
    </Row>
  );
}
