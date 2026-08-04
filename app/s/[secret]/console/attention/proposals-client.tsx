"use client";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
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
  const [open, setOpen] = useState<string | null>(proposals[0]?.id ?? null);

  async function act(id: string, action: "accept" | "reject") {
    setBusy(id);
    setError(null);
    try {
      const res = await fetch(url(), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id, action }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: string } | null;
        setError(body?.error ?? `the request was refused (${res.status})`);
        return;
      }
      start(() => router.refresh());
    } catch {
      setError("the request did not reach the server");
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
              <div className={styles.propActions}>
                <button
                  type="button"
                  className={styles.rdBtn}
                  disabled={working}
                  onClick={() => act(p.id, "reject")}
                >
                  {busy === p.id ? "…" : "reject"}
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
