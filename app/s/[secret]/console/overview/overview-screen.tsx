import type { MirrorPulse } from "@/lib/pulse";
import { agoIso, type Activity, type Checked, type Door, type DotField, type Pipeline, type Save } from "@/lib/overview";
import { CUT_OFF_CAVEAT } from "@/lib/trends";
import { BootRing } from "./boot-ring";
import { CorpusField } from "./corpus-field";
import { ActivityChart } from "./activity-chart";
import { ReaderSelect } from "./reader-select";
import { WorkingState } from "./working-state";
import { Saves } from "./saves";

/**
 * The Overview screen's markup (v2), with its data handed in. page.tsx reads the loaders and
 * renders this; scripts/dev/render-overview.tsx renders it from fixtures on both grounds so the
 * layout can be looked at without a database, a GitHub token or a deploy.
 *
 * Nine instruments, as the canvas draws them: the masthead figure (W07), the dot field (W08),
 * boot cost + reader (W09), activity (W10), working state (W11), the memory pipeline (W12),
 * doors (W13), recent saves (W14), how answers checked out (W15). Every figure states its
 * window; a source that is off says which mode it is in; nothing here is a number a loader did
 * not return. Entrances ride data-cx on these server nodes; the client islands inside carry none.
 */
export interface OverviewProps {
  now: number;
  /** The head, eight chars, and where it lives. */
  sha: string;
  commitUrl: string | null;
  commitBase: string | null;
  notes: number;
  retracted: number;
  folders: number;
  tokens: number;
  served: { last24h: number; prior24h: number } | null;
  mirror: MirrorPulse | null;
  boot: { tokens: number; pct: number } | null;
  field: DotField;
  activity: Activity;
  reader: { current: string; options: Array<{ id: string; label: string; disabled: boolean }>; writable: boolean; note: string };
  pipeline: Pipeline;
  doors: Door[];
  saves: Save[];
  checked: Checked;
  /** "24 h", or what the log covers when that is less. */
  checkedWindow: string;
  /** What the call log covers, as a noun phrase — the doors and the saves panel state it too. */
  logWindow: string;
}

