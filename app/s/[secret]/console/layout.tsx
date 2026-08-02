import { requireSecret } from "@/lib/gate";
import { health } from "@/lib/health";
import { listCommits, type CommitInfo } from "@/lib/github";
import { Tabs } from "./tabs";
import { Clock } from "./clock";
import "./console.css";

// Every screen under this shell reads the live corpus — never cached, never static.
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * The console shell — design 1b: masthead + a permanent live ribbon, on every screen.
 *
 * The gate here is defence in depth, not the gate: a layout's notFound() doesn't stop Next
 * from executing and serializing the sibling page, so every screen calls requireSecret()
 * itself before touching the corpus. Links between screens are relative; the secret never
 * appears in markup.
 *
 * The ribbon is honest: cortex keeps no call log, so instead of pretending at per-call
 * telemetry it carries the ingest feed (real commits; every write is a commit) and the
 * summary counts from the same health() every screen reads.
 */
export default async function ConsoleLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ secret: string }>;
}) {
  await requireSecret(params);

  const h = await health();
  let commits: CommitInfo[] = [];
  try {
    commits = await listCommits(3);
  } catch {
    /* the ribbon degrades to counts only */
  }

  return (
    <div className="conRoot">
      <header className="conMast">
        {/* eslint-disable-next-line @next/next/no-img-element -- static asset, fixed size */}
        <img src="/brand/obelyth-emblem.png" alt="" width={28} height={28} className="conEmblem" />
        <span className="conWordmark">
          Cortex <span className="conBy">by OBELYTH</span>
        </span>
        <Tabs attention={h.triage.length} />
        <span className="conSpacer" />
        <span className="conSha">head {h.sha}</span>
        <Clock />
      </header>

      <div className="conRibbon">
        <span className="conLiveDot" aria-hidden />
        <span className="conLive">live</span>
        {commits.map((c) => (
          <span key={c.sha} className="conRibbonItem">
            <span className="conRibbonSha">{c.sha}</span> {c.message}
          </span>
        ))}
        <span className="conSpacer" />
        <span className="conRibbonSum">
          {h.totals.notes} notes · {h.totals.retractedBlocks} retracted · {h.triage.length} need
          attention
        </span>
      </div>

      <main className="conBody">{children}</main>

      <footer className="conFoot">CORTEX BY OBELYTH — DATA. INFRASTRUCTURE. ASSURED.</footer>
    </div>
  );
}
