"use client";
import { createContext, useContext, useState, useTransition, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { settingsEndpoint } from "./endpoints";
import { Row, Val } from "./rows";
import { performSettingsWrite } from "./write-lifecycle";

/**
 * The controls (v2). Every write on this screen rides one channel — SettingsWrites — so the
 * band can carry one saved line ("nothing written this session", then "wrote guest.scope ·
 * 12:04:11 utc") and one refused line, whichever group the click came from. The caller names
 * the endpoint (settingsEndpoint, derived from the address bar so the secret never enters
 * markup); the channel owns the receipt. Every accepted write re-renders from the server: the
 * screen's job is to show what the read path will actually do, and only the server knows that.
 * A refused write is shown verbatim.
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
    /** How many allowlisted models the provider serves — the sub says "N models". */
    models: number;
  }>;
  guest: {
    open: boolean;
    /** Safe prerequisite names only. Optional for legacy static fixtures. */
    missing?: string[];
    /** This family's own authoritative read state; never inferred from reader settings. */
    storeState?: "store" | "unconfigured" | "unreachable";
    /** Legacy fixture field. Runtime code supplies storeState. */
    kvReady?: boolean;
    scope: string[];
    revision?:string|null;
    citations: boolean;
    dailyAsks: number;
    maxK: number;
    usedToday: number | null;
    queued: number;
  };
}

/** The areas a guest may be given. `archive/` is not here: corpus.ts excludes the whole prefix
 *  from the reader corpus, so lib/guest refuses it as a scope entry (a guest ticking it got NOT
 *  IN BRAIN on every question). `history/` is the older material a guest may actually reach. */
const AREAS = [
  { path: "projects/", note: "project pages" },
  { path: "notes/", note: "reference notes" },
  { path: "log/", note: "daily logs" },
  { path: "history/", note: "older material" },
];

export function withoutGuestGrant(scope: readonly string[], path: string): string[] {
  return scope.filter((entry) => entry !== path);
}

/** Every exact path stays visible by name; profile.md also remains available as an opt-in. */
export function ExactGuestGrants({
  scope,
  disabled,
  onChange,
}: Readonly<{
  scope: readonly string[];
  disabled: boolean;
  onChange: (scope: string[]) => void;
}>) {
  const rootAreas = new Set(AREAS.map((area) => area.path));
  // Root areas have their permanent chips above. Everything else — exact notes and valid
  // nested folders already in policy — must stay named and removable.
  const named = [...new Set(scope.filter((entry) => !rootAreas.has(entry)))];
  const paths = named.includes("profile.md") ? named : ["profile.md", ...named];
  return (
    <span className="setChips">
      {paths.map((path) => {
        const on = named.includes(path);
        const kind = path.endsWith("/") ? "nested-folder" : "exact-note";
        return (
          <button
            key={path}
            type="button"
            className="setChip"
            aria-pressed={on}
            aria-label={on ? `remove ${kind} grant ${path}` : `share exact note ${path}`}
            disabled={disabled}
            title={on ? `remove ${kind} grant ${path}` : `share ${path}`}
            onClick={() => onChange(on ? withoutGuestGrant(scope, path) : [...scope, path])}
          >
            {path}
          </button>
        );
      })}
    </span>
  );
}

/* ── The write channel ──────────────────────────────────────────────────── */

export type WriteResult = { ok: true; json: Record<string, unknown> } | { ok: false; error: string;json?:Record<string,unknown> };

interface WriteApi {
  /** The tag in flight, or null. Every control holds while any write is in flight. */
  busy: string | null;
  working: boolean;
  error: string | null;
  saved: string;
  post: (
    url: string,
    body: Record<string, unknown>,
    tag: string,
    said?: (json: Record<string, unknown>) => string
  ) => Promise<WriteResult>;
}

const WriteContext = createContext<WriteApi | null>(null);

