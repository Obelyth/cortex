"use client";
import { useState } from "react";
import type { Health } from "@/lib/health";
import styles from "../console.module.css";

/** The triage queue and its evidence pane — selection is the only client state. */
export function AttentionClient({ queue }: { queue: Health["triage"] }) {
  const [sel, setSel] = useState(0);
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
            <span className={`${styles.pill} ${item.sev === "crit" ? styles.pillCrit : styles.pillWarn}`}>
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
            <span className={`${styles.pill} ${q.sev === "crit" ? styles.pillCrit : styles.pillWarn}`}>
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
        </section>
      )}
    </div>
  );
}
