import { requireSecret } from "@/lib/gate";
import { health } from "@/lib/health";
import { listProposals } from "@/lib/proposals";
import { AttentionClient } from "./attention-client";
import { ProposalsClient } from "./proposals-client";
import styles from "../console.module.css";

export const dynamic = "force-dynamic";
export const maxDuration = 60;
export const metadata = { title: "Attention · Cortex console" };

/**
 * Attention — what is waiting on a decision.
 *
 * Proposals sit at the TOP, above the triage queue: a triage item is something the corpus
 * noticed about itself and will still be true tomorrow, while a proposal is a stranger asking
 * to put something in the brain. Only one of those is waiting on the operator.
 */
export default async function Attention({
  params,
}: {
  params: Promise<{ secret: string }>;
}) {
  await requireSecret(params);
  const h = await health();
  const proposals = await listProposals();
  return (
    <>
      <ProposalsClient proposals={proposals} />
      <AttentionClient queue={h.triage} />
      <section className={styles.block}>
        <div className={styles.blockHead}>
          <span>
            Retracted passages · {Math.min(40, h.retractedList.length)} shown of{" "}
            {h.totals.retractedBlocks}
          </span>
          <span className={styles.dim}>
            credit, not a problem — a quote from a retired passage is stamped SUPERSEDED, and one
            from a claim corrected in place is stamped CORRECTED
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