export function SettingsWrites({ children }: Readonly<{ children: ReactNode }>) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState("nothing written this session");

  async function post(
    url: string,
    body: Record<string, unknown>,
    tag: string,
    said?: (json: Record<string, unknown>) => string
  ): Promise<WriteResult> {
    setBusy(tag);
    setError(null);
    try {
      if (url.endsWith("/save")) {
        const outcome = await performSettingsWrite(url, body);
        if (outcome.status !== "confirmed") {
          setError(outcome.error);
          if (outcome.status !== "refused") start(() => router.refresh());
          return { ok: false, error: outcome.error,...(outcome.status==="conflict"?{json:outcome.json}:{}) };
        }
        const at = new Date().toISOString().slice(11, 19);
        setSaved(`${said ? said(outcome.json) : `wrote ${tag}`} · ${at} utc`);
        start(() => router.refresh());
        return { ok: true, json: outcome.json };
      }

      const res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      const json = (await res.json().catch(() => null)) as Record<string, unknown> | null;
      if (!res.ok) {
        const e = (json?.error as string | undefined) ?? `the write was refused (${res.status})`;
        setError(e);
        return { ok: false, error: e };
      }
      if (!json || json.ok !== true) {
        const e = "action completion unconfirmed — refresh before trying it again";
        setError(e);
        start(() => router.refresh());
        return { ok: false, error: e };
      }
      const at = new Date().toISOString().slice(11, 19);
      setSaved(`${said ? said(json) : `wrote ${tag}`} · ${at} utc`);
      start(() => router.refresh());
      return { ok: true, json };
    } catch {
      const e = "action completion unconfirmed — refresh before trying it again";
      setError(e);
      return { ok: false, error: e };
    } finally {
      setBusy(null);
    }
  }

  return (
    <WriteContext.Provider value={{ busy, working: pending || busy !== null, error, saved, post }}>
      {children}
    </WriteContext.Provider>
  );
}

export function useWrites(): WriteApi {
  const api = useContext(WriteContext);
  if (!api) throw new Error("useWrites must be used inside SettingsWrites");
  return api;
}

/** The band's receipt: what was written last, or that nothing was. */
export function SavedLine() {
  const w = useWrites();
  return <span className="setSaved" aria-live="polite">{w.saved}</span>;
}

/** A refused write, verbatim, at the top of the sheet. */
export function RefusedLine() {
  const w = useWrites();
  return w.error ? <div className="setRefused" role="alert">{w.error}</div> : null;
}

/** A panel whose store is down says so at the top of its rows, and holds. */
export function HeldLine({ children }: Readonly<{ children: ReactNode }>) {
  return <div className="setHeld">{children}</div>;
}

/* ── The controls ───────────────────────────────────────────────────────── */

/** The switch: a pill on a trough, a lit knob. A locked switch says LOCKED in words — dimming
 *  it produced a third state that read as neither on nor off. Exported for every group. */
export function Switch({
  label,
  on,
  disabled,
  locked,
  busy,
  title,
  onClick,
}: Readonly<{
  label: string;
  on: boolean;
  disabled: boolean;
  locked?: boolean;
  busy?: boolean;
  title?: string;
  onClick: () => void;
}>) {
  return (
    <span className="setCtl">
      {locked && <span className="setLock">locked · serves the default</span>}
      <button
        type="button"
        role="switch"
        className="setSwt"
        aria-checked={on}
        aria-label={label}
        aria-busy={busy || undefined}
        disabled={disabled || locked || busy}
        title={title}
        onClick={onClick}
      >
        <i className="setKnob" aria-hidden />
      </button>
    </span>
  );
}

/** The stepper: a raised bezel around a tabular figure. `display` overrides the rendered figure
 *  when the stored unit is not the readable one (bytes shown as KB). Both buttons are named
 *  after the number they move, so two steppers are not four identical controls to a reader. */
export function Stepper({
  label,
  value,
  display,
  disabled,
  onStep,
}: Readonly<{
  label: string;
  value: number;
  display?: string;
  disabled: boolean;
  onStep: (delta: number) => void;
}>) {
  return (
    <span className="setStep" aria-disabled={disabled || undefined}>
      <button type="button" className="setStepBtn" disabled={disabled} aria-label={`decrease ${label}`} onClick={() => onStep(-1)}>−</button>
      <span className="setStepVal">{display ?? value}</span>
      <button type="button" className="setStepBtn" disabled={disabled} aria-label={`increase ${label}`} onClick={() => onStep(1)}>+</button>
    </span>
  );
}

