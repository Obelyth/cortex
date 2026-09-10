"use client";
import { useEffect, useRef, useState, useTransition, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import type { TriageItem } from "@/lib/health";
import type { DecisionItem } from "@/lib/ops-inbox";
import { noteOf } from "@/lib/triage-loc";
import { submitProposalDecision, type ProposalAction } from "@/lib/proposal-result";
import { useLens, type LensContent } from "../lens";
import { ProposalLensBody, TriageLensBody, type VerifyAction } from "./ops-lens";

/**
 * Decisions — the inbox beneath the register (v2): the triage queue, the watch items and the
 * guest proposals as one list, each line opening in the lens with its evidence, its why and
 * the buttons the Attention screen offers. The panel is the inverted region because it is the
 * one region asking a person for something.
 *
 * Both writes go through the console's gated routes and then router.refresh(): the item leaves
 * because the note changed or the proposal was decided, never because it was hidden. If the
 * write did not take, the item is still there, which is the truth.
 */
export function OpsDecisionsFrame({ meta, children }: Readonly<{ meta: ReactNode; children: ReactNode }>) {
  return (
    <section className="opsDecisions" aria-labelledby="ops-decisions">
      <div className="opsDecisionsHead">
        <span className="opsTag">
          <span className="opsTagN">02</span>
          <h2 id="ops-decisions" className="opsTagLabel">Decisions</h2>
        </span>
        <span className="opsDecisionsMeta">{meta}</span>
      </div>
      {children}
    </section>
  );
}

/** What the boundary shows while the three corpus reads run behind the register. */
export function OpsDecisionsSkeleton() {
  return (
    <OpsDecisionsFrame meta="reading the corpus…">
      <div className="opsQuiet">triage, watch items and proposals arrive behind the register</div>
    </OpsDecisionsFrame>
  );
}

export function OpsDecisions({ items, secret }: Readonly<{ items: DecisionItem[]; secret: string }>) {
  const lens = useLens();
  const router = useRouter();
  const [, start] = useTransition();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [proposalResult, setProposalResult] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const proposals = items.filter((i) => i.kind === "proposal").length;
  const lensId = lens.lens?.id ?? null;
  // The provider hands out a fresh api object every render; the effect below wants the
  // functions, not the object, or it would re-run on every render and publish forever.
  const api = useRef(lens);
  api.current = lens;

  async function verify(path: string, action: VerifyAction) {
    if (busy) return;
    setBusy(action);
    setError(null);
    try {
      const res = await fetch(`/s/${secret}/console/attention/verify`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ path, action }) });
      const j = (await res.json().catch(() => ({}))) as { error?: string; changed?: boolean };
      if (!res.ok) { setError(j.error ?? `the write failed (HTTP ${res.status})`); return; }
      if (j.changed === false) setError("already in that state — nothing to commit");
      start(() => router.refresh());
    } catch (e) {
      setError(e instanceof Error ? e.message : "the request did not complete");
    } finally {
      setBusy(null);
    }
  }

  async function decide(id: string, action: ProposalAction) {
    if (busy) return;
    setBusy(id);
    setError(null);
    setProposalResult(null);
    try {
      const res = await submitProposalDecision(`/s/${secret}/console/proposals`, id, action);
      if (!res.success) { setError(res.message); setProposalResult(res.message); start(() => router.refresh()); return; }
      setProposalResult(res.message);
      start(() => router.refresh());
    } finally {
      setBusy(null);
    }
  }

  const copy = (q: TriageItem) => {
    const text = `${q.title}\n${q.loc}\n\nevidence: ${q.evidence}\nwhy: ${q.why}\naction: ${q.action}`;
    navigator.clipboard?.writeText(text).then(() => setCopied(q.loc), () => setCopied(null));
  };

  const content = (it: DecisionItem): LensContent =>
    it.kind === "proposal"
      ? { id: it.id, kind: "guest proposal", title: `${it.proposal.mode} → ${it.proposal.path}`, body: <ProposalLensBody key={it.id} p={it.proposal} busy={busy === it.proposal.id} error={error} onDecide={(a) => decide(it.proposal.id, a)} /> }
      : { id: it.id, kind: `inbox · ${it.sev}`, title: it.title, body: <TriageLensBody key={it.id} item={it.item} busy={(busy as VerifyAction | null)} error={error} copied={copied === it.loc} onAct={(a) => verify(noteOf(it.loc), a)} onCopy={() => copy(it.item)} /> };

  // The lens holds a snapshot. Whenever a write moves or the queue re-reads, the open item's
  // body is published again; an item that has left the queue — the note changed, the proposal
  // was decided — closes the lens, because there is nothing left to show for it.
  useEffect(() => {
    if (!lensId || !(lensId.startsWith("triage:") || lensId.startsWith("proposal:"))) return;
    const it = items.find((i) => i.id === lensId);
    if (it) api.current.open(content(it)); else api.current.close();
    // content() closes over busy/error/copied, which are the deps that matter.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items, busy, error, copied, lensId]);

  const open = (it: DecisionItem) => { setError(null); lens.open(content(it)); };

  return (
    <OpsDecisionsFrame meta={<>{items.length} waiting · {proposals} proposal{proposals === 1 ? "" : "s"} · every fix commits</>}>
      {/* Always mounted: a live region that appears with its text is not reliably announced. */}
      <div role="status" className={proposalResult ? "opsQuiet" : "srOnly"}>{proposalResult ?? ""}</div>
      <div className="opsDecisionsBody">
        <div>
          <div className="opsDecisionsN">{items.length}</div>
          <div className="opsDecisionsCap">waiting on a decision · derived from the corpus on every render · a fix writes to the note and commits</div>
        </div>
        <ol className="opsDecisionsList">
          {items.map((it) => (
            <li key={it.id}>
              <button type="button" className="opsDecision" aria-haspopup="dialog" aria-expanded={lensId === it.id} onClick={() => open(it)}>
                <span className={`opsSev opsSev-${it.sev}`}>{it.sev}</span>
                <span className="opsDecisionText">
                  <span className="opsDecisionTitle">{it.title}</span>
                  <span className="opsDecisionLoc">{it.loc}</span>
                </span>
              </button>
            </li>
          ))}
          {items.length === 0 && <li className="opsQuiet">nothing needs attention · quiet is the correct state</li>}
        </ol>
      </div>
    </OpsDecisionsFrame>
  );
}
