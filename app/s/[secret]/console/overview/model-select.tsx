"use client";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";

/**
 * The design's ANSWERING MODEL control, on the overview where the file puts it. A native
 * <select> in an ink well — the design uses the platform control, so this does too. Keyless
 * models stay listed the way the design lists them ("· no key"), but cannot be picked: a menu
 * that lets you choose a reader that will error is a trap, not a control. Writes ride the same
 * gated /settings/save endpoint as every other control; the URL is derived from the address bar
 * so the secret never enters markup.
 */
export function ModelSelect({
  options,
  current,
  writable,
}: Readonly<{
  options: Array<{ model: string; configured: boolean }>;
  current: string;
  writable: boolean;
}>) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [busy, setBusy] = useState(false);

  async function pick(model: string) {
    if (model === current) return;
    setBusy(true);
    try {
      let p = window.location.pathname;
      while (p.endsWith("/")) p = p.slice(0, -1);
      p = p.replace(/\/(overview|settings)$/, "");
      const res = await fetch(`${p}/settings/save`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ defaultReader: model }),
      });
      if (res.ok) start(() => router.refresh());
    } finally {
      setBusy(false);
    }
  }

  return (
    <select
      className="modelSelect"
      value={current}
      disabled={!writable || busy || pending}
      aria-label="Answering model"
      title={writable ? "which model answers brain_ask" : "no settings store — set READER_MODEL in the environment"}
      onChange={(e) => void pick(e.target.value)}
    >
      {current === "" && <option value="">UNRESOLVED</option>}
      {options.map((o) => (
        <option key={o.model} value={o.model} disabled={!o.configured}>
          {o.model.toUpperCase()}
          {o.configured ? "" : " · NO KEY"}
        </option>
      ))}
    </select>
  );
}
