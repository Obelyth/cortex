import { Suspense } from "react";
import { requireSecret } from "@/lib/gate";
import { opsBoard } from "@/lib/ops-board";
import { decisionItems } from "@/lib/ops-inbox";
import { consoleHealth, consoleProposals, consoleWatch } from "../loaders";
import { OpsDecisions, OpsDecisionsSkeleton } from "./ops-decisions";
import { OpsScreen } from "./ops-screen";
import "./ops.css";

export const dynamic = "force-dynamic";
export const metadata = { title: "Ops · Cortex console" };

/**
 * The landing screen (spec §5, §12), on v2 (approved console design): the strip on the band, the
 * register full width, and beneath it Decisions — the inbox, every item opening in the lens
 * with the buttons that fix it — beside the thirty-day timeline of receipts. A unit opens in the
 * lens too, with its facts, its receipts and its controls. Markup lives in ops-screen.tsx and
 * ops-client.tsx; the lens bodies in ops-lens.tsx.
 *
 * THE BOARD DOES NOT WAIT ON THE CORPUS (#136): the register renders from the ops tables; the
 * Decisions panel's three loaders read the whole brain and stream in behind the Suspense
 * boundary below, inside a static wrapper the client never re-renders.
 */
export default async function OpsPage({ params }: { params: Promise<{ secret: string }> }) {
  const secret = await requireSecret(params);
  const board = await opsBoard();
  return (
    <OpsScreen
      board={board}
      secret={secret}
      decisions={
        <div className="opsDecisionsWrap">
          <Suspense fallback={<OpsDecisionsSkeleton />}>
            <OpsDecisionsPanel secret={secret} />
          </Suspense>
        </div>
      }
    />
  );
}

/** Awaited on its own so the board does not wait on the corpus reads behind it. */
async function OpsDecisionsPanel({ secret }: { secret: string }) {
  const [h, proposals, watch] = await Promise.all([
    consoleHealth(),
    consoleProposals().catch(() => []),
    consoleWatch(),
  ]);
  return <OpsDecisions items={decisionItems([...h.triage, ...watch], proposals)} secret={secret} />;
}
