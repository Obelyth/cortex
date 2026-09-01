"use client";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Reveal } from "../reveal";
import { ModelSelect } from "../overview/model-select";
import { settingsEndpoint } from "./endpoints";
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

/** Exported for the Learning section's client, which shares the row vocabulary — a settings
 *  screen that invents a second switch is two switches to keep honest. */
export function ToggleRow({
  label,
  sub,
  on,
  disabled,
  locked,
  busy,
  title,
  onClick,
}: Readonly<{
  label: string;
  sub?: string;
  on: boolean;
  disabled: boolean;
  locked?: boolean;
  busy: boolean;
  title?: string;
  onClick: () => void;
}>) {
  return (
    <div className="setRow">
      <span className="setBody">
        <span className="setTitle">{label}</span>
        {sub && <span className="setSub">{sub}</span>}
      </span>
      {/* A locked switch says LOCKED. Dimming an on-switch to 40% produced a third state that
          read as neither on nor off — the provider serving the current default looked half-on
          beside two full ones, and no reader could tell "held" from "partly enabled". */}
      {locked && <span className="setLock">locked · serves the default</span>}
      <button
        type="button"
        role="switch"
        className={`swt${locked ? " swtLocked" : ""}`}
        disabled={disabled || busy}
        aria-checked={on}
        aria-label={label}
        title={title}
        onClick={onClick}
      />
    </div>
  );
}

/** Exported for the Learning section's client, same reason as ToggleRow. `display` overrides
 *  the rendered figure when the stored unit is not the readable one (bytes shown as KB). */
export function StepperRow({
  label,
  sub,
  value,
  display,
  disabled,
  onStep,
}: Readonly<{
  label: string;
  sub?: string;
  value: number;
  display?: string;
  disabled: boolean;
  onStep: (delta: number) => void;
}>) {
  return (
    <div className="setRow">
      <span className="setBody">
        <span className="setTitle">{label}</span>
        {sub && <span className="setSub">{sub}</span>}
      </span>
      {/* Both buttons announced as bare "minus"/"plus" with no aria-label, so two steppers gave
          a screen reader four identical controls with no way to tell which number they moved. */}
      <span className={styles.stepper}>
        <button type="button" className={styles.rdBtn} disabled={disabled}
          aria-label={`decrease ${label}`} onClick={() => onStep(-1)}>−</button>
        <span className={styles.fig}>{display ?? value}</span>
        <button type="button" className={styles.rdBtn} disabled={disabled}
          aria-label={`increase ${label}`} onClick={() => onStep(1)}>+</button>
      </span>
    </div>
  );
}

function guestHeading(g: SettingsVM["guest"]): string {
  if (!g.open) return "Guest · door closed";
  if (!g.kvReady) return "Guest · secret set, KV missing — cannot serve";
  return "Guest · door open";
}

export function SettingsClient({
  vm,
  modelOptions,
  activeModel,
}: Readonly<{
  vm: SettingsVM;
  modelOptions: { model: string; configured: boolean }[];
  activeModel: string;
}>) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const working = pending || busy !== null;

  async function send(patch: Record<string, unknown>, tag: string) {
    setBusy(tag);
    setError(null);
    try {
      const res = await fetch(settingsEndpoint("save"), {
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
        <section className="card">
          {/* Section header carries the one fact the reader needs, right-aligned and quiet.
              The paragraph of prose that used to sit between this heading and the first control
              is in the disclosure at the foot — a settings screen is a list of controls, and
              explanation that outranks the control it explains is a manual, not a setting. */}
          {/* Reader, not "Providers". Picking the answering model and deciding which providers
              may be picked FROM are one decision, and they used to sit in two cards on opposite
              sides of a grid — the switch that governs selection nowhere near the select it
              governs. */}
          <div className="setHead">
            <span className={styles.label}>Reader</span>
            <span className="setHeadMeta">what answers · selection only, never keys</span>
          </div>
          <div className="setRow">
            <span className="setBody">
              <span className="setTitle">answering model</span>
              <span className="setSub">plain reads never touch a model</span>
            </span>
            <ModelSelect options={modelOptions} current={activeModel} writable={vm.writable} />
          </div>
          <div className={styles.setRows}>
            {vm.providers.map((p) => (
              <ToggleRow
                key={p.provider}
                label={p.provider}
                sub={p.configured ? "key set" : `${p.keyEnv} missing`}
                on={!p.disabled}
                locked={p.holdsDefault}
                disabled={disabledAll || p.holdsDefault}
                busy={busy === p.provider}
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
              />
            ))}
          </div>
          <Reveal label="how the reader is chosen">
            Per call, the caller&rsquo;s own model argument wins; then the default set on the
            Models list; then READER_MODEL; then the built-in. Switches govern selection, never
            keys, and the last resort ignores them — no combination can leave brain_ask with
            nothing to call. Guests always get a Claude reader.
          </Reveal>
        </section>

        <section className="card">
          <div className="setHead">
            <span className={styles.label}>{guestHeading(g)}</span>
            <span className="setHeadMeta">
              {g.open
                ? `${g.usedToday ?? "—"}/${g.dailyAsks} asks today · ${g.queued} waiting`
                : "set GUEST_PATH_SECRET to open"}
            </span>
          </div>
          {/* Every control below was previously live and clickable while the door was shut, under
              a heading that said nothing here applies — nine interactive controls that did
              nothing. Closed is now genuinely disabled, which is what the heading already
              claimed. */}
          <div className="setRow setRowStack">
            <span className="setBody">
              <span className="setTitle">shared areas</span>
              <span className="setSub">out-of-scope notes never enter the pack the reader sees</span>
            </span>
            <span className={styles.gScope}>
              {AREAS.map((a) => {
                const on = g.scope.includes(a.path);
                return (
                  <button
                    key={a.path}
                    type="button"
                    className={`${styles.gArea}${on ? " " + styles.gOn : ""}`}
                    disabled={disabledAll || !g.open}
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
            </span>
          </div>
          <div className={styles.setRows}>
            <ToggleRow
              label="show sources with answers"
              sub="citations reveal note paths and verbatim text"
              on={g.citations}
              disabled={disabledAll || !g.open}
              busy={busy === "citations"}
              onClick={() => send({ guest: { citations: !g.citations } }, "citations")}
            />
            <StepperRow label="asks per day" value={g.dailyAsks} disabled={disabledAll || !g.open}
              onStep={(d) => step("dailyAsks", g.dailyAsks, d * 10, 10, 1000)} />
            <StepperRow label="notes per ask (max k)" value={g.maxK} disabled={disabledAll || !g.open}
              onStep={(d) => step("maxK", g.maxK, d, 1, 40)} />
          </div>
          <Reveal label="how scope is enforced">
            Out-of-scope notes are removed from the corpus before the reader runs — an unticked
            area cannot be quoted, summarised or talked around. Budgets reset at 00:00 UTC, and
            every default fails closed.
          </Reveal>
        </section>

        {/* The Appearance card is gone with the light/dark toggle. The console has one ground,
            so there is nothing to choose, and this card was spending a third of a 3-up grid row
            on two buttons. */}
      </div>
    </>
  );
}
