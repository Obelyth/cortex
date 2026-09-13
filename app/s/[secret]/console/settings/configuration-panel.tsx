"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import {
  CONFIGURATION_GROUPS,
  configurationAcknowledgementSchema,
  configurationErrorResponseSchema,
  configurationSaveResponseSchema,
  configurationStatusResponseSchema,
  newConfigurationRequestKey,
  type ConfigurationAdapterStatus,
  type ConfigurationCapability,
  type ConfigurationRecord,
  type ConfigurationResult,
  type ConfigurationTarget,
} from "@/lib/console-configuration-contract";
import { useLens } from "../lens";
import { consoleRoutePath } from "../route-path";
import { settingsEndpoint } from "./endpoints";

const SAVE_DEADLINE_MS = 45_000;
const STATUS_DEADLINE_MS = 10_000;

const fields: Record<string, { label: string; kind: "Secret" | "Config"; help: string }> = {
  BRAIN_REPO: { label: "Notes repository", kind: "Config", help: "Use owner/repository, for example your-name/brain." },
  GITHUB_TOKEN: { label: "GitHub access token", kind: "Secret", help: "Paste the token value with access to the notes repository." },
  ANTHROPIC_API_KEY: { label: "Anthropic API key", kind: "Secret", help: "Paste the API key value from Anthropic." },
  OPENAI_API_KEY: { label: "OpenAI API key", kind: "Secret", help: "Paste the API key value from OpenAI." },
  GEMINI_API_KEY: { label: "Google AI API key", kind: "Secret", help: "Paste the API key value from Google AI Studio." },
  SUPABASE_URL: { label: "Supabase project URL", kind: "Config", help: "Paste the HTTPS project URL from Supabase project settings." },
  SUPABASE_SERVICE_ROLE_KEY: { label: "Supabase service role key", kind: "Secret", help: "Paste the service role key value for the same project." },
  KV_REST_API_URL: { label: "Upstash REST URL", kind: "Config", help: "Paste the HTTPS REST endpoint from the Upstash database." },
  KV_REST_API_TOKEN: { label: "Upstash REST token", kind: "Secret", help: "Paste the REST token value for the same database." },
  RESEND_API_KEY: { label: "Resend API key", kind: "Secret", help: "Paste the API key value. If an integration created CORTEX_RESEND_API_KEY, also supply the required RESEND_API_KEY here." },
  OPS_ALERT_TO: { label: "Alert recipient email", kind: "Config", help: "Enter the address that should receive alerts. Resend Contacts do not set this value." },
  OPS_ALERT_FROM: { label: "Alert sender email", kind: "Config", help: "Enter a sender address or Cortex <alerts@example.com>. Use the exact name OPS_ALERT_FROM when setting it in Vercel." },
};

type ConfigurationPresence = Record<ConfigurationCapability, { configured: boolean; missing: string[] }>;
type ConfigurationEvidence = Record<ConfigurationCapability, { state: "observed" | "unavailable" | "unknown"; detail: string }>;
export interface ConfigurationView {
  adapter: ConfigurationAdapterStatus;
  store: "ready" | "unconfigured" | "schema-required" | "unavailable";
  records: ConfigurationRecord[];
  presence: ConfigurationPresence;
  evidence: ConfigurationEvidence;
  ingressReady: boolean;
}

type Draft = Record<string, string>;
// This gives local feedback only. The server independently validates every save.
function configurationFieldErrors(capability: ConfigurationCapability, draft: Draft): Record<string, string> {
  const errors: Record<string, string> = {};
  for (const name of CONFIGURATION_GROUPS[capability].variables) {
    const value = draft[name] ?? "";
    let reason: string | null = null;
    if (!value.trim()) reason = "is required for this save.";
    else if (/[\u0000-\u001f\u007f]/.test(value)) reason = "must use a single line without control characters.";
    else if (new TextEncoder().encode(value).length > 8_192) reason = "exceeds the 8,192-byte limit.";
    else if (name === "BRAIN_REPO" && !/^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/.test(value)) reason = "must use owner/repository.";
    else if (name === "SUPABASE_URL" || name === "KV_REST_API_URL") {
      try {
        const url = new URL(value);
        if (url.protocol !== "https:" || url.username || url.password || url.hash) reason = "must be an HTTPS URL without embedded credentials or a fragment.";
      } catch { reason = "must be an HTTPS URL without embedded credentials or a fragment."; }
    } else if (name === "OPS_ALERT_TO" && (value.length > 320 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value))) reason = "must be one recipient email address.";
    else if (name === "OPS_ALERT_FROM" && (value.length > 320 || !/^(?:[^<>\r\n]{1,200}\s<)?([^<>\s@]+@[^<>\s@]+\.[^<>\s@]+)>?$/.test(value))) reason = "must be a sender email address or Name <email@example.com>.";
    if (reason) errors[name] = `${name} ${reason}`;
  }
  return errors;
}

