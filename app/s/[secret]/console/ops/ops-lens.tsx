import { Fragment, type ReactNode } from "react";
import type { BoardRow } from "@/lib/ops-board";
import type { TriageItem } from "@/lib/health";
import type { Proposal } from "@/lib/proposals";
import type { ReceiptPhase } from "@/lib/receipt-state";
import { noteOf } from "@/lib/triage-loc";

/**
 * The Ops screen's lens bodies — L3 a unit, L4 a receipt, L5 an inbox item, L6 a guest
 * proposal — as pure views. Everything they show and every button they offer arrives as props;
 * the client that opened the lens owns the state (the receipt machine, a write in flight) and
 * publishes a fresh body whenever it moves. That is what lets scripts/dev/render-ops.tsx draw
 * every body from fixtures, and what keeps the drawer honest after router.refresh(): the body
 * is rebuilt from the board the register was rebuilt from, never from the render before.
 */

/** ISO → "2026-09-05 08:31:00 utc". */
export const stampUtc = (iso: string): string => (iso ? `${iso.slice(0, 19).replace("T", " ")} utc` : "—");
/** ISO → "09-05 08:31": the ties column is 78px wide. */
export const shortWhen = (iso: string): string => iso.slice(5, 16).replace("T", " ");

export interface ControlVM { key: string; label: string; primary: boolean; phase: ReceiptPhase; inert: boolean; go: () => void }
export interface ReceiptVM { id: number; at: string; line: string; field: string | null }

/** The key–value ledger every body carries. A null row is simply not printed. */
export function LensKv({ rows }: Readonly<{ rows: Array<[string, ReactNode] | null> }>) {
  return (
    <dl className="opsLensKv">
      {rows.filter((r): r is [string, ReactNode] => r !== null).map(([k, v]) => (
        <Fragment key={k}>
          <dt>{k}</dt>
          <dd>{v}</dd>
        </Fragment>
      ))}
    </dl>
  );
}

/** L3 — a unit: its facts, its last run, the receipts it wrote, and the controls that act on it. */
export function UnitLensBody({ row, receipts, total, controls, busy, receipt, opened, error, onReceipt }: Readonly<{
  row: BoardRow; receipts: ReceiptVM[]; total: number; controls: ControlVM[]; busy: boolean;
  /** "receipt 123 · 08:41:02 utc" while done holds, else null. */
  receipt: string | null;
  /** The URL a link-kind Run now handed back; the operator's own click opens it. */
  opened: string | null; error: string | null; onReceipt: (id: number) => void;
}>) {
  const runNow = row.runNowKind === "link" ? `link · ${row.runNowTarget}` : row.runNowKind === "dispatch" ? `repository_dispatch · ${row.runNowTarget}` : "no target";
  return (
    <>
      <div className="opsLensId">{row.id} · {row.kind}{row.kind === "machine" ? " · never pages" : ""}</div>
      {row.notes && <p className="opsLensDesc">{row.notes}</p>}
      <LensKv rows={[
        ["state", row.stateLabel],
        ["schedule", row.schedule],
        ["last run", `${row.lastRun}${row.summary ? ` · ${row.summary}` : ""}`],
        row.error ? ["error", <span key="e" className="opsErr">{row.error}</span>] : null,
        ["evidence", row.evidence.length ? row.evidence.join(" · ") : "none"],
        row.nextDue ? ["next due", stampUtc(row.nextDue).slice(0, 16) + " utc"] : null,
        ["run now", runNow],
      ]} />
      <div>
        <div className="opsLensTies">Receipts · this unit · {receipts.length} of {total} · 30 d</div>
        <ol className="opsTies">
          {receipts.map((e) => (
            <li key={e.id}>
              <button type="button" className="opsTie" onClick={() => onReceipt(e.id)}>
                <span className="opsTieKind">{shortWhen(e.at)}</span>
                <span className="opsTieText">
                  <span className="opsTieLabel">{e.line}</span>
                  {e.field && <span className="opsTieWhy">{e.field}</span>}
                </span>
              </button>
            </li>
          ))}
        </ol>
        {receipts.length === 0 && <div className="opsEmpty">no receipts in 30 d · the first run writes the first row</div>}
      </div>
      <div className="opsLensActs" aria-busy={busy}>
        {controls.map((c) => (
          <button
            key={c.key}
            type="button"
            className={`opsAct${c.primary ? " opsActPrimary" : ""}${c.phase === "rest" ? "" : ` opsAct-${c.phase}`}`}
            // Not `disabled`: that drops keyboard focus to the body the moment the pressed
            // button goes to work. The client refuses a second press while working.
            aria-disabled={c.inert ? true : undefined}
            onClick={c.go}
          >
            {c.label}
          </button>
        ))}
        {!controls.some((c) => c.key === "run-now") && <span className="opsQueued">Run now · no target</span>}
        {receipt && <span className="opsReceiptChip">{receipt}</span>}
        {/* Outlives the done hold on purpose: this link is the whole outcome of a link-kind Run
            now. Never window.open — after an await the browser no longer counts it as the
            operator's click. */}
        {opened && <a className="opsAct" href={opened} target="_blank" rel="noopener">Open on claude.ai ↗</a>}
        {error && <span className="opsErr">{error}</span>}
      </div>
      <div className="opsLensNote">every control writes its receipt before anything else that could fail · state is derived from the latest run, the latest ack and the clock — never stored as a reporter&apos;s adjective</div>
    </>
  );
}

