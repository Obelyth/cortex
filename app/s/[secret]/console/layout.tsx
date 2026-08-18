import { requireSecret } from "@/lib/gate";
import { health } from "@/lib/health";
import { listCommits, type CommitInfo } from "@/lib/github";
import { listProposals } from "@/lib/proposals";
import { updateStatus, RELEASES_URL } from "@/lib/update-check";
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
 * The utility bar under it names the corpus being read and carries the appearance switch; the
 * counts and the last write moved to the footer, where the design puts them.
 */
/**
 * The footer links only to pages this deployment actually serves. The previous row
 * (Legal / Privacy / Terms / Status) pointed at README anchors that were never written —
 * governance pages the release does not ship, which on a trust product reads as theatre.
 * Until that content exists, honest chrome is the public surfaces we really have: root-relative
 * hrefs, so they resolve on any host and carry nothing vendor-specific.
 */
const FOOT_LINKS = [
  { label: "Tools", href: "/tools" },
  { label: "Guide", href: "/guide" },
];

export default async function ConsoleLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ secret: string }>;
}) {
  await requireSecret(params);

  const h = await health();
  // Both live on the attention screen, so the badge counts both. A proposal waiting on a
  // decision is more urgent than a triage item, and a badge that ignored it would let a guest's
  // suggestion sit unseen — which is the failure mode that makes a review gate theatre.
  const waiting = h.triage.length + (await listProposals()).length;
  // The utility bar names the corpus this console is reading — the repo and branch, not a host.
  const corpus = `${process.env.BRAIN_REPO ?? "brain"} · ${process.env.BRAIN_BRANCH ?? "main"}`;
  // The footer's build line: the deployed commit when Vercel provides it, dev otherwise.
  const build = process.env.VERCEL_GIT_COMMIT_SHA?.slice(0, 8) ?? "dev";
  // This footer is where an operator looks at their deployment, so it is where the
  // deployment says a newer release exists. Absence-on-failure: when the probe cannot
  // prove a latest version, the line carries only what the build itself knows.
  const update = await updateStatus();
  let commits: CommitInfo[] = [];
  try {
    commits = await listCommits(3);
  } catch {
    /* the ribbon degrades to counts only */
  }

  return (
    <div className="conRoot">
      {/* Applied before paint so a reload never flashes the wrong ground. */}
      <script
        dangerouslySetInnerHTML={{
          __html:
            'try{var a=localStorage.getItem("cortex-appearance");if(a==="light"||a==="dark")document.documentElement.dataset.appearance=a}catch(e){}',
        }}
      />
      <header className="conMast">
        <svg width="28" height="28" viewBox="0 0 24 24" aria-hidden className="conEmblem">
          <g stroke="var(--bright)" strokeWidth="1.45" strokeLinecap="round">
            <line x1="12" y1="8" x2="12" y2="5.2" />
            <line x1="8.57" y1="14.06" x2="6.17" y2="15.51" />
            <line x1="15.43" y1="14.06" x2="17.83" y2="15.51" />
          </g>
          <path d="M12 8 L15.46 10 L15.46 14 L12 16 L8.54 14 L8.54 10 Z" fill="var(--bright)" />
          <circle cx="12" cy="2.9" r="2.3" fill="var(--accent)" />
          <circle cx="4.2" cy="16.7" r="2.3" fill="var(--bright)" />
          <circle cx="19.8" cy="16.7" r="2.3" fill="var(--bright)" />
        </svg>
        <span className="conWordmark">Cortex</span>
        <Tabs attention={waiting} />
        <span className="conSpacer" />
        <Clock />
      </header>

      <div className="conRibbon">
        <span className="conChip">
          <span className="conChipDot" aria-hidden />
          {corpus}
        </span>
        <span className="conRibbonSum">live corpus · read path verified</span>
        <span className="conSpacer" />
      </div>

      <main className="conBody">{children}</main>

      <footer className="conFoot">
        <span className="conFootMark">Cortex by Obelyth</span>
        <span className="conFootRule" />
        <span className="conFootTag">
          v{update.running} · build {build} · head {h.sha}
        </span>
        {update.behind && (
          <a className="conFootLink" href={RELEASES_URL} target="_blank" rel="noreferrer">
            v{update.latest} available — npm run update
          </a>
        )}
        <span className="conSpacer" />
        {/* New tab so the gated console stays open behind the public page. */}
        {FOOT_LINKS.map((l) => (
          <a key={l.label} className="conFootLink" href={l.href} target="_blank" rel="noreferrer">
            {l.label}
          </a>
        ))}
        <span className="conFootTag">© 2026 Obelyth</span>
      </footer>
    </div>
  );
}
