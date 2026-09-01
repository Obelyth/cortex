import { requireSecret } from "@/lib/gate";
import { consoleHealth, consoleProposals, consoleWatch } from "../loaders";
import { AttentionClient } from "./attention-client";
import { ProposalsClient } from "./proposals-client";
import { Band } from "../band";
import styles from "../console.module.css";

export const dynamic = "force-dynamic";
export const maxDuration = 60;
export const metadata = { title: "Attention · Cortex console" };

/**
 * Attention — what is waiting on a decision.
 *
 * Proposals OUTRANK the triage queue: a triage item is something the corpus noticed about itself
 * and will still be true tomorrow, while a proposal is a stranger asking to put something in the
 * brain. Only one of those is waiting on the operator.
 *
 * But rank is not position when the higher-ranked thing is empty. Proposals rendered
 * unconditionally at the top meant the inbox opened with "Proposals · 0 pending" and its
 * two-line explanation sitting ABOVE the only actionable item on the screen — the most common
 * state of this page led with the part that had nothing in it. When nothing is proposed, the
 * queue leads and the empty proposals block moves below it, where it still says what the guest
 * door is for without occupying the first thing the eye lands on.
 */
export default async function Attention({
  params,
}: {
  params: Promise<{ secret: string }>;
}) {
  await requireSecret(params);
  // All three already resolved by the shell this page renders inside — cache() makes these the
  // same executions rather than a second set of round trips.
  const [h, proposals, watch] = await Promise.all([consoleHealth(), consoleProposals(), consoleWatch()]);
  const waiting = proposals.length > 0;
  // Watch items ride the same queue BELOW the health findings: the queue is severity-ordered by
  // construction (crit, warn, then watch), and the mechanical checks are the tier you glance at
  // after the problems, never instead of them.
  const queue = [...h.triage, ...watch];
  const openItems = queue.length + proposals.length;
  return (
    <div className="ovSheet">
      {/* Band 01 is paper, always. It was ink when something was waiting, which put the one
          screen you actually WORK on — a triage queue, a detail panel, accept and reject — onto
          a display ground. Operate mode does not allow expression to obscure the task, and the
          state is already carried by the chip and by the heading counting the items. */}
      <Band
        n="01"
        label="Inbox"
        tone="paper"
        title={
          openItems > 0
            ? <>{openItems} {openItems === 1 ? "thing is" : "things are"} <b>waiting on a decision.</b></>
            : <>Nothing is <b>waiting on a decision.</b></>
        }
        lede={
          openItems > 0
            ? "Accepting a proposal writes a commit into the brain. Rejecting leaves no trace. Both are irreversible, which is why neither happens on one click."
            : "Guests reach the brain through the read-and-propose URL; anything they suggest waits here until you accept it. The corpus flags its own problems into the queue."
        }
      >
        {waiting && <ProposalsClient proposals={proposals} />}
        <AttentionClient queue={queue} />
        {!waiting && <ProposalsClient proposals={proposals} />}
      </Band>

      <Band
        n="02"
        label="Corrections"
        tone="grey"
        title={<>{h.totals.retractedBlocks} passages <b>crossed out and kept.</b></>}
        lede="Credit, not a problem. A quote from a retired passage is stamped SUPERSEDED; one from a claim corrected in place is stamped CORRECTED. Keeping them on the page is what lets a stale answer be caught."
      >
        <div className={styles.blockHead}>
          <span>
            Showing {Math.min(40, h.retractedList.length)} of {h.totals.retractedBlocks}
          </span>
        </div>
        {/* The § marks a passage that carries its own heading. It used to sit in a right-hand
            column ~1800px from the text it belongs to, which is not a relationship a reader can
            see. It rides the path now, where the thing it describes is. */}
        {h.retractedList.slice(0, 40).map((r, i) => (
          <div key={`${r.path}:${r.line}:${i}`} className="retRow">
            <span className="retPath">
              {r.path}:{r.line}
              {r.heading ? <span className="retMark" title="passage carries its own heading">§</span> : null}
            </span>
            <span className="retText">{r.text}…</span>
          </div>
        ))}
      </Band>
    </div>
  );
}