/** L4 — one ops_events row. */
export function ReceiptLensBody({ e, unitName, onUnit }: Readonly<{ e: { id: number; at: string; unit: string; kind: string; line: string; field: { text: string } | null }; unitName: string | null; onUnit: (() => void) | null }>) {
  return (
    <>
      <div className="opsLensId">ops_events · {e.id}</div>
      <p className="opsLensDesc">An append-only receipt. Every report, every sweep transition and every control a person presses writes one of these before anything else that could fail.</p>
      <LensKv rows={[
        ["at", stampUtc(e.at)],
        ["unit", unitName ? `${unitName} · ${e.unit}` : e.unit],
        ["kind", e.kind],
        ["outcome", e.field ? e.field.text : "—"],
      ]} />
      {onUnit && (
        <div className="opsLensActs">
          <button type="button" className="opsAct opsActPrimary" onClick={onUnit}>Open unit</button>
        </div>
      )}
    </>
  );
}

export type VerifyAction = "checked" | "settled" | "queue";

/**
 * L5 — an inbox item, with the buttons the Attention screen offers today and no others.
 *
 * A stale stamp has three honest answers: the claims were re-checked (an attestation), the
 * note records settled history, or hand the check to the nightly run. The watch kinds get
 * SETTLED alone. A finding with no kind — a credential-shaped line, an unmarked retired-tool
 * claim — gets no button at all: those are about danger, not freshness, and nothing here could
 * truthfully silence them. There is no dismiss, because a derived finding would be back
 * tomorrow having taught you to click past it. Every fix writes to the note and commits.
 */
