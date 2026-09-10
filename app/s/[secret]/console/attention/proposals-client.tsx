"use client";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { submitProposalDecision, type ProposalAction } from "@/lib/proposal-result";
import styles from "../console.module.css";

/**
 * The review surface for guest proposals.
 *
 * Every string here came from a model the operator does not control, so it is rendered as text and
 * nothing else — React escapes it, no markdown is interpreted, no link is made clickable, and
 * the self-reported client name is labelled as a claim rather than shown as identity. The
 * content is displayed in full, never truncated to a summary: deciding whether to commit
 * something you have only seen the first line of is not a decision.
 */

export interface ProposalVM {
  id: string;
  ts: number;
  path: string;
  mode: string;
  content: string;
  why?: string;
  client?: string;
  state?: "pending" | "accepting";
}

function url(): string {
  const p = window.location.pathname.replace(/\/+$/, "");
  return `${p.replace(/\/attention$/, "")}/proposals`;
}

export function ProposalsClient({ proposals }: { proposals: ProposalVM[] }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(proposals[0]?.id ?? null);

  async function act(id: string, action: ProposalAction) {
    setBusy(id);
    setError(null);
    setResult(null);
    try {
      const res = await submitProposalDecision(url(), id, action);
      if (!res.success) { setError(res.message); start(() => router.refresh()); return; }
      setResult(res.message);
      start(() => router.refresh());
    } finally {
      setBusy(null);
    }
  }

  const working = pending || busy !== null;

  return (
    <section className={styles.block}>
      <div className={styles.blockHead}>
        <span>Proposals · {proposals.length} pending</span>
        <span className={styles.dim}>
          left by guest clients, which can read the brain but never write to it — accepting is
          what commits
        </span>
      </div>

      {error && <div className={styles.refused}>{error}</div>}
      {/* Always mounted: a live region that appears with its text is not reliably announced. */}
      <div role="status" className={result ? styles.footNote : "srOnly"}>{result ?? ""}</div>

      {proposals.length === 0 && (
        <div className={styles.footNote}>
          Nothing proposed. Guests reach the brain through the read-and-propose URL; anything
          they suggest waits here until you accept it.
        </div>
      )}

      {proposals.map((p) => (
        <div key={p.id} className={styles.propRow}>
          <button
            type="button"
            className={styles.propHead}
            aria-expanded={open === p.id}
            onClick={() => setOpen(open === p.id ? null : p.id)}
          >
            <span className={styles.propPath}>{p.path}</span>
            <span className={styles.propMode}>{p.mode}</span>
            <span className={styles.note}>
              {p.client ? `${p.client} (unverified)` : "client unstated"} ·{" "}
              {new Date(p.ts).toISOString().slice(0, 16).replace("T", " ")}
            </span>
          </button>

          {open === p.id && (
            <div className={styles.propBody}>
              {p.why && (
                <div className={styles.propWhy}>
                  <span className={styles.note}>stated reason</span>
                  <span>{p.why}</span>
                </div>
              )}
              <div className={styles.note}>proposed content — untrusted text, shown verbatim</div>
              <pre className={styles.propContent}>{p.content}</pre>
              {p.state === "accepting" && <p className={styles.note}>Acceptance is running. Cancel acceptance leaves the target note unchanged if the cancel lands first; if the commit already landed, you get that commit's result instead.</p>}
              <div className={styles.propActions}>
                <button
                  type="button"
                  className={styles.rdBtn}
                  disabled={working}
                  onClick={() => act(p.id, p.state === "accepting" ? "cancel" : "reject")}
                >
                  {busy === p.id ? "…" : p.state === "accepting" ? "Cancel acceptance" : "Reject"}
                </button>
                <button
                  type="button"
                  className={`${styles.rdBtn} ${styles.propAccept}`}
                  disabled={working}
                  onClick={() => act(p.id, "accept")}
                >
                  {busy === p.id ? "…" : `accept → commit to ${p.path}`}
                </button>
              </div>
            </div>
          )}
        </div>
      ))}
    </section>
  );
}