export interface PendingConfigurationAttempt { requestKey: string; expectedRevision: number; values: Draft | null }
export function draftAfterConfiguration(draft: Draft, result: ConfigurationResult): Draft {
  if (result.state === "uncertain") return draft;
  const accepted = new Set(result.accepted);
  return Object.fromEntries(Object.entries(draft).map(([name, value]) => [name, accepted.has(name) ? "" : value]));
}

export function configurationSettlement(draft: Draft, record: ConfigurationRecord): { draft: Draft; releaseRequestKey: boolean; message: string } {
  if (record.status === "running" || !record.result) return {
    draft,
    releaseRequestKey: false,
    message: "The save was accepted but has not finished — no provider write is confirmed, and it will not resend on its own. Press Refresh save receipt with this same request.",
  };
  if (record.result.state === "uncertain") return {
    draft,
    releaseRequestKey: false,
    message: "Outcome uncertain · no confirmed result came back. It will not resend on its own. Press Refresh save receipt with this same request before saving again.",
  };
  return {
    draft: draftAfterConfiguration(draft, record.result),
    releaseRequestKey: true,
    message: record.result.state === "partial"
      ? "Partially saved. Accepted fields were cleared; failed fields remain. Deployment was not started."
      : "Saved to the provider environment. Deployment is still pending and was not started.",
  };
}

export function draftAfterRecoveredAttempt(current: Draft, attempted: Draft | null, result: ConfigurationResult): Draft {
  if (!attempted) return current;
  const unchanged = Object.keys(current).length === Object.keys(attempted).length
    && Object.entries(current).every(([name, value]) => attempted[name] === value);
  return unchanged ? draftAfterConfiguration(current, result) : current;
}

export function configurationAttempt(
  pending: PendingConfigurationAttempt | null,
  draft: Draft,
  expectedRevision: number,
  makeKey: () => string = newConfigurationRequestKey,
): PendingConfigurationAttempt {
  return pending ?? { requestKey: makeKey(), expectedRevision, values: { ...draft } };
}

export function matchingFinishedRecovery(
  draft: Draft,
  pending: PendingConfigurationAttempt,
  record: ConfigurationRecord | null,
): { draft: Draft; pending: null } | null {
  if (!record || record.requestKey !== pending.requestKey || record.status !== "finished" || !record.result) return null;
  return { draft: draftAfterRecoveredAttempt(draft, pending.values, record.result), pending: null };
}

const effectWarning: Partial<Record<ConfigurationCapability, string>> = {
  notes: "Changing the Notes repository does not move existing notes. A later deployment reads the new repository only.",
  mirror: "Changing Mirror points the next deployment at another working-state database. It does not migrate the old database, handoffs, Devices, Ops, or configuration receipts.",
};

const errorCopy: Record<string, string> = {
  invalid: "The complete capability group is required; review every field.",
  adapter_required: "One-time Vercel project-management setup is required in the provider UI.",
  ingress_required: "Secret entry is available only through the supported Vercel-managed HTTPS deployment.",
  key_conflict: "This request identity belongs to different input. Inspect status before starting a fresh request.",
  stale: "The configuration revision changed. Refresh save receipt and review the current receipt.",
  active: "An unresolved write is active. Inspect or explicitly acknowledge it before another save.",
  expired: "The request clock is outside the five-minute window. Review the device clock; use Start fresh request only after review.",
  capacity: "Receipt capacity is held by retained or unresolved writes. Resolve existing work before retrying.",
  schema_required: "Configuration receipts need one-time database setup in the provider UI.",
  unavailable: "Configuration status is unavailable. No provider write was confirmed.",
};