export function TriageLensBody({ item: q, busy, error, copied, onAct, onCopy }: Readonly<{ item: TriageItem; busy: VerifyAction | null; error: string | null; copied: boolean; onAct: (a: VerifyAction) => void; onCopy: () => void }>) {
  const path = noteOf(q.loc);
  const migration = q.kind === "pending-migration";
  const stale = q.kind === "stale-stamp";
  const fixable = stale || q.kind === "superseded-link" || q.kind === "coaccess-gap" || q.kind === "correction-chain";
  const pair = q.loc.includes(" ↔ ");
  const fix = (a: VerifyAction, label: string, primary: boolean) => (
    <button type="button" className={`opsAct${primary ? " opsActPrimary" : ""}${busy === a ? " opsAct-working" : ""}`} aria-disabled={busy !== null && busy !== a ? true : undefined} onClick={() => onAct(a)}>
      {busy === a ? "committing…" : label}
    </button>
  );
  return (
    <>
      <div className="opsLensId">{q.loc}</div>
      <p className="opsLensDesc">{q.why}</p>
      <LensKv rows={[
        ["evidence", q.evidence],
        ["action", q.action],
        ["kind", q.kind ?? "danger · no button can truthfully silence it"],
        q.queued ? ["queued", `for the groundskeeper since ${q.queued}`] : null,
      ]} />
      <div className="opsLensActs">
        {/* A pending migration is a finding about the database, not about a note: there is no
            page to open and nothing the brain can be asked. Copy carries the command. */}
        {!migration && <a className="opsAct" href={`corpus?note=${encodeURIComponent(path)}`}>Open the note</a>}
        {!migration && <a className="opsAct" href={`ask?q=${encodeURIComponent(`${q.title} — ${path}. ${q.action}`)}`}>Ask the brain about it</a>}
        <button type="button" className="opsAct" onClick={onCopy}>{copied ? "copied" : "Copy for a session"}</button>
      </div>
      {fixable && (
        <div className="opsLensActs" aria-busy={busy !== null}>
          {stale && fix("checked", "I re-checked it — stamp today", true)}
          {/* The path is in the label for pair-shaped items on purpose: the action marks ONE note. */}
          {fix("settled", pair ? `settled history — stop watching ${path}` : "settled history — stop watching", !stale)}
          {stale && (q.queued
            ? <span className="opsQueued">queued for the groundskeeper since {q.queued}</span>
            : fix("queue", "queue for tonight's re-verify", false))}
        </div>
      )}
      <div className="opsLensNote">
        {error ?? (stale
          ? "All three write to the note and commit. The first is your attestation that its claims still hold; the last asks the nightly run to check for you."
          : fixable
            ? "Writes `decays: false` into the note and commits — your claim that this page records something finished. It leaves every check here, and keeps the ones about danger rather than freshness."
            : "derived from the corpus on every render · it leaves when the note changes")}
      </div>
    </>
  );
}

/**
 * L6 — a guest proposal. Every string came from a model this server does not control, so it is
 * rendered as text and nothing else: no markdown, no clickable link, the self-reported client
 * name labelled as a claim. Shown in full — deciding whether to commit something you have seen
 * the first line of is not a decision.
 */
export function ProposalLensBody({ p, busy, error, onDecide }: Readonly<{ p: Proposal; busy: boolean; error: string | null; onDecide: (a: "accept" | "reject" | "cancel") => void }>) {
  return (
    <>
      <div className="opsLensId">{p.id} · proposed {stampUtc(new Date(p.ts).toISOString()).slice(0, 16)} utc</div>
      <LensKv rows={[
        ["target", p.path],
        ["mode", p.mode],
        ["from", p.client ? `${p.client} · self-reported, unverified` : "client unstated"],
        p.why ? ["stated reason", p.why] : null,
      ]} />
      <div>
        <div className="opsLensTies">Proposed content · untrusted text, shown verbatim</div>
        <pre className="opsPre">{p.content}</pre>
      </div>
      <div className="opsLensActs" aria-busy={busy}>
        <button type="button" className={`opsAct opsActPrimary${busy ? " opsAct-working" : ""}`} aria-disabled={busy ? true : undefined} onClick={() => onDecide("accept")}>{busy ? "…" : `Accept · commit to ${p.path}`}</button>
        <button type="button" className="opsAct" aria-disabled={busy ? true : undefined} onClick={() => onDecide(p.state === "accepting" ? "cancel" : "reject")}>{p.state === "accepting" ? "Cancel acceptance" : "Reject · leaves no trace"}</button>
      </div>
      <div className="opsLensNote">{error ?? (p.state === "accepting"
        ? "Cancel acceptance leaves the target note unchanged if the cancel lands first. If the commit already landed, you get that commit's result instead."
        : "Accepting performs the real write — a commit into the brain under your name. Rejecting leaves no trace. Neither can be undone from here.")}</div>
    </>
  );
}
