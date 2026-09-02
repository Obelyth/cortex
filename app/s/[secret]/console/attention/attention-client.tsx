"use client";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import type { Health } from "@/lib/health";
import { noteOf } from "@/lib/triage-loc";
import styles from "../console.module.css";

/** Three tiers, three inks — the watch tier is the quiet one, because the mechanical checks
 *  are structure worth a glance, not a problem shouting. */
function pillClass(sev: Health["triage"][number]["sev"]): string {
  return sev === "crit" ? styles.pillCrit : sev === "watch" ? styles.pillWatch : styles.pillWarn;
}

/** The triage queue and its evidence pane. */
export function AttentionClient({ queue }: { queue: Health["triage"] }) {
  const router = useRouter();
  const [sel, setSel] = useState(0);
  const [copied, setCopied] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [, start] = useTransition();

  /**
   * Both actions WRITE to the note, which is the only way an item can honestly leave a derived
   * queue: the finding is recomputed from the corpus, so it disappears because the note changed,
   * not because it was hidden. `router.refresh()` re-derives rather than optimistically removing
   * the row -- if the write did not take, the item is still there, which is the truth.
   */
  async function act(path: string, action: "checked" | "settled" | "queue") {
    setBusy(action);
    setError(null);
    try {
      const res = await fetch("attention/verify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path, action }),
      });
      const j = (await res.json().catch(() => ({}))) as { error?: string; changed?: boolean };
      if (!res.ok) {
        setError(j.error ?? `the write failed (HTTP ${res.status})`);
        return;
      }
      if (j.changed === false) setError("already in that state — nothing to commit");
      start(() => router.refresh());
    } catch (e) {
      setError(e instanceof Error ? e.message : "the request did not complete");
    } finally {
      setBusy(null);
    }
  }
  const q = queue[Math.min(sel, Math.max(0, queue.length - 1))];

  return (
    <div className={styles.triage}>
      <section className={styles.queue}>
        <div className={styles.blockHead}><span>Queue · {queue.length} open</span></div>
        {queue.length === 0 && (
          <div className={styles.footNote}>Nothing needs attention. Quiet is the correct state.</div>
        )}
        {queue.map((item, i) => (
          <button key={`${item.loc}-${i}`}
            className={`${styles.qRow}${i === sel ? " " + styles.qOn : ""}`}
            onClick={() => setSel(i)}>
            <span className={`${styles.pill} ${pillClass(item.sev)}`}>
              {item.sev}
            </span>
            <span className={styles.qTitle}>{item.title}</span>
            <span className={styles.qLoc}>{item.loc}</span>
          </button>
        ))}
      </section>
      {q && (
        <section className={styles.detail}>
          <div className={styles.blockHead}>
            <span className={`${styles.pill} ${pillClass(q.sev)}`}>
              {q.sev}
            </span>
            <span className={styles.detailLoc}>{q.loc}</span>
          </div>
          <h2 className={styles.detailTitle}>{q.title}</h2>
          <dl className={styles.kv}>
            <dt>evidence</dt><dd>{q.evidence}</dd>
            <dt>why it matters</dt><dd>{q.why}</dd>
            <dt>action</dt><dd>{q.action}</dd>
          </dl>

          {/* The panel named the problem, the evidence and the fix, and then left you nowhere to
              go — a queue you can read but not act from is a report, not an inbox.

              These three are deliberately the actions this console can honestly offer. There is
              no "resolve" button, because a triage item is DERIVED from the corpus: it is
              recomputed from the notes on every render, so marking it done would either be a lie
              until the note changed, or would need a durable ignore-list that hides real findings
              — a decision worth making on purpose rather than inventing inside a design pass.
              What the console can do is carry you to the place the fix happens. */}
          <div className="triAct">
            <a className="triActGo" href={`corpus?note=${encodeURIComponent(noteOf(q.loc))}`}>
              open the note
            </a>
            <a
              className="triActAsk"
              href={`ask?q=${encodeURIComponent(`${q.title} — ${noteOf(q.loc)}. ${q.action}`)}`}
            >
              ask the brain about it
            </a>
            <button
              type="button"
              className="triActCopy"
              onClick={() => {
                const text = `${q.title}\n${q.loc}\n\nevidence: ${q.evidence}\nwhy: ${q.why}\naction: ${q.action}`;
                navigator.clipboard?.writeText(text).then(
                  () => setCopied(q.loc),
                  () => setCopied(null)
                );
              }}
            >
              {copied === q.loc ? "copied" : "copy for a session"}
            </button>
          </div>

          {/* WHAT EACH FINDING CAN HONESTLY BE ANSWERED WITH.

              A stale stamp has three: the claims were re-checked (attestation), the note records
              settled history and should never have been on the clock, or hand the check to the
              nightly run. All three change the note.

              The watch kinds (superseded-link, coaccess-gap, correction-chain) get the SETTLED
              button and nothing else (2026-08-17). Their real fixes -- repointing a reference,
              writing a [[link]], collapsing a correction chain -- are still edits this console
              cannot make for you, and there is still no button pretending otherwise. But "this
              note is a record of something finished" is an answer that fits them exactly as well
              as it fits a stale stamp, and until today there was no way to give it: three project
              pages were retired on 2026-08-17 and went on generating watch items about work
              nobody will ever do. `decays: false` now takes a note out of these checks too, so
              the button is not a lie about where the item goes.

              Findings with no `kind` -- a credential-shaped line, an unmarked retired-tool claim
              -- get no button at all, and that is not an oversight. Those are about danger, not
              freshness: calling a page settled history does not make a stored secret safe or an
              unmarked claim safe to quote, so there is nothing here that could truthfully
              silence them.

              Still deliberately NOT a dismiss. A dismiss clears the row, changes nothing, and
              brings the finding back tomorrow having taught you to click past it. Everything here
              writes to the note and commits. */}
          {(q.kind === "stale-stamp" ||
            q.kind === "superseded-link" ||
            q.kind === "coaccess-gap" ||
            q.kind === "correction-chain") && (
            <div className="triAct triActFix">
              {q.kind === "stale-stamp" && (
                <button
                  type="button"
                  className="triActPrimary"
                  disabled={busy !== null}
                  onClick={() => act(noteOf(q.loc), "checked")}
                >
                  {busy === "checked" ? "committing…" : "I re-checked it — stamp today"}
                </button>
              )}
              {/* The path is in the label for pair-shaped items on purpose: the action marks ONE
                  note, and on a co-read or correction pair a button reading "stop watching" alone
                  would not say which end it settles. */}
              <button
                type="button"
                className={q.kind === "stale-stamp" ? "triActSecondary" : "triActPrimary"}
                disabled={busy !== null}
                onClick={() => act(noteOf(q.loc), "settled")}
              >
                {busy === "settled"
                  ? "committing…"
                  : q.loc.includes(" ↔ ")
                    ? `settled history — stop watching ${noteOf(q.loc)}`
                    : "settled history — stop watching"}
              </button>
              {/* The third honest answer: hand the check to the machine that can run it. This
                  commits a `reverify:` request into the note; the nightly groundskeeper drains
                  those first, consumes the marker, and moves the stamp only when the page
                  checks out. Queued is a promise, not a fix, so the item stays — wearing the
                  badge — until the run actually happens. */}
              {q.kind === "stale-stamp" &&
                (q.queued ? (
                  <span className="triActQueued">
                    queued for the groundskeeper since {q.queued}
                  </span>
                ) : (
                  <button
                    type="button"
                    className="triActSecondary"
                    disabled={busy !== null}
                    onClick={() => act(noteOf(q.loc), "queue")}
                  >
                    {busy === "queue" ? "committing…" : "queue for tonight's re-verify"}
                  </button>
                ))}
              <span className="triActNote">
                {error ??
                  (q.kind === "stale-stamp"
                    ? "All three write to the note and commit. The first is your attestation that its claims still hold; the last asks the nightly run to check for you."
                    : "Writes `decays: false` into the note and commits — your claim that this page records something finished. It leaves every check here, and keeps the ones about danger rather than freshness.")}
              </span>
            </div>
          )}
        </section>
      )}
    </div>
  );
}