function targetName(adapter: ConfigurationAdapterStatus, target: ConfigurationTarget): string | null {
  if (!adapter.projectId) return null;
  return `vercel:${adapter.projectId}:${adapter.teamId ?? "personal"}:${target}`;
}

function currentRecord(view: ConfigurationView, capability: ConfigurationCapability, target: ConfigurationTarget): ConfigurationRecord | null {
  const full = targetName(view.adapter, target);
  return view.records.find((record) => record.capability === capability && record.target === full) ?? null;
}

export function initialConfigurationTarget(view: ConfigurationView, capability: ConfigurationCapability): ConfigurationTarget {
  const production = currentRecord(view, capability, "production");
  const preview = currentRecord(view, capability, "preview");
  return !production && preview && (preview.status === "running" || preview.status === "uncertain") ? "preview" : "production";
}

function resultWords(record: ConfigurationRecord | null): string {
  if (!record) return "no dashboard save recorded";
  if (record.status === "running") return `write unresolved · revision ${record.revision}`;
  if (record.status === "uncertain") return `${record.acknowledged ? "acknowledged unresolved" : "outcome uncertain"} · revision ${record.revision}`;
  if (record.result?.state === "partial") return `partially saved · activation not verified · revision ${record.revision}`;
  return `saved · activation not verified · revision ${record.revision}`;
}

