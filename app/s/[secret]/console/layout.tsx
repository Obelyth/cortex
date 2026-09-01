import { requireSecret } from "@/lib/gate";
import { consoleHealth, consoleProposals, consoleWatch } from "./loaders";
import { updateStatus, RELEASES_URL } from "@/lib/update-check";
import { Tabs } from "./tabs";
import { Clock } from "./clock";
import { Kinetic } from "./kinetic";
import "./theme.css";
import "./console.css";

// Every screen under this shell reads the live corpus — never cached, never static.
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * DIRECTION CONTRACT — console redesign, seed a5cebec8. Also emitted into the markup below so
 * a built page can be audited against it; this copy is the one you re-read on every edit.
 *
 * THESIS: a console that reads like a printed measurement sheet, not a dashboard. It refuses the
 *   category's filled card grid and rounded corners — but since the depth pass (design review,
 *   2026-09-01: "more dimension") the paper is physical: sheets rest raised on close ink shadows
 *   (offset + soft blur, colourless, never a glow, never a zero-blur slab), meters sink as
 *   wells, and the ink band casts onto the page on both edges.
 * OWN-WORLD: warm off-white paper, near-black ink, structure carried entirely by 1px hairlines and
 *   a dashed orange spine. Archivo Expanded for numerals, JetBrains Mono for every functional
 *   label. Colour exists only as a filled field carrying near-black text — never as ink. The
 *   orange CX block opens the masthead — the one place the mark is worn rather than measured.
 * KINETIC (refresh 2026-09-01, the chosen direction — A with B's CX block and ink band): motion
 *   is the mechanism settling, never decoration. Entrances run once, on scroll into view, on the
 *   house curve (0.22, 0.61, 0.36, 1): rules draw, chips print, numerals rise, fields flood.
 *   Hover shifts a row and raises its paper one step; nothing lifts, nothing glows.
 *   prefers-reduced-motion gets the finished sheet from first paint. Copy discipline: a section
 *   states its figure and window; every explanation lives one caret down, never open by default.
 * STORY: the operator learns whether the brain is alive before focusing their eyes, then finds the
 *   one thing needing a decision without scrolling for it.
 * FIRST VIEWPORT: a colossal note count at left, its identity and head SHA beside it in mono, a
 *   cyan LIVE field at right; below one hairline, a wide reading column of recent commits against
 *   a narrow full-height inbox field that collapses to a single line when empty.
 * FORM: masthead-over-asymmetric-split (comp C) carried by a numbered dashed spine (comp A),
 *   split by the full-bleed ink band (the corpus art).
 *
 * The gate here is defence in depth, not the gate: a layout's notFound() doesn't stop Next
 * from executing and serializing the sibling page, so every screen calls requireSecret()
 * itself before touching the corpus. Links between screens are relative; the secret never
 * appears in server-chosen markup.
 */
const CONTRACT = `<!-- IMPECCABLE DIRECTION CONTRACT · seed a5cebec8 · console · kinetic refresh 2026-09-01
THESIS: a printed measurement sheet, not a dashboard; refuses the filled card grid and rounded corners. DEPTH (2026-09-01): the paper is physical — sheets rest raised on close ink shadows (offset + soft blur, colourless, no glow, no zero-blur slab), meters sink as wells, the ink band casts on both edges.
OWN-WORLD: off-white paper, near-black ink, 1px hairlines and a dashed orange spine; Archivo Expanded numerals, JetBrains Mono labels; colour only as a filled field carrying near-black text, never as ink; the orange CX block opens the masthead.
KINETIC: motion is the mechanism settling — entrances run once on scroll into view (rules draw, chips print, numerals rise, fields flood) on 0.22/0.61/0.36/1; hover shifts a row one paper step, nothing lifts; reduced-motion gets the finished sheet.
COPY: a section states its figure and window; explanation lives one caret down, never open by default.
STORY: the operator sees whether the brain is alive at a glance, then finds the one thing needing a decision without hunting.
FIRST VIEWPORT: colossal note count left, identity and head SHA in mono beside it, cyan LIVE field right; below one hairline a wide commit column against a narrow inbox field that collapses when empty.
FORM: masthead over asymmetric split (comp C) on a numbered dashed spine (comp A), split by the full-bleed ink band.
FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, and DESIGN.md
-->`;

/**
 * The footer links only to pages this deployment actually serves — root-relative hrefs, so
 * they resolve on any host and carry nothing vendor-specific — plus the project's GitHub.
 */
const FOOT_LINKS = [
  { label: "Tools", href: "/tools" },
  { label: "Guide", href: "/guide" },
  { label: "GitHub", href: "https://github.com/Obelyth/cortex" },
];

export default async function ConsoleLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ secret: string }>;
}) {
  await requireSecret(params);

  // Concurrent: none depends on another, and this set sits in front of every console page.
  // Serial awaits stacked a GitHub round trip in front of an Upstash one for no reason.
  // updateStatus rides along: this footer is where an operator looks at their deployment,
  // so it is where the deployment says a newer release exists. Absence-on-failure: when the
  // probe cannot prove a latest version, the line carries only what the build itself knows.
  const [h, queued, watch, update] = await Promise.all([
    consoleHealth(),
    consoleProposals().catch(() => []),
    consoleWatch(),
    updateStatus(),
  ]);
  // All three live on the inbox, so the badge counts all three. A proposal waiting on a decision
  // is more urgent than a triage item, and a badge that ignored it would let a guest's
  // suggestion sit unseen — the failure mode that makes a review gate theatre. The watch items
  // count too, because a badge that says 1 over a queue showing 3 teaches you the numbers lie.
  const waiting = h.triage.length + queued.length + watch.length;
  const corpus = `${process.env.BRAIN_REPO ?? "brain"} · ${process.env.BRAIN_BRANCH ?? "main"}`;
  const build = process.env.VERCEL_GIT_COMMIT_SHA?.slice(0, 8) ?? "dev";

  return (
    <div className="conRoot">
      <div hidden dangerouslySetInnerHTML={{ __html: CONTRACT }} />
      {/* The pre-paint appearance script is gone with the light/dark toggle it served. The
          console has one ground now, so there is no wrong ground to flash. */}
      <Kinetic />
      <header className="conMast">
        <span className="conCx">CX</span>
        <span className="conWordmark">Cortex</span>
        <Tabs attention={waiting} />
        <span className="conSpacer" />
        <span className="conChip">
          <i className="conChipDot" aria-hidden />
          {h.totals.notes} notes · {corpus}
        </span>
        <Clock />
      </header>

      <main className="conBody">{children}</main>

      <footer className="conFoot">
        <span className="conFootMark">Cortex by Obelyth</span>
        <span className="conSpacer" />
        <span className="conFootTag">
          v{update.running} · build {build} · head {h.sha}
        </span>
        {update.behind && (
          <a className="conFootLink" href={RELEASES_URL} target="_blank" rel="noreferrer">
            v{update.latest} available — npm run update
          </a>
        )}
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
