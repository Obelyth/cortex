import { requireSecret } from "@/lib/gate";
import { Deployment } from "../deployment";
import { health } from "@/lib/health";
import { consoleWatch } from "../loaders";
import { getContext } from "@/lib/brain";
import { listCommits, type CommitInfo } from "@/lib/github";
import { listProposals } from "@/lib/proposals";
import { readCalls, SCOPE_NOTE } from "@/lib/calls";
import { readSettings, safeActiveReader, readerCards } from "@/lib/settings";
import { readGuestPolicy } from "@/lib/guest";
import { mirrorPulse, accessPulse, bubblePulse, temperaturePulse } from "@/lib/pulse";
import { providerConfigured, providerOf } from "@/lib/reader";
import { Reveal } from "../reveal";
import { safeText } from "@/lib/frontmatter";
import { ModelSelect } from "./model-select";
import { ActivityChart, type Ranges } from "./activity-chart";
import { CorpusField, type Mark } from "./corpus-field";
import styles from "../console.module.css";

export const dynamic = "force-dynamic";
export const maxDuration = 60;
export const metadata = { title: "Overview · Cortex console" };

/**
 * Overview — the design file's, panel for panel: a hero card (memory ring, the three counts,
 * the answering-model control), activity, connections, then the rail of recent saves, the guest
 * budget and how answers checked out. What changed from the design is only what honesty
 * requires: every number states the window it really covers, and WEEK/MONTH stay disabled until
 * the log can attest them.
 */

const RING_R = 44;

/**
 * The ring used to read "% full" against a 150k-token ceiling, and its own caption had to admit
 * the number meant nothing: the brain has no size limit, so a full read is a cost nobody pays
 * outside `full=true` and the eval. A gauge that has to explain it is not a gauge is just an
 * alarming shape — it sat at 98% while the system was healthy.
 *
 * What replaces it is the number this whole architecture exists to hold down: how much of the
 * brain every session actually loads. `brain_context` is paid on every boot on every surface, and
 * its denominator is the corpus itself, so there is no invented ceiling to argue with. Low is
 * good and rising is the real warning — it means the router, the temperatures and the log rollup
 * have stopped keeping pace with what is being written.
 */
function Ring({ pct }: Readonly<{ pct: number | null }>) {
  // null is "the boot path did not answer", which is a different fact from 0% and must not be
  // drawn as a reassuringly empty ring.
  const shown = pct === null ? 0 : Math.max(0, Math.min(100, pct));
  return (
    <div className="ringBox">
      {/* The arc was a cyan→pink gradient, which broke the product's one visual rule on the one
          element that names it: cyan marks live data, and the memory ring is the live thing. It
          was also worse in practice than in source — at a healthy 4% the arc is a single short
          rounded dash, and it landed in the pink end, so the gauge showed NO cyan precisely when
          the brain was healthiest. One flat live-field stroke, and a square cap so a small value
          reads as a measured quantity rather than a bead. */}
      <svg viewBox="0 0 112 112" width="112" height="112" role="img" aria-label={`Every session loads ${shown}% of the brain`}>
        <circle cx="56" cy="56" r={RING_R} fill="none" stroke="var(--rule-soft)" strokeWidth="7" />
        <circle
          className="ringArc"
          cx="56" cy="56" r={RING_R} fill="none"
          stroke="var(--field-live)" strokeWidth="7" strokeLinecap="butt"
          pathLength={100}
          strokeDasharray={`${shown} ${100 - shown}`}
          transform="rotate(-90 56 56)"
        />
      </svg>
      <div className="ringLabel">
        <div>
          <div className="ringPct">{pct === null ? "—" : `${shown}%`}</div>
          <div className="ringSub">{pct === null ? "boot unreadable" : "loaded per session"}</div>
        </div>
      </div>
    </div>
  );
}