export function ConfigurationEditor({ capability, initialView }: Readonly<{ capability: ConfigurationCapability; initialView: ConfigurationView }>) {
  const router = useRouter();
  const pathname = usePathname() ?? "";
  const route = consoleRoutePath(pathname);
  const opsHref = `${"../".repeat(Math.max(0, (route?.segments.length ?? 1) - 1))}ops#ops-commands`;
  const names = CONFIGURATION_GROUPS[capability].variables as readonly string[];
  const [target, setTarget] = useState<ConfigurationTarget>(() => initialConfigurationTarget(initialView, capability));
  const [draft, setDraft] = useState<Draft>(() => Object.fromEntries(names.map((name) => [name, ""])));
  const [records, setRecords] = useState(initialView.records);
  const [pending, setPending] = useState<PendingConfigurationAttempt | null>(null);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("");
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [needsFreshKey, setNeedsFreshKey] = useState(false);
  const fullTarget = targetName(initialView.adapter, target);
  const record = records.find((item) => item.capability === capability && item.target === fullTarget) ?? null;
  const canSave = initialView.adapter.configured && initialView.ingressReady && initialView.store === "ready";

  const consumeError = (value: unknown) => {
    const parsed = configurationErrorResponseSchema.safeParse(value);
    const code = parsed.success ? parsed.data.code : "unavailable";
    setNeedsFreshKey(["invalid", "key_conflict", "stale", "expired"].includes(code));
    setStatus(errorCopy[code]);
  };

  const refresh = async () => {
    setBusy(true);
    try {
      const read = async (requestKey?: string) => {
        const query = new URLSearchParams({ capability, target, ...(requestKey ? { requestKey } : {}) });
        const response = await fetch(`${settingsEndpoint("configuration")}?${query}`, { cache: "no-store", signal: AbortSignal.timeout(STATUS_DEADLINE_MS) });
        const value = await response.json().catch(() => null);
        const parsed = configurationStatusResponseSchema.safeParse(value);
        if (!response.ok || !parsed.success || parsed.data.adapter.projectId !== initialView.adapter.projectId || parsed.data.adapter.teamId !== initialView.adapter.teamId) throw value;
        return parsed.data.records;
      };
      const [currentRows, exactRows] = await Promise.all([read(), pending ? read(pending.requestKey) : Promise.resolve([])]);
      const fresh = currentRows.find((item) => item.capability === capability && item.target === fullTarget) ?? null;
      const exact = pending ? exactRows.find((item) => item.requestKey === pending.requestKey && item.capability === capability && item.target === fullTarget) ?? null : null;
      setRecords((current) => [...current.filter((item) => !(item.capability === capability && item.target === fullTarget)), ...(fresh ? [fresh] : [])]);
      const recovered = pending ? matchingFinishedRecovery(draft, pending, exact) : null;
      if (recovered) {
        setDraft(recovered.draft);
        setPending(recovered.pending);
        setNeedsFreshKey(false);
        setStatus("The exact request is recorded as finished. Matching accepted fields were cleared; sensitive values were not read back. Deployment is still pending.");
      } else if (pending && exact?.status === "uncertain" && exact.acknowledged) {
        setPending(null);
        setNeedsFreshKey(false);
        setStatus("The exact request was acknowledged as unresolved. Its values remain unverified and the earlier provider write may still complete; this is not success or cancellation.");
      } else if (pending && !exact) {
        setNeedsFreshKey(true);
        setStatus("No durable receipt was found for the exact request. The current revision was refreshed, but the draft and request identity remain preserved until you explicitly start fresh.");
      } else {
        setStatus("Fresh receipt status loaded. Sensitive values remain non-readable; this does not verify their content.");
      }
    } catch (value) { consumeError(value); }
    finally { setBusy(false); }
  };

  const save = async (event: FormEvent) => {
    event.preventDefault();
    if (!canSave || busy) return;
    // A retry resends its immutable attempt, even when the visible draft has changed.
    if (!pending) {
      const errors = configurationFieldErrors(capability, draft);
      setFieldErrors(errors);
      const firstInvalid = names.find((name) => errors[name]);
      if (firstInvalid) {
        setStatus("Review the marked fields. Nothing was sent or saved.");
        const field = (event.currentTarget as HTMLFormElement).elements.namedItem(firstInvalid);
        if (field instanceof HTMLInputElement) field.focus();
        return;
      }
    }
    const attempt = configurationAttempt(pending, draft, record?.revision ?? 0);
    if (!attempt.values) { setStatus("This request's local values were discarded. Inspect or acknowledge it before starting a fresh request."); return; }
    if (!pending) setPending(attempt);
    setBusy(true);
    setStatus("Submitting this write once…");
    try {
      const response = await fetch(settingsEndpoint("configuration"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "save", capability, target, expectedRevision: attempt.expectedRevision, requestKey: attempt.requestKey, values: attempt.values }),
        signal: AbortSignal.timeout(SAVE_DEADLINE_MS),
      });
      const value = await response.json().catch(() => null);
      const parsed = configurationSaveResponseSchema.safeParse(value);
      if (!response.ok || !parsed.success || parsed.data.record.requestKey !== attempt.requestKey || parsed.data.record.capability !== capability || parsed.data.record.target !== fullTarget) {
        consumeError(value); return;
      }
      const saved = parsed.data.record;
      setRecords((current) => [...current.filter((item) => !(item.capability === capability && item.target === fullTarget)), saved]);
      const settlement = configurationSettlement(draft, saved);
      setDraft(draftAfterRecoveredAttempt(draft, attempt.values, saved.result ?? { state: "uncertain", accepted: [], failed: names.map((name) => ({ name, code: "completion_unconfirmed" })) }));
      if (settlement.releaseRequestKey) setPending(null);
      setNeedsFreshKey(false);
      setStatus(settlement.message);
      router.refresh();
    } catch { setStatus("Outcome unconfirmed. Inspect this same request before any fresh request; there is no automatic resend."); }
    finally { setBusy(false); }
  };

  const acknowledge = async () => {
    if (!record || busy) return;
    setBusy(true);
    try {
      const response = await fetch(settingsEndpoint("configuration"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "acknowledge-unresolved", capability, target, requestKey: record.requestKey }),
        signal: AbortSignal.timeout(STATUS_DEADLINE_MS),
      });
      const value = await response.json().catch(() => null);
      const parsed = configurationAcknowledgementSchema.safeParse(value);
      if (!response.ok || !parsed.success || parsed.data.record.requestKey !== record.requestKey || parsed.data.record.capability !== capability || parsed.data.record.target !== fullTarget || parsed.data.record.revision <= record.revision) {
        consumeError(value); return;
      }
      setRecords((current) => [...current.filter((item) => !(item.capability === capability && item.target === fullTarget)), parsed.data.record]);
      if (pending?.requestKey === record.requestKey) setPending(null);
      setStatus("Acknowledged as unresolved. The earlier provider write may still complete; acknowledgment is not cancellation or success.");
      router.refresh();
    } catch { setStatus(errorCopy.unavailable); }
    finally { setBusy(false); }
  };

  const recoveryControls = <div className="setConfigActions">
    <button className="inkControl setBtn" type="button" disabled={busy} onClick={() => void refresh()}><span className="inkSweep" aria-hidden="true" />Refresh save receipt</button>
    {(record?.status === "running" || record?.status === "uncertain" && !record.acknowledged) && <button className="inkControl setBtn" type="button" disabled={busy} onClick={() => void acknowledge()}><span className="inkSweep" aria-hidden="true" />Acknowledge unresolved</button>}
  </div>;

  const targetSelector = <label className="setConfigLabel">Deployment target
    <select className="setSelect" value={target} disabled={busy || pending !== null} onChange={(event) => { setTarget(event.target.value as ConfigurationTarget); setPending(null); setStatus(""); setFieldErrors({}); setNeedsFreshKey(false); }}>
      <option value="production">production</option><option value="preview">preview</option>
    </select>
  </label>;

  if (!canSave) return <div className="setConfigEditor">
    <p className="setConfigProject">Fixed project · <b>{initialView.adapter.projectId ?? "not configured"}</b>{initialView.adapter.teamId ? ` · ${initialView.adapter.teamId}` : " · personal scope"}</p>
    {targetSelector}
    <p className="setConfigState">Running app configuration · {initialView.presence[capability].configured ? "present" : `missing ${initialView.presence[capability].missing.join(" + ")}`}</p>
    <p className={`setConfigState ${initialView.evidence[capability].state === "unavailable" ? "setValOff" : "setValMuted"}`}>Observed status · {initialView.evidence[capability].detail}</p>
    <p className="setConfigState">Provider receipt · {resultWords(record)}</p>
    <p className="setConfigWarn">{!initialView.adapter.configured
      ? "Configure the fixed Vercel project-management adapter once in the provider UI. Secret entry is disabled until the server has CORTEX_VERCEL_TOKEN, CORTEX_VERCEL_PROJECT_ID, and its Vercel system environment indicators."
      : !initialView.ingressReady
        ? "Secret entry is unavailable because this request is not running behind the supported Vercel-managed HTTPS ingress. Enable Vercel system environment variables from the provider project settings; do not set platform indicators manually."
        : initialView.store === "schema-required"
        ? "The database is missing configuration receipt tables. An administrator must follow the reviewed database upgrade procedure before this form can save. Do not reset an existing database."
        : initialView.store === "unconfigured"
        ? "The database that records configuration saves is not connected. Connect Supabase and install its receipt tables through the initial provider setup; this form cannot create its own receipt store."
        : "The receipt store did not answer (it records that a save happened, never the values). The secret form stays closed until it does. Reload Settings after the connection is restored."
      }</p>
    <a className="inkControl setBtn" href="https://vercel.com/dashboard" target="_blank" rel="noreferrer"><span className="inkSweep" aria-hidden="true" />Open Vercel provider UI</a>
    {recoveryControls}
    <p className="setConfigStatus" role="status">{status}</p>
  </div>;

  return <form className="setConfigEditor" noValidate onSubmit={(event) => void save(event)}>
    <p className="setConfigProject">Fixed project · <b>{initialView.adapter.projectId}</b>{initialView.adapter.teamId ? ` · ${initialView.adapter.teamId}` : " · personal scope"}</p>
    {targetSelector}
    {effectWarning[capability] && <p className="setConfigWarn">{effectWarning[capability]}</p>}
    <p className="setConfigState">Running app configuration · {initialView.presence[capability].configured ? "present" : `missing ${initialView.presence[capability].missing.join(" + ")}`}</p>
    <p className={`setConfigState ${initialView.evidence[capability].state === "unavailable" ? "setValOff" : "setValMuted"}`}>Observed status · {initialView.evidence[capability].detail}</p>
    <p className="setConfigState">Provider receipt · {resultWords(record)}</p>
    <p className="setConfigState">Running app presence describes this deployment. A provider save needs a separate deployment before it can take effect. Refresh save receipt checks the save record only.</p>
    {capability === "alerts" && <p className="setConfigState">Mail delivery · not tested by this form. Saving and refreshing receipts send no email. All three fields are required here; the running mailer can use its onboarding sender when OPS_ALERT_FROM is omitted in manual provider setup.</p>}
    <p className="setConfigState">These environment names are fixed. Every field is required for a complete save. Secret fields need the actual key or token value; provider IDs and key names cannot authenticate.</p>
    {names.map((name) => <label className="setConfigLabel" key={name}>{name} · {fields[name].kind} · Required
      <span className="setSub" id={`config-${name}-help`}>{fields[name].label}. {fields[name].help}</span>
      <input
        className="setConfigInput"
        name={name}
        type={fields[name].kind === "Secret" ? "password" : "text"}
        autoComplete="new-password"
        autoCapitalize="none"
        spellCheck={false}
        required
        aria-describedby={`config-${name}-help`}
        aria-invalid={fieldErrors[name] ? true : undefined}
        aria-errormessage={fieldErrors[name] ? `config-${name}-error` : undefined}
        value={draft[name]}
        disabled={busy}
        onChange={(event) => {
          setDraft((current) => ({ ...current, [name]: event.target.value }));
          setFieldErrors((current) => { const next = { ...current }; delete next[name]; return next; });
        }}
      />
      {fieldErrors[name] && <span className="setConfigWarn" id={`config-${name}-error`}>{fieldErrors[name]}</span>}
    </label>)}
    <p className="setConfigWarn">Write-only: values are sent directly to the fixed provider project and are never read back, stored in Cortex receipts, placed in URLs, or logged. Save never deploys.</p>
    <div className="setConfigActions">
      <button className="inkControl setBtn" type="submit" disabled={busy || pending?.values === null}><span className="inkSweep" aria-hidden="true" />{busy ? "Saving…" : pending ? "Retry this same save" : "Save provider environment"}</button>
      <button className="inkControl setBtn" type="button" disabled={busy} onClick={() => { setDraft(Object.fromEntries(names.map((name) => [name, ""]))); setFieldErrors({}); setPending((current) => current ? { ...current, values: null } : null); setNeedsFreshKey(false); setStatus("Draft discarded on this device. Any unresolved receipt remains available for status or acknowledgment."); }}><span className="inkSweep" aria-hidden="true" />Discard draft</button>
      {recoveryControls.props.children}
      {needsFreshKey && <button className="inkControl setBtn" type="button" disabled={busy} onClick={() => { setPending(null); setNeedsFreshKey(false); setStatus("Fresh request prepared explicitly; the draft is unchanged."); }}><span className="inkSweep" aria-hidden="true" />Start fresh request</button>}
    </div>
    <Link className="setConfigDeploy" href={opsHref} prefetch={false}>Review deployment actions in Ops</Link>
    <p className="setConfigState">Ops prepares a deployment for separate approval. This save receipt does not yet track which deployment uses these values.</p>
    <p className="setConfigStatus" role="status">{status}</p>
  </form>;
}

