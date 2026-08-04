"use client";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Appearance } from "../appearance";
import { Reveal } from "../reveal";
import styles from "../console.module.css";

/**
 * The controls. Reader and guest sections write through /settings/save — the same gated POST
 * the readers screen used, moved one segment down so this screen could take the path. Every
 * write re-renders from the server: the screen's job is to show what the read path will
 * actually do, and only the server knows that. A refused write is shown verbatim.
 */

export interface SettingsVM {
  writable: boolean;
  storeState: "store" | "unconfigured" | "unreachable";
  conflicts: string[];
  readers: Array<{
    model: string;
    provider: string;
    configured: boolean;
    disabled: boolean;
    evalState: "measured" | "unstable" | "unmeasured";
    isDefault: boolean;
    defaultSource: string | null;
  }>;
  providers: Array<{
    provider: string;
    keyEnv: string;
    configured: boolean;
    disabled: boolean;
    holdsDefault: boolean;
  }>;
  guest: {
    open: boolean;
    kvReady: boolean;
    scope: string[];
    citations: boolean;
    dailyAsks: number;
    maxK: number;
    usedToday: number | null;
    queued: number;
  };
}

const AREAS = [
  { path: "projects/", note: "project pages" },
  { path: "notes/", note: "reference notes" },
  { path: "archive/", note: "old material" },
  { path: "log/", note: "daily logs" },
  { path: "profile.md", note: "who you are" },
];

function saveUrl(): string {
  const p = window.location.pathname.replace(/\/+$/, "");
  return `${p.replace(/\/settings$/, "")}/settings/save`;
}