export default async function Overview({
  params,
}: {
  params: Promise<{ secret: string }>;
}) {
  await requireSecret(params);
  const now = Date.now();
  const [h, callWin, settings, guest, proposals, pipe, reads, bubble, temps, boot, watch] = await Promise.all([
    health(),
    readCalls(2_592_000_000, now),
    readSettings(),
    readGuestPolicy(now),
    listProposals().catch(() => []),
    mirrorPulse(),
    accessPulse(),
    bubblePulse(),
    temperaturePulse(),
    // The real boot payload, so the hero measures what a session pays rather than estimating it.
    // Failing soft matters here more than most: this is a dashboard, and a console that 500s
    // because it could not price itself would be reporting a problem by becoming one.
    getContext().catch(() => null),
    // The mechanical watch items (lib/inbox.ts) — counted here so this rail, the masthead badge
    // and the attention queue cannot disagree about how many things the inbox holds.
    consoleWatch(),
  ]);
  let commits: CommitInfo[] = [];
  try {
    commits = await listCommits(8);
  } catch {
    /* the saves feed degrades to empty */
  }

  const t = h.totals;
  // Measured, not modelled: this is the exact string brain_context hands back, so the ring cannot
  // drift from what a session is really charged. Everything it touches — corpus, bubble, scores —
  // was already fetched above, so the marginal cost is a cache read. If the boot path is failing
  // the number is unknowable rather than zero, and the hero says so instead of drawing an
  // encouraging empty ring.
  const bootTokens = boot === null ? null : Math.round(boot.length / 4);
  const pct = bootTokens === null || t.tokens === 0 ? null : Math.round((bootTokens / t.tokens) * 100);
  const urgent = h.triage.filter((q) => q.sev === "crit").length;
  const inbox = h.triage.length + watch.length + proposals.length;

  const { rows, covers, durable, source } = callWin;
  const window =
    covers < 60_000
      ? "log just started"
      : `log covers ${covers < 3_600_000 ? `${Math.round(covers / 60_000)} min` : covers < 172_800_000 ? `${Math.round(covers / 3_600_000)} hr` : `${Math.round(covers / 86_400_000)} d`}`;
  // Three bucketings of the same log. A range wider than the log stays clickable — its
  // coverage note says what the bars can attest instead of a disabled control saying nothing.
  const bucketize = (n: number, step: number, label: (i: number) => string) =>
    Array.from({ length: n }, (_, i) => {
      const from = now - (n - i) * step;
      return {
        n: rows.filter((r) => r.ts >= from && r.ts < from + step).length,
        label: label(n - i),
      };
    });
  const dayName = (back: number) =>
    new Date(now - back * 86_400_000).toLocaleDateString("en-US", { weekday: "short" });
  const dateName = (back: number) =>
    new Date(now - back * 86_400_000).toLocaleDateString("en-US", { month: "short", day: "numeric" });
  const day = bucketize(24, 3_600_000, (b) => `${b} h ago`);
  const week = bucketize(7, 86_400_000, (b) => dayName(b - 1));
  const month = bucketize(30, 86_400_000, (b) => dateName(b - 1));
  const rangeNote = (spanMs: number) => (covers >= spanMs ? null : window);
  const ranges: Ranges = {
    day: {
      bars: day.map((b) => b.n), labels: day.map((b) => b.label),
      axis: ["-24h", "-18h", "-12h", "-6h", "now"], note: rangeNote(86_400_000),
    },
    week: {
      bars: week.map((b) => b.n), labels: week.map((b) => b.label),
      axis: week.map((b) => b.label), note: rangeNote(604_800_000),
    },
    month: {
      bars: month.map((b) => b.n), labels: month.map((b) => b.label),
      axis: [month[0], month[7], month[15], month[22], month[29]].map((b) => b.label),
      note: rangeNote(2_592_000_000),
    },
  };

  // The answering-model control. Every known model is listed the way the design lists them —
  // keyless ones present but marked, so the menu teaches what a key would unlock.
  const { active, error: resolveError } = await safeActiveReader(settings);
  const cards = readerCards(settings, active);
  const options = cards
    .filter((c) => !c.disabled)
    .map((c) => ({ model: c.model, configured: c.configured }));
  const activeConfigured = active ? providerConfigured(providerOf(active.model)!) : false;

  const guestOpen = Boolean(process.env.GUEST_PATH_SECRET?.trim());
  const doorAgo = (key: "terminal" | "connector" | "guest") => {
    const mine = rows.filter((r) => r.surface === key);
    return mine.length ? Math.max(...mine.map((r) => r.ts)) : null;
  };
  // One relative-time dialect for every card on this page. "just now" carries its own
  // completeness — never "now ago" — and an unparseable timestamp is a dash, not "— ago".
  const ago = (ms: number) => {
    const m = Math.floor((now - ms) / 60_000);
    return m < 1 ? "just now" : m < 60 ? `${m} min ago` : m < 2880 ? `${Math.floor(m / 60)} hr ago` : `${Math.floor(m / 1440)} d ago`;
  };
  const agoIso = (iso: string) => {
    const ts = new Date(iso).getTime();
    return Number.isFinite(ts) ? ago(ts) : "—";
  };

  const connections = [
    { key: "terminal" as const, name: "Terminal", sub: "Claude Code · Cursor", grant: "read + write", gold: false },
    { key: "connector" as const, name: "Claude app", sub: "claude.ai · custom connector", grant: "read + write", gold: false },
    {
      key: "guest" as const,
      name: "Guests",
      sub: guestOpen ? "any assistant with the url" : "no guest door open",
      grant: "ask only",
      gold: true,
    },
  ].map((c) => ({ ...c, last: c.key === "guest" && !guestOpen ? null : doorAgo(c.key) }));

  // How answers checked out — the friendly grouping the design uses, with the precise stamps
  // one caret down. RIGHT = proven current (VERIFIED + CORRECTED); WRONG = UNVERIFIED.
  const asks = rows.filter((r) => r.tool === "brain_ask" && r.ts >= now - 86_400_000);
  const checked = [
    // --field-*, not --ok/--crit/--warn: the paper theme collapses the semantic status vars onto
    // ink-900, so only the field family actually carries colour inside .conRoot.
    { k: "right", n: asks.filter((r) => r.stamp === "VERIFIED" || r.stamp === "CORRECTED").length, c: "var(--field-ok)" },
    { k: "wrong", n: asks.filter((r) => r.stamp === "UNVERIFIED").length, c: "var(--field-crit)" },
    { k: "not in memory", n: asks.filter((r) => r.stamp === "NOT IN BRAIN").length, c: "var(--ink-400)" },
    { k: "errors", n: asks.filter((r) => r.stamp === "ERROR").length, c: "var(--field-warn)" },
  ];
  const checkedTotal = checked.reduce((a, r) => a + r.n, 0);
  const stamps = [
    "VERIFIED", "CORRECTED", "SUPERSEDED", "PARTIALLY VERIFIED", "NOT IN BRAIN", "UNVERIFIED", "ERROR",
  ].map((s) => ({ s, n: asks.filter((r) => r.stamp === s).length }));

  const mirrorLive = pipe !== null && pipe.state === "live";

  // The dot field: every block in the corpus as one mark, in note order, solid where the block
  // is retracted. Capped so a very large brain does not ship tens of thousands of nodes to the
  // client — past ~1,800 the field reads as texture anyway and the cap is stated in the caption
  // rather than silently truncating.
  const FIELD_CAP = 1800;
  // `strip` is the note's own per-block character map — "." live, "x" retracted — the same
  // source the corpus ledger renders its ticks from. Reusing it means the art cannot drift from
  // the ledger: they are the same measurement at two scales. Each mark carries its note and
  // block number so the field is addressable rather than decorative.
  const blockTotal = h.notes.reduce((a, n) => a + n.blocks, 0);
  const blockMarks: Mark[] = [];
  for (const n of h.notes) {
    for (let i = 0; i < n.strip.length; i++) {
      if (blockMarks.length >= FIELD_CAP) break;
      blockMarks.push({ p: n.path, b: i + 1, x: n.strip[i] === "x" });
    }
    if (blockMarks.length >= FIELD_CAP) break;
  }

  return (
    <div className="ovSheet">
      {/* 00 — the thesis viewport. One count at a scale nothing else on the page approaches, its
          identity beside it, and whether the thing is alive. The four co-equal 42px numerals this
          replaces answered no question in particular; a console whose first job is "confirm it's
          alive" should answer that before the reader focuses. */}
      <header className="ovMast" data-cx="rise">
        <div className="ovMastN" data-cx="print" style={{ "--cx-d": "150ms" } as React.CSSProperties}>{t.notes}</div>
        <div className="ovMastMeta">
          <div className="ovMastLead">notes in the brain</div>
          <div className="ovMastLine">
            <b>{t.retractedBlocks}</b> corrections — crossed out, kept on the page
          </div>
          <div className="ovMastLine">
            head <b>{h.sha}</b> · {h.byDir.length} folders · {t.tokens.toLocaleString()} tokens
          </div>
          <div className="ovMastLine">
            <b>{reads ? reads.last24h : "—"}</b> notes served in 24 h
            {reads && (reads.prior24h > 0 || reads.last24h > 0)
              ? ` · ${reads.last24h >= reads.prior24h ? "+" : ""}${reads.last24h - reads.prior24h} vs prior`
              : reads
                ? " · collecting"
                : " · telemetry unreachable, serving is unaffected"}
          </div>
        </div>
        <div className={mirrorLive ? "ovLive" : "ovLive ovLiveOff"}>
          <div className="ovLiveHead">
            {pipe === null
              ? "mirror unreachable"
              : pipe.state === "live"
                ? "live — serving from mirror"
                : pipe.state === "healing"
                  ? "healing to git head"
                  : "serving from tarball"}
          </div>
          <div className="ovLiveLine">
            {pipe === null
              ? "reads fall back to the repo tarball, exactly as before the mirror existed"
              : pipe.state === "off"
                ? "no Supabase env — every read hauls the repo tarball, exactly as before the mirror"
                : (
                  <>
                    at commit <b>{h.sha}</b>
                  </>
                )}
          </div>
          <div className="ovLiveLine">
            session boot cost{" "}
            <b>{bootTokens === null ? "unknown" : `${pct}%`}</b>
            {bootTokens === null
              ? " — boot path unreadable this render"
              : ` · ${bootTokens.toLocaleString()} of ${t.tokens.toLocaleString()} tokens`}
          </div>
        </div>
      </header>

      {/* The art. Not decoration and not stock: one mark per block in the corpus, solid where a
          passage was retracted, cyan for the notes served in the last day. The reference's
          halftone portraits are answered here by the only imagery this product can honestly
          ship — the brain itself, at page scale. */}
      <section className="band bandInk">
        <div className="gridField" aria-hidden />
        <div className="bandInner" data-cx="rise">
          <div className="secHead">
            <span className="secTag" data-cx="print" style={{ "--cx-d": "120ms" } as React.CSSProperties}>
              <span className="secTagN">01</span>
              <span className="secTagLabel">The corpus</span>
            </span>
            <h2 className="secTitle">
              {t.notes} notes, <b>{blockTotal.toLocaleString()} blocks,</b>
              <br />
              {t.retractedBlocks} of them crossed out and kept.
            </h2>
            <p className="secLede">
              One mark per block. Solid marks are retracted passages — this brain keeps its
              corrections on the page rather than editing them away, which is why a stale answer
              can be caught quoting one.
            </p>
          </div>
          <CorpusField marks={blockMarks} total={blockTotal} shown={blockMarks.length} />
        </div>
      </section>

      <div className="ovSplit">
        <div className="ovRead">
          {/* The old hero card is gone: the masthead above now carries the counts, the head SHA
              and the boot cost, and repeating them here was the same facts twice on one screen.
              The ring survives as the one gauge that shows a proportion rather than a number,
              beside the control it explains. */}
          <section className="card" data-cx="rise">
            <div className={styles.sectionHead}>
              <span className={styles.label}>Session boot cost</span>
              <span className={styles.fig}>{bootTokens === null ? "unreadable" : `${pct}%`}</span>
            </div>
            <div className="ringWrap">
              <Ring pct={pct} />
              <div>
                <div className="heroCap" style={{ marginTop: 0 }}>
                  {bootTokens === null ? "unavailable" : `${bootTokens.toLocaleString()} tokens`}
                  <br />of {t.tokens.toLocaleString()} in the brain
                </div>
                <div className={styles.note}>
                  <Reveal label="what this measures">
                    What every session actually loads before you type anything — profile, the router
                    line for each note, and the working bubble — measured against the whole brain.
                    This is the number the router and the hot/warm/cold split exist to hold down, and
                    it is paid on every boot on every surface. Low is good. Rising is the warning
                    worth acting on: it means new writing is outpacing what gets condensed.
                  </Reveal>
                </div>
              </div>
              <div className="heroModel">
                <div className="heroLabel">Answering model</div>
                <ModelSelect
                  options={options}
                  current={active ? active.model : ""}
                  writable={settings.source === "store"}
                />
                <div className={styles.note}>
                  {resolveError
                    ? resolveError
                    : active && !activeConfigured
                      ? "this model's key is missing — the next ask will error"
                      : "plain reads never touch a model"}
                </div>
              </div>
            </div>
          </section>

      <div className="ovGrid">
        <div className="ovCol">
          <section className="card cardInk" data-cx="rise" style={{ "--cx-d": "60ms" } as React.CSSProperties}>
            <div className={styles.sectionHead}>
              <span className={styles.label}>Working state</span>
              <span className={styles.fig}>
                {bubble ? `${bubble.total} open` : "unavailable"}
              </span>
            </div>
            {bubble && bubble.items.length > 0 && (
              <>
                {bubble.items.slice(0, 6).map((it, i) => (
                  <div key={it.id} className="wsRow" data-cx="rise" style={{ "--cx-d": `${120 + i * 70}ms` } as React.CSSProperties}>
                    <span className="wsId">{it.id}</span>
                    <span className={`wsKind wsKind${it.kind === "focus" ? "Focus" : it.kind === "handoff" ? "Handoff" : it.kind === "question" ? "Question" : ""}`}>
                      {it.kind.toUpperCase()}
                    </span>
                    <span className="wsBody">
                      {safeText(it.body, 300)}
                      <span className="wsDrill">
                        <Reveal label="detail">
                          #{it.id} · added {agoIso(it.created_at)} via {safeText(it.surface, 20) || "unknown"} · from any
                          session: brain_bubble update {it.id} · brain_bubble file {it.id} + note path · brain_bubble drop {it.id}
                        </Reveal>
                      </span>
                    </span>
                    <span className="wsMeta">
                      {safeText(it.project, 40) ? `${safeText(it.project, 40)} · ` : ""}
                      {agoIso(it.touched_at)}
                    </span>
                  </div>
                ))}
                {(bubble.total > 6 || bubble.swept > 0) && (
                  <div className={styles.note}>
                    {bubble.total > 6 ? `${bubble.total - 6} more` : ""}
                    {bubble.total > 6 && bubble.swept > 0 ? " · " : ""}
                    {bubble.swept > 0 ? `${bubble.swept} just aged out (untouched 14+ days)` : ""}
                  </div>
                )}
                <div className={styles.note}>
                  <Reveal label="manage">
                    update · file · drop from any session with brain_bubble — brain_bubble list shows
                    everything; items untouched 14 days age out on their own
                  </Reveal>
                </div>
              </>
            )}
            {bubble && bubble.items.length === 0 && (
              <div className={styles.empty}>
                nothing marked in progress — any session can add with brain_bubble
              </div>
            )}
            {!bubble && <div className={styles.empty}>bubble unreachable this render — sessions still boot, degraded to log recap</div>}
          </section>

          <section className="card" data-cx="rise" style={{ "--cx-d": "120ms" } as React.CSSProperties}>
          <ActivityChart ranges={ranges} />
          {(covers < 86_400_000 || source !== "store") && (
            <div className={styles.note}>
              {covers < 86_400_000 ? `${window} — bars outside it are silence, not zero calls. ` : ""}
              {source === "unconfigured" && `No durable store — ${SCOPE_NOTE}.`}
              {source === "unreachable" && `Store unreachable this render — ${SCOPE_NOTE}.`}
            </div>
          )}
        </section>

        <section className="card" data-cx="rise" style={{ "--cx-d": "180ms" } as React.CSSProperties}>
          <div className={styles.sectionHead}>
            <span className={styles.label}>Connections</span>
            <a className={styles.railLink} href="settings">set up</a>
          </div>
          <div className={styles.note}>
            <Reveal label="what counts">
              last call per door · this environment — saves in the rail are door-blind
            </Reveal>
          </div>
          {connections.map((c) => (
            <div key={c.key} className="connRow">
              {/* Live means TODAY. A month-old call wearing a presence-green dot beside "2 d ago"
                  reads as a contradiction, and the dot must never outrank the words. */}
              <span className={c.last && now - c.last < 86_400_000 ? styles.dotLive : styles.dotIdle} />
              <span>
                <div className="connName">{c.name}</div>
                <div className="connSub">
                  {c.sub}
                  {c.last ? ` · ${ago(c.last)}` : ""}
                </div>
              </span>
              <span className={`connGrant${c.gold ? " connGrantGold" : ""}`}>{c.grant}</span>
            </div>
          ))}
        </section>
      </div>

      <div className="ovCol">
        <section className="card" data-cx="rise">
          <div className={styles.sectionHead}>
            <span className={styles.label}>Memory pipeline</span>
            {pipe && pipe.state === "live" && <span className={styles.fig} style={{ color: "var(--accent)" }}>in sync</span>}
            {pipe && pipe.state === "healing" && <span className={styles.fig} style={{ color: "var(--warn)" }}>healing</span>}
            {pipe && pipe.state === "off" && <span className={styles.fig}>mirror off</span>}
            {!pipe && <span className={styles.fig}>unreachable</span>}
          </div>
          {pipe && pipe.state !== "off" && (
            <>
              <div className="pipeRow">
                <span className={pipe.state === "live" ? styles.dotLive : styles.dotIdle} />
                <span className="pipeName">git → Postgres mirror</span>
                <span className="pipeFig">{pipe.notes ?? "—"} notes</span>
              </div>
              <div className="pipeRow">
                <span className="pipeName pipeSub">served at commit</span>
                <span className="pipeFig">{(pipe.mirrorHead ?? "—").slice(0, 8)}</span>
              </div>
              <div className="pipeRow">
                <span className="pipeName pipeSub">last reconciled</span>
                <span className="pipeFig">{pipe.syncedAt ? agoIso(pipe.syncedAt) : "—"}</span>
              </div>
              {pipe.state === "healing" && (
                <div className={styles.note}>behind the repo — the next read patches it forward; reads stay served meanwhile</div>
              )}
              {reads && reads.byTool.length > 0 && (
                <>
                  <div className={styles.note}>
                    notes served · 24 h · every surface: {reads.byTool.map((x) => `${x.tool.replace("brain_", "")} ${x.n}`).join(" · ")}
                    {reads.basis < reads.last24h ? ` (breakdown from the ${reads.basis} most recent)` : ""}
                  </div>
                  {reads.topNotes.length > 0 && (
                    <div className={styles.note}>
                      most read: {reads.topNotes.slice(0, 3).map((x) => `${x.path.split("/").pop()} ×${x.n}`).join(" · ")}
                    </div>
                  )}
                </>
              )}
            </>
          )}
          {temps && (
            <>
              <div className="pipeRow">
                <span className="pipeName pipeSub">what every session loads</span>
                <span className="pipeFig">
                  {temps.hot} hot · {temps.warm} warm{temps.cold > 0 ? ` · ${temps.cold} cold` : ""}
                </span>
              </div>
              <div className={styles.note}>
                {temps.cold === 0 ? (
                  "nothing cold yet — every note is recent enough to ride the router"
                ) : (
                  <Reveal label={`the cold list (${temps.cold})`}>
                    {`${temps.cold} note${temps.cold === 1 ? "" : "s"} ${temps.cold === 1 ? "stays" : "stay"} out of context and one query away${
                      temps.coldest.length
                        ? `${temps.cold > temps.coldest.length ? `, including` : `:`} ${temps.coldest.map((c) => c.path.split("/").pop()).join(" · ")}`
                        : ""
                    }`}
                  </Reveal>
                )}
              </div>
              {temps.pendingDeletions > 0 && (
                <div className={styles.note}>
                  {temps.pendingDeletions} deletion candidate{temps.pendingDeletions === 1 ? "" : "s"} awaiting your call —
                  nothing is ever deleted automatically. <a className={styles.railLink} href="attention">review</a>
                </div>
              )}
            </>
          )}
          {pipe && pipe.state === "off" && (
            <div className={styles.empty}>no Supabase env — every read hauls the repo tarball, exactly as before the mirror</div>
          )}
          {!pipe && <div className={styles.empty}>state unreadable this render — reads fall back to the tarball on their own</div>}
        </section>

        <section className="card" data-cx="rise" style={{ "--cx-d": "60ms" } as React.CSSProperties}>
          <div className={styles.label}>Recent saves</div>
          {commits.slice(0, 5).map((c, i) => (
            <div key={c.sha} className={styles.commitRow} data-cx="rise" style={{ "--cx-d": `${100 + i * 50}ms` } as React.CSSProperties}>
              <span className={styles.sha}>{c.sha}</span>
              <span className={styles.msg}>{c.message}</span>
              <span className={styles.agoCol}>{agoIso(c.date)}</span>
            </div>
          ))}
          {commits.length === 0 && <div className={styles.empty}>save history unreachable</div>}
        </section>

        <section className="card" data-cx="rise" style={{ "--cx-d": "120ms" } as React.CSSProperties}>
          {guestOpen ? (
            <>
              <div className={styles.sectionHead}>
                <span className={styles.label}>Guest asks today</span>
                <span className={styles.fig}>
                  {guest.usedToday ?? "?"} / {guest.dailyAsks}
                </span>
              </div>
              <span className="gradMeter" data-cx="flood" style={{ "--cx-d": "200ms" } as React.CSSProperties}>
                <i style={{ width: `${Math.min(100, ((guest.usedToday ?? 0) / guest.dailyAsks) * 100)}%` }} />
              </span>
              {guest.usedToday === null && (
                <div className={styles.note}>counter unreachable — the budget still enforces</div>
              )}
            </>
          ) : (
            <>
              <div className={styles.label}>Guest asks today</div>
              <div className={styles.empty}>
                no guest door open — <a className={styles.railLink} href="settings">open one</a>
              </div>
            </>
          )}
        </section>

        <section className="card" data-cx="rise">
          <div className={styles.sectionHead}>
            <span className={styles.label}>How answers checked out</span>
            {asks.length > 0 && (
              <span className={styles.fig}>
                {asks.length} · {covers < 86_400_000 ? window.replace("log covers ", "") : "24 h"}
              </span>
            )}
          </div>
          {asks.length === 0 ? (
            <div className={styles.empty}>
              no asks in the last 24 h on this environment — the stamps return with the next brain_ask
            </div>
          ) : (
          <>
          {checkedTotal > 0 && (
            <div className="stackBar" data-cx="flood" style={{ "--cx-d": "180ms" } as React.CSSProperties}>
              {checked.filter((r) => r.n > 0).map((r) => (
                <i key={r.k} style={{ width: `${(r.n / checkedTotal) * 100}%`, background: r.c }} />
              ))}
            </div>
          )}
          <div className="vGrid">
            {checked.map((r, i) => (
              <div key={r.k} className="vCell" data-cx="print" style={{ "--cx-d": `${240 + i * 90}ms` } as React.CSSProperties}>
                <div className="vNum">
                  <i style={{ background: r.c }} />
                  {r.n}
                </div>
                <div className="vLab">{r.k}</div>
              </div>
            ))}
          </div>
          <div className={styles.note}>
            <Reveal label="the precise stamps">
              right = VERIFIED + CORRECTED · wrong = UNVERIFIED.{" "}
              {stamps.map((x) => `${x.s} ${x.n}`).join(" · ")}. SUPERSEDED and PARTIALLY
              VERIFIED count toward neither — they are warnings, not verdicts.
            </Reveal>
          </div>
          </>
          )}
        </section>
      </div>

          {/* Moved off Settings: which keys are present and which stores are reachable is system
              state, not a control. Overview's job is confirming the thing is alive, and this is
              the part of that answer nobody could act on anyway. */}
          <Deployment />
        </div>
        </div>

        {/* The inbox rail. Job two of the four this console exists for, and it used to be a panel
            you scrolled to — on the Attention screen it opened with "Proposals · 0 pending" ABOVE
            the only actionable item. Here a waiting decision is the second-loudest thing on the
            page after the count itself, and zero collapses to one quiet line rather than spending
            the loudest element on nothing. */}
        {inbox > 0 ? (
          <aside className="ovInbox" data-cx="print">
            <div className="ovInboxHead">Inbox</div>
            <div className="ovInboxN">{inbox}</div>
            {urgent > 0 && (
              <div className="ovInboxRow">
                <b>{urgent}</b> urgent — needs a decision now
              </div>
            )}
            {h.triage.length - urgent + watch.length > 0 && (
              <div className="ovInboxRow">
                <b>{h.triage.length - urgent + watch.length}</b> watch — corpus items worth a look
              </div>
            )}
            {proposals.length > 0 && (
              <div className="ovInboxRow">
                <b>{proposals.length}</b> guest {proposals.length === 1 ? "proposal" : "proposals"} — accepting commits
              </div>
            )}
            <a className="ovInboxLink" href="attention">
              open inbox
            </a>
          </aside>
        ) : (
          <aside className="ovInbox ovInboxQuiet">
            inbox clear — nothing waiting on a decision
          </aside>
        )}
      </div>
    </div>
  );
}
