import { Tabs } from "./tabs";
import { NoticesBell } from "./notices-tray";
import type { ReactNode } from "react";

export interface MastheadMode { text: string; tone: "live" | "warn" | "off" }

/**
 * The masthead (v2): identity · tabs · mode · notices. No clock, no second search. Presentational
 * and server-safe. The authenticated layout supplies its independently refreshed status slot;
 * scripts/dev/render-shell.tsx keeps rendering the same accepted fixture props on both grounds.
 */
export function Masthead({ secret, badge, mode, sha, commitUrl, status }: Readonly<{ secret: string; badge?: number; mode: MastheadMode; sha: string; commitUrl: string | null; status?: ReactNode }>) {
  return (
    <header className="conMast">
      <span className="conCx" aria-hidden>CX</span>
      <span className="conWordmark">Cortex</span>
      <Tabs badge={badge} />
      <span className="conSpacer" />
      {status ?? <span className="conMode" title="the mirror's state and the head it serves">
        <i className={`conModeDot conModeDot-${mode.tone}`} aria-hidden />
        {mode.text}
        {sha && (
          <>
            {" · "}
            {commitUrl ? (
              <a className="conModeSha" href={commitUrl} target="_blank" rel="noopener" title="open the commit on GitHub">{sha}</a>
            ) : (
              <span className="conModeSha">{sha}</span>
            )}
          </>
        )}
      </span>}
      <NoticesBell secret={secret} />
    </header>
  );
}