const clamp = (v: number, min: number, max: number) => Math.min(max, Math.max(min, v));

/* ── Reader: the select and the provider switches ────────────────────────── */

export function ReaderRows({
  vm,
  modelOptions,
  activeModel,
}: Readonly<{
  vm: SettingsVM;
  modelOptions: { model: string; configured: boolean }[];
  activeModel: string;
}>) {
  const w = useWrites();
  const disabledAll = !vm.writable || w.working;
  const send = (patch: Record<string, unknown>, tag: string) => w.post(settingsEndpoint("save"), patch, tag);
  // READER_MODEL ignores the switches, so the active model can sit outside the selectable set;
  // it is listed, held, rather than silently swapped for the first option.
  const listed = modelOptions.some((o) => o.model === activeModel);

  return (
    <>
      {!vm.writable && (
        <HeldLine>
          {vm.storeState === "unconfigured"
            ? "Preference store not connected — these controls have nowhere durable to write. Deployment defaults are in use."
            : "The preference store was unreachable this render. Saving is paused; deployment defaults are in use."}
        </HeldLine>
      )}
      <Row label="Answering model" sub="plain reads never touch a model · guests always get a Claude reader">
        <select
          className="setSelect"
          value={activeModel}
          disabled={disabledAll}
          aria-label="Answering model"
          title={vm.writable ? "Which model answers trusted questions" : "Preference saving is unavailable — check the Cache service in Services & deployment"}
          onChange={(e) => void send({ defaultReader: e.target.value }, "defaultReader")}
        >
          {activeModel === "" && <option value="">unresolved</option>}
          {activeModel !== "" && !listed && <option value={activeModel} disabled>{activeModel} · from env</option>}
          {modelOptions.map((o) => (
            <option key={o.model} value={o.model} disabled={!o.configured}>
              {o.model}
              {o.configured ? "" : " · no key"}
            </option>
          ))}
        </select>
      </Row>
      {vm.providers.map((p) => (
        <Row
          key={p.provider}
          label={p.provider}
          sub={p.configured ? `${p.keyEnv} present · ${p.models} model${p.models === 1 ? "" : "s"} · presence is not an API test` : `${p.keyEnv} missing — add this provider’s key in Services & deployment before using it`}
        >
          <Switch
            label={p.provider}
            on={!p.disabled}
            locked={p.holdsDefault}
            disabled={disabledAll}
            busy={w.busy === p.provider}
            title={p.holdsDefault ? "serves the current default — change the default first" : undefined}
            onClick={() =>
              void send(
                {
                  disabledProviders: p.disabled
                    ? vm.providers.filter((x) => x.disabled && x.provider !== p.provider).map((x) => x.provider)
                    : [...vm.providers.filter((x) => x.disabled).map((x) => x.provider), p.provider],
                },
                p.provider
              )
            }
          />
        </Row>
      ))}
    </>
  );
}

/* ── Guest door ──────────────────────────────────────────────────────────── */

