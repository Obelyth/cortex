import { requireSecret } from "@/lib/gate";
import { health } from "@/lib/health";
import { AttentionClient } from "./attention-client";
import styles from "../console.module.css";

export const dynamic = "force-dynamic";
export const maxDuration = 60;
export const metadata = { title: "Attention · Cortex console" };

/** Attention — the queue with its evidence pane, then the retracted passages as credit. */
export default async function Attention({
  params,
}: {
  params: Promise<{ secret: string }>;
}) {
  await requireSecret(params);
  const h = await health();
  return (
    <>
      <AttentionClient queue={h.triage} />
      <section className={styles.block}>
        <div className={styles.blockHead}>
          <span>
            Retracted passages · {Math.min(40, h.retractedList.length)} shown of{" "}
            {h.totals.retractedBlocks}
          </span>
          <span className={styles.dim}>
            credit, not a problem — the verifier stamps every quote from these SUPERSEDED
          </span>
        </div>
        {h.retractedList.slice(0, 40).map((r, i) => (
          <div key={`${r.path}:${r.line}:${i}`} className={styles.commitRow}>
            <span className={styles.sha}>{r.path}:{r.line}</span>
            <span className={styles.msg}>{r.text}…</span>
            <span className={styles.agoCol}>{r.heading ? "§" : ""}</span>
          </div>
        ))}
      </section>
    </>
  );
}