export function OverviewScreen(p: Readonly<OverviewProps>) {
  const live = p.mirror !== null && p.mirror.state === "live";
  // Composed in the attribute rather than held in a string, so the classes test reads them where
  // every other class on this screen is read: off whenever the mirror is not live, warn whenever
  // it is unreachable or behind.
  const floodOff = p.mirror === null || p.mirror.state !== "live";
  const floodWarn = p.mirror === null || p.mirror.state === "healing";
  const mirrorHead = p.mirror === null ? "mirror unreachable" : p.mirror.state === "live" ? "live — serving from mirror" : p.mirror.state === "healing" ? "healing to git head" : "serving from tarball";
  const delta = p.served
    ? p.served.prior24h > 0 || p.served.last24h > 0
      ? `${p.served.last24h - p.served.prior24h >= 0 ? "+" : ""}${p.served.last24h - p.served.prior24h} vs prior 24 h`
      : "collecting"
    : "telemetry unreachable, serving is unaffected";
  const sha = p.commitUrl ? <a className="ovSha" href={p.commitUrl} target="_blank" rel="noopener" title="open the commit on GitHub">{p.sha}</a> : <b>{p.sha}</b>;

  return (
    <div className="ovRoot">
      {/* 00 — the thesis viewport: one count at a scale nothing else approaches, its identity
          beside it, and whether the thing is alive. */}
      <header id="overview-summary" className="ovMast" data-cx="rise" data-cx-section tabIndex={-1}>
        <div className="ovMastN">{p.notes}</div>
        <div className="ovMastMeta">
          <h1 className="ovMastLead">notes in the brain</h1>
          <div className="ovMastLines">
            <div><b>{p.retracted}</b> corrections — crossed out, kept on the page</div>
            <div>head {sha} · {p.folders} folders · ~{p.tokens.toLocaleString()} estimated body tokens</div>
            <div><b>{p.served ? p.served.last24h : "—"}</b> notes served in 24 h · {delta}</div>
          </div>
        </div>
        {/* The live field. Cyan marks live data and this is the largest instance on the page —
            so when the mirror is not live the field withdraws rather than announcing in cyan. */}
        <div className={`ovFlood${floodOff ? " ovFloodOff" : ""}${floodWarn ? " ovFloodWarn" : ""}`} data-cx="flood">
          <div className="ovFloodHead"><i className="ovFloodDot" aria-hidden />{mirrorHead}</div>
          <div className="ovFloodLine">
            {p.mirror === null
              ? "reads fall back to the repo tarball, exactly as before the mirror existed"
              : p.mirror.state === "off"
                ? "no Supabase env — every read hauls the repo tarball"
                : <>at commit {p.commitUrl ? <a className="ovFloodSha" href={p.commitUrl} target="_blank" rel="noopener" title="open the commit on GitHub">{p.sha}</a> : <b>{p.sha}</b>} · reconciled {p.mirror.syncedAt ? agoIso(p.mirror.syncedAt, p.now) : "—"}</>}
            <br />
            session boot cost <b>{p.boot ? `${p.boot.pct}%` : "unknown"}</b>
            {p.boot ? ` · ~${p.boot.tokens.toLocaleString()} estimated boot tokens of ~${p.tokens.toLocaleString()} estimated body tokens` : " — boot path unreadable this render"}
          </div>
        </div>
      </header>

      <section id="working-context" className="ovPanel ovWorkingContext" aria-labelledby="ov-working" data-cx-section data-cx="rise" tabIndex={-1}>
        <WorkingState now={p.now} />
      </section>

      {/* 01 — the corpus. Not decoration: one mark per block, solid where retracted. */}
      <section id="overview-corpus" className="ovCorpus" data-cx="rise" aria-labelledby="ov-corpus" data-cx-section tabIndex={-1}>
        <div className="ovCorpusHead">
          <span className="ovTag" data-cx="print">
            <span className="ovTagN">01</span>
            <span className="ovTagLabel" id="ov-corpus">The corpus</span>
          </span>
          <span className="ovCorpusMeta">{p.field.total.toLocaleString()} blocks · {p.retracted} retracted (solid) · {p.field.capNote}</span>
        </div>
        <CorpusField field={p.field} sha={p.sha} />
      </section>

      <div id="overview-instruments" className="ovPanels" data-cx-section tabIndex={-1} aria-label="Instruments" role="region">
        <section className="ovPanel" data-cx="rise" aria-labelledby="ov-boot">
          <div className="ovPanelHead">
            <h2 className="ovPanelTitle" id="ov-boot">Session boot cost</h2>
            <span className="ovPanelFig">{p.boot ? `${p.boot.pct}%` : "unreadable"}</span>
          </div>
          <div className="ovBoot">
            <BootRing pct={p.boot ? p.boot.pct : null} />
            <div className="ovBootBody">
              <div className="ovBootLine">
                {p.boot ? `~${p.boot.tokens.toLocaleString()} estimated boot tokens before you type — measured from the assembled profile, router, working state and recent context.` : "The boot payload did not answer this render, so its cost is unknown — not zero."}
              </div>
              <div className="ovBootNote">low is good · rising means writing outpaces condensing</div>
              <div className="ovReaderRow">
                <label className="ovReaderLabel" htmlFor="ov-reader">Reader</label>
                <ReaderSelect options={p.reader.options} current={p.reader.current} writable={p.reader.writable} />
              </div>
              <div className="ovBootNote">{p.reader.note}</div>
            </div>
          </div>
        </section>

        <section className="ovPanel ovD1" data-cx="rise" aria-labelledby="ov-activity">
          <ActivityChart a={p.activity} />
        </section>

        <section className="ovPanel ovD1" data-cx="rise" aria-labelledby="ov-saves">
          <div className="ovPanelHead">
            <h2 className="ovPanelTitle" id="ov-saves">Recent saves</h2>
            <span className="ovPanelNote">{p.saves.length ? `newest ${p.saves.length} · ` : ""}every write is a commit</span>
          </div>
          <div className="ovSavesViewport" role="region" aria-labelledby="ov-saves" tabIndex={0}>
            <Saves saves={p.saves} commitBase={p.commitBase} now={p.now} sha={p.sha} />
          </div>
        </section>

        <section className="ovPanel ovD3" data-cx="rise" aria-labelledby="ov-pipeline">
          <div className="ovPanelHead">
            <h2 className="ovPanelTitle" id="ov-pipeline">Memory pipeline</h2>
            <span className={`ovChip ovChip-${p.pipeline.tone}`}>{p.pipeline.state}</span>
          </div>
          {p.pipeline.rows.map((r) => (
            <div key={r.k} className="ovKv">
              <span className="ovKvK">{r.k}</span>
              <span className="ovKvV">{r.v}</span>
            </div>
          ))}
          {p.pipeline.notes.map((n) => <div key={n} className="ovPanelFoot">{n}</div>)}
        </section>

        <section className="ovPanel ovD4" data-cx="rise" aria-labelledby="ov-doors">
          <div className="ovPanelHead">
            <h2 className="ovPanelTitle" id="ov-doors">Doors · last call</h2>
            <a className="ovLink" href="settings">settings ›</a>
          </div>
          {p.doors.map((d) => (
            <div key={d.key} className="ovDoor">
              <i className={`ovDoorDot${d.live ? " ovDoorDotLive" : ""}`} aria-hidden />
              <span className="ovDoorBody">
                <span className="ovDoorName">{d.name}</span>
                <span className="ovDoorSub">{d.sub}</span>
              </span>
              <span className={`ovChip ovChip-${d.grant === "ask only" ? "warn" : "muted"}`}>{d.grant}</span>
            </div>
          ))}
          <div className="ovPanelFoot">a live dot is a call in the last 24 h · this environment's log, {p.logWindow}</div>
        </section>

        <section className="ovPanel ovD2" data-cx="rise" aria-labelledby="ov-checked">
          <div className="ovPanelHead">
            <h2 className="ovPanelTitle" id="ov-checked">Answer evidence · {p.checkedWindow}</h2>
            <span className="ovPanelNote">{p.checked.asks} ask{p.checked.asks === 1 ? "" : "s"}</span>
          </div>
          {p.checked.asks === 0 ? (
            <div className="ovEmpty">no asks in the last {p.checkedWindow} on this environment — the stamps return with the next brain_ask</div>
          ) : (
            <>
              <svg className="ovStack" viewBox="0 0 100 8" preserveAspectRatio="none" aria-hidden data-cx="flood">
                {p.checked.rows.reduce<{ x: number; els: React.ReactNode[] }>((acc, r) => {
                  if (r.n > 0) acc.els.push(<rect key={r.k} className={`ovTone-${r.tone}`} x={acc.x} y={0} width={r.pct} height={8} />);
                  return { x: acc.x + r.pct, els: acc.els };
                }, { x: 0, els: [] }).els}
              </svg>
              <div className="ovStats">
                {p.checked.rows.map((r) => (
                  <div key={r.k}>
                    <div className="ovStatN"><i className={`ovTone-${r.tone}`} aria-hidden />{r.n}</div>
                    <div className="ovStatK">{r.k}</div>
                  </div>
                ))}
              </div>
              <div className="ovPanelFoot">
                the bar covers {p.checked.rows.reduce((a, r) => a + r.n, 0)} of {p.checked.asks} evidence outcomes · source verified = VERIFIED + CORRECTED · unverified is not a wrong-answer judgment · {p.checked.stamps.filter((s) => s.n > 0).map((s) => `${s.s} ${s.n}`).join(" · ")} · SUPERSEDED and PARTIALLY VERIFIED are listed separately, not in the bar · answer correctness was not measured{p.checked.rows.some((r) => r.k === "cut off by the platform" && r.n > 0) ? ` · ${CUT_OFF_CAVEAT}` : ""}
              </div>
            </>
          )}
        </section>
      </div>
    </div>
  );
}