export function SettingsClient({ vm }: { vm: SettingsVM }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const working = pending || busy !== null;

  async function send(patch: Record<string, unknown>, tag: string) {
    setBusy(tag);
    setError(null);
    try {
      const res = await fetch(saveUrl(), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(patch),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: string } | null;
        setError(body?.error ?? `the write was refused (${res.status})`);
        return;
      }
      start(() => router.refresh());
    } catch {
      setError("the write did not reach the server");
    } finally {
      setBusy(null);
    }
  }

  /** −/+ stepper for the two guest numbers — the controls the audit flagged as promised by the
   *  README and absent from every screen. Bounds mirror the server's; the server still rules. */
  function step(field: "dailyAsks" | "maxK", value: number, delta: number, min: number, max: number) {
    const next = Math.min(max, Math.max(min, value + delta));
    if (next !== value) send({ guest: { [field]: next } }, `${field}:${delta}`);
  }

  const g = vm.guest;
  const disabledAll = !vm.writable || working;

  return (
    <>
      {error && <div className={styles.refused}>{error}</div>}
      {vm.conflicts.map((c) => (
        <div key={c} className={styles.refused}>{c}</div>
      ))}
      {!vm.writable && (
        <div className={styles.refused}>
          {vm.storeState === "unconfigured"
            ? "No KV store is configured — these controls have nowhere durable to write. The deployment runs on env defaults; the Deployment section below shows them."
            : "The settings store was unreachable this render — controls are held, env defaults are in force."}
        </div>
      )}

      <div className={styles.setGrid}>
        <section>
          <div className={styles.label}>Reader</div>
          <div className={styles.note}>who answers brain_ask — guests always get a Claude reader</div>
          <div className={styles.gScope}>
            {vm.readers.map((r) => {
              const off = r.disabled || !r.configured;
              return (
                <button
                  key={r.model}
                  type="button"
                  className={`${styles.gArea}${r.isDefault ? " " + styles.gOn : ""}`}
                  disabled={disabledAll || off || r.isDefault}
                  aria-pressed={r.isDefault}
                  title={
                    r.isDefault
                      ? `reading now (${r.defaultSource})`
                      : !r.configured
                        ? `${r.provider} has no key`
                        : r.disabled
                          ? `${r.provider} is off`
                          : `${r.evalState === "measured" ? "measured on the eval" : r.evalState} — make default`
                  }
                  onClick={() => send({ defaultReader: r.model }, r.model)}
                >
                  {busy === r.model ? "…" : r.model}
                </button>
              );
            })}
          </div>
          <div className={styles.setRows}>
            {vm.providers.map((p) => (
              <div key={p.provider} className={styles.gRow}>
                <span className={styles.note}>
                  {p.provider} · {p.configured ? "key set" : `${p.keyEnv} missing`}
                </span>
                <button
                  type="button"
                  className={`${styles.pvBtn}${p.disabled ? "" : " " + styles.pvOn}`}
                  disabled={disabledAll || p.holdsDefault}
                  aria-pressed={!p.disabled}
                  title={p.holdsDefault ? "serves the current default — change the default first" : undefined}
                  onClick={() =>
                    send(
                      {
                        disabledProviders: p.disabled
                          ? vm.providers.filter((x) => x.disabled && x.provider !== p.provider).map((x) => x.provider)
                          : [...vm.providers.filter((x) => x.disabled).map((x) => x.provider), p.provider],
                      },
                      p.provider
                    )
                  }
                >
                  {busy === p.provider ? "…" : p.disabled ? "off" : "on"}
                </button>
              </div>
            ))}
          </div>
          <Reveal label="how the reader is chosen">
            Per call, the caller&rsquo;s own model argument wins; then this default; then
            READER_MODEL; then the built-in. Switches govern selection, never keys, and the last
            resort ignores them — no combination can leave brain_ask with nothing to call.
          </Reveal>
        </section>

        <section>
          <div className={styles.label}>
            Guest {g.open ? (g.kvReady ? "· door open" : "· secret set, KV missing — cannot serve") : "· door closed"}
          </div>
          <div className={styles.note}>
            {g.open
              ? `${g.usedToday ?? "—"} / ${g.dailyAsks} asks today · ${g.queued} proposal${g.queued === 1 ? "" : "s"} waiting`
              : "set GUEST_PATH_SECRET to open it — nothing on this section applies until then"}
          </div>
          <div className={styles.gScope}>
            {AREAS.map((a) => {
              const on = g.scope.includes(a.path);
              return (
                <button
                  key={a.path}
                  type="button"
                  className={`${styles.gArea}${on ? " " + styles.gOn : ""}`}
                  disabled={disabledAll}
                  aria-pressed={on}
                  title={on ? `stop sharing ${a.path}` : `share ${a.path} — ${a.note}`}
                  onClick={() =>
                    send(
                      { guest: { scope: on ? g.scope.filter((s) => s !== a.path) : [...g.scope, a.path] } },
                      `scope:${a.path}`
                    )
                  }
                >
                  {busy === `scope:${a.path}` ? "…" : a.path}
                </button>
              );
            })}
          </div>
          <div className={styles.setRows}>
            <div className={styles.gRow}>
              <span className={styles.note}>show source and evidence</span>
              <button
                type="button"
                className={`${styles.pvBtn}${g.citations ? " " + styles.pvOn : ""}`}
                disabled={disabledAll}
                aria-pressed={g.citations}
                onClick={() => send({ guest: { citations: !g.citations } }, "citations")}
              >
                {busy === "citations" ? "…" : g.citations ? "on" : "off"}
              </button>
            </div>
            <div className={styles.gRow}>
              <span className={styles.note}>asks per day</span>
              <span className={styles.stepper}>
                <button type="button" className={styles.rdBtn} disabled={disabledAll} onClick={() => step("dailyAsks", g.dailyAsks, -10, 10, 1000)}>−</button>
                <span className={styles.fig}>{g.dailyAsks}</span>
                <button type="button" className={styles.rdBtn} disabled={disabledAll} onClick={() => step("dailyAsks", g.dailyAsks, 10, 10, 1000)}>+</button>
              </span>
            </div>
            <div className={styles.gRow}>
              <span className={styles.note}>notes per ask (max k)</span>
              <span className={styles.stepper}>
                <button type="button" className={styles.rdBtn} disabled={disabledAll} onClick={() => step("maxK", g.maxK, -1, 1, 40)}>−</button>
                <span className={styles.fig}>{g.maxK}</span>
                <button type="button" className={styles.rdBtn} disabled={disabledAll} onClick={() => step("maxK", g.maxK, 1, 1, 40)}>+</button>
              </span>
            </div>
          </div>
          <Reveal label="how scope is enforced">
            Out-of-scope notes are removed from the corpus before the reader runs — an unticked
            area cannot be quoted, summarised or talked around. Budgets reset at 00:00 UTC, and
            every default fails closed.
          </Reveal>
        </section>

        <section>
          <div className={styles.label}>Appearance</div>
          <div className={styles.note}>this browser only — stored locally, never on the server</div>
          <div className={styles.setRows}>
            <div className={styles.gRow}>
              <Appearance />
            </div>
          </div>
        </section>
      </div>
    </>
  );
}
