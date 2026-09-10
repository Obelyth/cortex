import type { ReactNode } from "react";
import { degradeLine, stripFigures, type Board } from "@/lib/ops-board";
import { OpsClient } from "./ops-client";
import { Devices } from "./devices";

/**
 * The Ops screen's markup (v2), with its data handed in. page.tsx reads the ledger and renders
 * this; scripts/dev/render-ops.tsx renders it from fixtures on both grounds, so the layout can
 * be looked at without a database, a GitHub token or a deploy.
 *
 * Top to bottom: the strip on the band — four figures, each stating its window — then the
 * register as one full-width instrument panel, then Decisions beside the Timeline. The
 * register, the timeline and the lens bodies are the client's (ops-client.tsx); the strip and
 * the degrade line are static, because a board is either counted or it is not.
 */
export function OpsScreen({ board, secret, decisions, initialOpenId }: Readonly<{ board: Board; secret: string; decisions: ReactNode; initialOpenId?: string | null }>) {
  const cells = stripFigures(board);
  const degraded = degradeLine(board);
  return (
    <div className="opsScreen">
      <h1 className="srOnly">Ops</h1>
      <div className={`opsStrip${degraded ? " opsStripOff" : ""}`}>
        <dl className="opsStripIn">
          {cells.map((c) => (
            <div key={c.label} className={`opsCell${c.crit ? " opsCellCrit" : ""}`}>
              <dt className="opsCellLabel">{c.label}</dt>
              <dd className="opsCellFig">{c.figure}</dd>
              <dd className="opsCellMeta">{c.meta}</dd>
            </div>
          ))}
        </dl>
      </div>
      {/* A degraded board prints dashes above and says why here: nothing counted, nothing shown. */}
      {degraded && <p className="opsDegrade">{degraded}</p>}
      <div className="opsBody">
        <OpsClient board={board} secret={secret} decisions={decisions} initialOpenId={initialOpenId} />
        <Devices />
      </div>
    </div>
  );
}