export function GuestRows({
  g:incoming,
  storeState: legacyStoreState,
}: Readonly<{
  g: SettingsVM["guest"];
  /** Retained only for old static fixtures; production supplies g.storeState. */
  writable?: boolean;
  storeState?: SettingsVM["storeState"];
}>) {
  const w = useWrites();
  const [readback,setReadback]=useState<{base:SettingsVM["guest"];current:SettingsVM["guest"]}|null>(null);
  const g=readback?.base===incoming?readback.current:incoming;
  const [hit, setHit] = useState<string | null>(null);
  const missing = g.missing ?? (g.open ? [] : ["GUEST_PATH_SECRET"]);
  const guestStoreState = g.storeState ?? (g.kvReady ? "store" : legacyStoreState ?? "unconfigured");
  const writable = guestStoreState === "store";
  const disabledAll = !writable || w.working;
  // Every control below the door row was once live while the door was shut — nine controls that
  // did nothing under a heading that said so. Closed is genuinely held.
  const held = disabledAll || !g.open;
  const send = async(patch: Record<string, unknown>, tag: string) => {
    const result=await w.post(settingsEndpoint("save"), { guest:{...patch,expectedRevision:g.revision} }, tag);
    const current=result.ok?result.json.guest:result.json?.current;
    if(current&&typeof current==="object")setReadback({base:incoming,current:{...incoming,...current}});
    return result;
  };
  function step(field: "dailyAsks" | "maxK", value: number, delta: number, min: number, max: number) {
    const next = clamp(value + delta, min, max);
    if (next !== value) void send({ [field]: next }, `guest.${field}`);
  }
  const doorSub = missing.length
    ? `missing ${missing.join(" + ")} · guest controls are unavailable until these access credentials are set in your hosting provider’s project settings`
    : guestStoreState === "unconfigured"
      ? "path prerequisites set · guest policy store is not configured — the door cannot serve · controls below are held"
      : guestStoreState === "unreachable"
        ? "path prerequisites set · guest policy store did not answer this render — operational state unavailable · controls below are held"
        : `/api/g/<GUEST_PATH_SECRET>/mcp · ${g.usedToday ?? "—"} of ${g.dailyAsks} asks used today · ${g.queued} proposal${g.queued === 1 ? "" : "s"} waiting`;
  const doorLabel = g.open ? "Door open" : guestStoreState === "unreachable" && missing.length === 0 ? "Door unavailable" : "Door closed";

  return (
    <>
      {!writable && (
        <HeldLine>
          {guestStoreState === "unconfigured"
            ? "Guest policy store not connected — these controls have nowhere durable to write. Guest access stays closed."
            : "the guest policy store was unreachable this render · controls are held · the operational door state is unavailable"}
        </HeldLine>
      )}
      <Row label={doorLabel} sub={doorSub}>
        <Val tone={g.open ? "on" : "off"}>{g.open ? "open" : doorLabel === "Door unavailable" ? "unavailable" : "closed"}</Val>
      </Row>
      <Row label="Shared areas" sub="Only shared notes are sent to the guest reader. Sharing a folder includes its notes and subfolders.">
        <span className="setChips">
          {AREAS.map((a) => {
            const on = g.scope.includes(a.path);
            return (
              <button
                key={a.path}
                type="button"
                className="setChip"
                aria-pressed={on}
                disabled={held}
                title={on ? `stop sharing ${a.path}` : `share ${a.path} — ${a.note}`}
                onClick={async () => {
                  setHit(a.path);
                  await send({ scope: on ? withoutGuestGrant(g.scope, a.path) : [...g.scope, a.path] }, "guest.scope");
                  setHit(null);
                }}
              >
                {hit === a.path ? "…" : a.path}
              </button>
            );
          })}
        </span>
      </Row>
      <Row label="Named grants" sub="exact notes and existing nested folders shared in addition to the root areas above · remove one without changing the rest">
        <ExactGuestGrants
          scope={g.scope}
          disabled={held}
          onChange={(scope) => void send({ scope }, "guest.scope")}
        />
      </Row>
      <Row label="Show sources with answers" sub="citations reveal note paths and verbatim text · default off">
        <Switch
          label="Show sources with answers"
          on={g.citations}
          disabled={held}
          busy={w.busy === "guest.citations"}
          onClick={() => void send({ citations: !g.citations }, "guest.citations")}
        />
      </Row>
      <Row label="Asks per day" sub="A shared daily limit on uncached guest asks. Cached answers do not count. Resets at 00:00 UTC.">
        <Stepper label="asks per day" value={g.dailyAsks} disabled={held} onStep={(d) => step("dailyAsks", g.dailyAsks, d * 10, 10, 1000)} />
      </Row>
      <Row label="Maximum notes per guest answer" sub="Limits how many shared notes the reader can use for one answer. Guests cannot request the full corpus.">
        <Stepper label="notes per ask" value={g.maxK} disabled={held} onStep={(d) => step("maxK", g.maxK, d, 1, 40)} />
      </Row>
    </>
  );
}