export function ConfigurationPanel({ view }: Readonly<{ view: ConfigurationView }>) {
  const lens = useLens();
  return <div className="setConfigRows">
    <p className="setConfigProject">Fixed provider project · <b>{view.adapter.projectId ?? "not configured"}</b>{view.adapter.teamId ? ` · ${view.adapter.teamId}` : " · personal scope"}</p>
    {(Object.keys(CONFIGURATION_GROUPS) as ConfigurationCapability[]).map((capability) => {
      const group = CONFIGURATION_GROUPS[capability];
      const presence = view.presence[capability];
      const evidence = view.evidence[capability];
      const prod = currentRecord(view, capability, "production");
      const preview = currentRecord(view, capability, "preview");
      return <button key={capability} id={`setConfiguration-${capability}`} type="button" className="setConfigRow" onClick={() => lens.open({
        id: `configuration:${capability}`,
        kind: "capability setup",
        title: group.label,
        body: <ConfigurationEditor capability={capability} initialView={view} />,
      })}>
        <span className="setRowBody"><span className="setLabel">{group.label}</span><span className="setSub">{group.variables.join(" + ")}</span></span>
        <span className={`setConfigFact ${presence.configured ? "setValOn" : "setValOff"}`}>{presence.configured ? "running app configuration · present" : `running app configuration · missing ${presence.missing.join(" + ")}`}</span>
        <span className={`setConfigFact ${evidence.state === "unavailable" ? "setValOff" : "setValMuted"}`}>observed status · {evidence.detail}</span>
        <span className="setConfigFact setValMuted">production · {resultWords(prod)}{preview ? ` · preview · ${resultWords(preview)}` : " · preview · no dashboard save recorded"}</span>
      </button>;
    })}
  </div>;
}
