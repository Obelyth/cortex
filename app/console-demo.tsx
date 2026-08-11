"use client";

/**
 * The landing's console demo — the gated console's paper shell rendered over the same kind of
 * synthetic data as the demo map. It exists so the landing can show the instrument without
 * showing an inventory: every number, path and SHA comes from console-demo-data.ts, the clock
 * is a counter rather than the time, and nothing here links to a gated route. The map tab
 * embeds /map — the public demo map, already synthetic and labelled.
 *
 * The shell follows the console's own design system (DESIGN.md in the reference deployment):
 * paper ground, ink rules, zero radius, colour only as a filled field carrying near-black,
 * Archivo wide for figures and JetBrains Mono for every functional value. All seven screens
 * are carried; the controls are demonstrably inert and the Settings screen says so in place.
 */

import { Archivo } from "next/font/google";
import React, { useEffect, useRef, useState } from "react";
import {
  ASK,
  BARS,
  BARS_MONTH,
  BARS_WEEK,
  BUBBLE,
  CHECKED,
  COMMITS,
  DEMO_NOTE,
  DIRS,
  DIR_TOTAL_LABEL,
  GUEST,
  NAV,
  POOL,
  PROPOSALS,
  QUOTES,
  READER,
  RITUALS,
  ROWS,
  STAMPS,
  STAMP_STATUS,
  SURFACES,
  TOOLS,
  TRENDS,
  TRIAGE,
  type BadgeStatus,
  type ScreenKey,
  type Stamp,
} from "./console-demo-data";
import styles from "./console-demo.module.css";

/* Self-hosted at build time, scoped to the frame — the landing keeps its own faces. */
const archivo = Archivo({
  subsets: ["latin"],
  axes: ["wdth"],
  display: "swap",
  variable: "--font-archivo",
});

/* ---------------------------------------------------------------- atoms --- */

const STAMP_CLASS: Record<BadgeStatus, string> = {
  pass: styles.stPass,
  warn: styles.stWarn,
  fail: styles.stFail,
  processing: styles.stProcessing,
  neutral: styles.stNeutral,
};

function StampChip({ stamp }: { stamp: Stamp }) {
  return <span className={`${styles.stamp} ${STAMP_CLASS[STAMP_STATUS[stamp]]}`}>{stamp}</span>;
}

function Reveal({ label, children }: { label: string; children: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <div>
      <button type="button" className={styles.revBtn} aria-expanded={open} onClick={() => setOpen(!open)}>
        <span className={`${styles.caret} ${open ? styles.caretOpen : ""}`} />
        {label}
      </button>
      {open && <span className={styles.revBody}>{children}</span>}
    </div>
  );
}

function SecHead({ n, label, title, lede }: { n: string; label: string; title: React.ReactNode; lede?: React.ReactNode }) {
  return (
    <div className={styles.secHead}>
      <span className={styles.secTag}>
        <span className={styles.secTagN}>{n}</span>
        <span className={styles.secTagLabel}>{label}</span>
      </span>
      <h3 className={styles.secTitle}>{title}</h3>
      {lede && <p className={styles.secLede}>{lede}</p>}
    </div>
  );
}

function Ring({ pct }: { pct: number }) {
  return (
    <div className={styles.ringBox}>
      <svg viewBox="0 0 112 112" width="96" height="96" aria-hidden>
        <circle cx="56" cy="56" r="44" pathLength={100} fill="none" stroke="var(--rule-soft)" strokeWidth="7" />
        <circle
          className={styles.ringArc}
          cx="56"
          cy="56"
          r="44"
          pathLength={100}
          fill="none"
          stroke="var(--field-live)"
          strokeWidth="7"
          strokeLinecap="butt"
          strokeDasharray={`${pct} ${100 - pct}`}
          transform="rotate(-90 56 56)"
        />
      </svg>
      <div className={styles.ringLabel}>
        <div>
          <div className={styles.ringPct}>{pct}%</div>
          <div className={styles.ringSub}>loaded per session</div>
        </div>
      </div>
    </div>
  );
}

/* ----------------------------------------------------------------- clock --- */

const START_SEC = 52327;

function fmt(sec: number): string {
  const s = ((sec % 86400) + 86400) % 86400;
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(Math.floor(s / 3600))}:${p(Math.floor(s / 60) % 60)}:${p(s % 60)}`;
}

type StreamRow = (typeof POOL)[number] & { time: string; key: number };

const event = (i: number, sec: number): StreamRow => ({
  ...POOL[((i % POOL.length) + POOL.length) % POOL.length],
  time: fmt(sec),
  key: i,
});

/**
 * The stream is derived from the tick rather than accumulated in state: every third tick
 * contributes one appended event on top of the seed rows. Accumulating meant calling a second
 * setState inside the tick updater — updaters must stay pure (StrictMode double-invokes them,
 * which prepended each event twice and duplicated its React key). Derivation keeps the updater
 * pure and makes each row's key its monotonic event index, unique by design.
 */
const streamAt = (t: number): StreamRow[] => {
  const rows: StreamRow[] = [];
  let m = Math.floor(t / 3);
  while (m >= 1 && rows.length < 6) {
    rows.push(event(m + 8, START_SEC + m * 3));
    m--;
  }
  let seed = 0;
  while (rows.length < 6) {
    rows.push(event(seed, START_SEC - seed * 37));
    seed++;
  }
  return rows;
};

/* ------------------------------------------------------------- overview --- */

/** One mark per block of one note — the corpus rendered as the ledger's own data. */
const FIELD_MARKS: Array<{ note: string; block: number; ret: boolean }> = ROWS.flatMap((r) => {
  const marks: Array<{ note: string; block: number; ret: boolean }> = [];
  const every = r.ret ? Math.max(4, Math.floor(r.blocks / (r.ret * 2))) : 0;
  for (let i = 0; i < r.blocks; i++) {
    marks.push({ note: r.dir + r.base, block: i + 1, ret: r.ret !== null && every > 0 && i % every === 2 && i / every < r.ret * 2 });
  }
  return marks;
});

function DotField() {
  const [read, setRead] = useState<{ note: string; block: number; ret: boolean } | null>(null);
  const [hot, setHot] = useState(-1);
  return (
    <>
      <div
        className={styles.dotField}
        onMouseLeave={() => {
          setRead(null);
          setHot(-1);
        }}
        onBlur={() => {
          setRead(null);
          setHot(-1);
        }}
        onMouseOver={(e) => {
          const i = Number((e.target as HTMLElement).dataset.i ?? -1);
          if (i >= 0) {
            setRead(FIELD_MARKS[i]);
            setHot(i);
          }
        }}
        onFocus={(e) => {
          const i = Number((e.target as HTMLElement).dataset.i ?? -1);
          if (i >= 0) {
            setRead(FIELD_MARKS[i]);
            setHot(i);
          }
        }}
      >
        {FIELD_MARKS.map((m, i) => (
          <i
            key={i}
            data-i={i}
            className={`${m.ret ? styles.dotRet : ""} ${i === hot ? styles.dotHot : ""}`}
            style={{ "--d": `${Math.min(i, 600) * 1.1}ms` } as React.CSSProperties}
          />
        ))}
      </div>
      <div className={styles.fieldRead}>
        {read ? (
          <>
            <span className={styles.fieldReadPath}>{read.note}</span>
            <span>block {read.block}</span>
            {read.ret && <span className={styles.fieldReadRet}>retracted — kept on the page</span>}
          </>
        ) : (
          <span>hover a mark · one mark is one block of one note · solid means corrected, not wrong</span>
        )}
      </div>
    </>
  );
}

const WINDOWS = {
  "24h": { bars: BARS, axis: ["00:00", "06:00", "12:00", "18:00", "now"], unit: "asks this hour" },
  week: { bars: BARS_WEEK, axis: ["mon", "wed", "fri", "sun"], unit: "asks that day" },
  month: { bars: BARS_MONTH, axis: ["-30d", "-20d", "-10d", "now"], unit: "asks that day" },
} as const;
type WindowKey = keyof typeof WINDOWS;

function Activity() {
  const [win, setWin] = useState<WindowKey>("24h");
  const [sel, setSel] = useState<number | null>(null);
  const { bars, axis, unit } = WINDOWS[win];
  const max = Math.max(...bars);
  const peak = bars.indexOf(max);
  return (
    <>
      <div className={styles.sectionHead}>
        <span className={styles.label}>
          {"Asks"}
          <span className={styles.labelNote}>341 in 24 h · click a bar</span>
        </span>
        <span className={styles.segWrap}>
          {(Object.keys(WINDOWS) as WindowKey[]).map((k) => (
            <button
              key={k}
              type="button"
              className={`${styles.segBtn} ${win === k ? styles.segOn : ""}`}
              onClick={() => {
                setWin(k);
                setSel(null);
              }}
            >
              {k}
            </button>
          ))}
        </span>
      </div>
      <div className={styles.capChart}>
        {bars.map((n, i) => (
          <button
            key={`${win}-${i}`}
            type="button"
            aria-label={`${n} ${unit}`}
            className={`${styles.capCol} ${i === (sel ?? peak) ? styles.capOn : ""} ${sel !== null && i !== sel ? styles.capDim : ""}`}
            onClick={() => setSel(sel === i ? null : i)}
          >
            <span className={styles.capBody} style={{ height: `${Math.max(2, Math.round((n / max) * 92))}%` }} />
          </button>
        ))}
      </div>
      <div className={styles.chartAxis}>
        {axis.map((a) => (
          <span key={a}>{a}</span>
        ))}
      </div>
      <div className={styles.actNote}>{sel !== null ? `${bars[sel]} ${unit}` : `peak ${max} — the one bar the live field marks`}</div>
    </>
  );
}

function Overview({ stream, onInbox }: { stream: StreamRow[]; onInbox: () => void }) {
  const checkedTotal = CHECKED.reduce((s, c) => s + c.n, 0);
  const TONE: Record<string, string> = { live: styles.tnLive, warn: styles.tnWarn, crit: styles.tnCrit, sunk: styles.tnSunk };
  return (
    <div className={styles.sheet}>
      <div className={styles.pad}>
        <header className={styles.ovMast}>
          <div className={styles.ovMastN}>68</div>
          <div className={styles.ovMastMeta}>
            <div className={styles.ovMastLead}>notes in the brain</div>
            <div className={styles.ovMastLine}>
              <b>27 corrections</b> kept on the page — retracted, never erased
            </div>
            <div className={styles.ovMastLine}>
              head <b>a3f19c72</b> · 4 folders · {DIR_TOTAL_LABEL} tokens
            </div>
            <div className={styles.ovMastLine}>142 notes served in the last 24 h</div>
          </div>
          <div className={styles.ovLive}>
            <div className={styles.ovLiveHead}>demo · synthetic data</div>
            <div className={styles.ovLiveLine}>
              Every path, count and SHA on this sheet is invented — <b>the shape is the product's</b>.
            </div>
            <div className={styles.ovLiveLine}>
              boot cost <b>1 call</b> · profile + index + last week
            </div>
          </div>
        </header>
      </div>

      <section className={`${styles.band} ${styles.bandInk}`}>
        <div className={styles.gridField} aria-hidden />
        <div className={styles.bandInner}>
          <SecHead
            n="01"
            label="The corpus"
            title={
              <>
                68 notes, <b>3,184 blocks</b> — the art is the data
              </>
            }
          />
          <DotField />
        </div>
      </section>

      <div className={styles.ovSplit}>
        <div className={styles.ovRead}>
          <section className={styles.card}>
            <div className={styles.sectionHead}>
              <span className={styles.label}>Session boot cost</span>
              <span className={styles.fig}>22%</span>
            </div>
            <div className={styles.ringWrap}>
              <Ring pct={22} />
              <div className={styles.ringCap}>
                21,180 of {DIR_TOTAL_LABEL} tokens — profile, index and the last week of log entries, one call.
                <Reveal label="what boot reads">
                  brain_context returns the profile, the ranked index and seven days of log — enough to continue any
                  project without re-reading the corpus. The rest loads note by note, on demand.
                </Reveal>
              </div>
            </div>
          </section>

          <section className={styles.card}>
            <Activity />
            <div className={styles.streamHead}>
              <span>time</span>
              <span>surface</span>
              <span>tool</span>
              <span>stamp</span>
              <span>cited file</span>
              <span className={styles.right}>ms</span>
            </div>
            {stream.map((e) => (
              <div key={e.key} className={styles.streamRow}>
                <span className={styles.numMono}>{e.time}</span>
                <span className={styles.numMono}>{e.surface}</span>
                <span className={styles.toolMono}>{e.tool}</span>
                <span>
                  <StampChip stamp={e.stamp} />
                </span>
                <span className={styles.pathMono}>{e.path}</span>
                <span className={`${styles.numMono} ${styles.right}`}>{e.ms}</span>
              </div>
            ))}
          </section>

          <section className={styles.card}>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "0 28px", alignItems: "start" }}>
              <div>
                <div className={styles.sectionHead}>
                  <span className={styles.label}>Working state</span>
                  <span className={styles.fig}>3 open</span>
                </div>
                {BUBBLE.map((it) => (
                  <div key={it.text} className={styles.wsRow}>
                    <span
                      className={`${styles.wsKind} ${it.kind === "focus" ? styles.wsKindFocus : ""} ${it.kind === "handoff" ? styles.wsKindHandoff : ""}`}
                    >
                      {it.kind}
                    </span>
                    <span className={styles.wsBody}>
                      {it.text} <span className={styles.mono}>{it.note}</span>
                    </span>
                    <span className={styles.wsMeta}>{it.ago}</span>
                  </div>
                ))}
                <div className={styles.sectionHead} style={{ marginTop: 18 }}>
                  <span className={styles.label}>Connections</span>
                  <span className={styles.fig}>4 doors</span>
                </div>
                {SURFACES.map((s) => (
                  <div key={s.name} className={styles.connRow}>
                    <span className={s.state === "live" ? styles.dotLive : styles.dotIdle} />
                    <span style={{ minWidth: 0 }}>
                      <div className={styles.connName}>{s.name}</div>
                      <div className={styles.connSub}>{s.sub}</div>
                    </span>
                    <span className={styles.connGrant}>{s.grant}</span>
                  </div>
                ))}
              </div>
              <div>
                <div className={styles.sectionHead}>
                  <span className={styles.label}>Recent saves</span>
                  <span className={styles.fig}>every write is a commit</span>
                </div>
                {COMMITS.map((c) => (
                  <div key={c.sha} className={styles.commitRow}>
                    <span className={styles.sha}>{c.sha}</span>
                    <span className={styles.msg}>{c.msg}</span>
                    <span className={styles.agoCol}>{c.ago}</span>
                  </div>
                ))}
                <div className={styles.compHead}>
                  <span>corpus by folder</span>
                  <span>{DIR_TOTAL_LABEL} tokens</span>
                </div>
                <div className={styles.compBar}>
                  {DIRS.map((d, i) => (
                    <i key={d.dir} className={i === 0 ? styles.compLive : i === 3 ? styles.compFaint : i === 2 ? styles.compMid : ""} style={{ width: d.w }} />
                  ))}
                </div>
                <div className={styles.legend}>
                  {DIRS.map((d, i) => (
                    <span key={d.dir} className={styles.legendItem}>
                      <i className={i === 0 ? styles.compLive : i === 3 ? styles.compFaint : i === 2 ? styles.compMid : ""} />
                      {d.dir} {d.tokens}
                    </span>
                  ))}
                </div>
                <div className={styles.sectionHead} style={{ marginTop: 18 }}>
                  <span className={styles.label}>How answers checked out</span>
                  <span className={styles.fig}>{checkedTotal} scored</span>
                </div>
                <div className={styles.stackBar}>
                  {CHECKED.map((c) => (
                    <i key={c.tag} className={TONE[c.tone]} style={{ width: `${(c.n / checkedTotal) * 100}%` }} />
                  ))}
                </div>
                {CHECKED.map((c) => (
                  <div key={c.tag} className={styles.checkedRow}>
                    <i className={TONE[c.tone]} />
                    <span>{c.tag}</span>
                    <span className={styles.right}>{c.n}</span>
                  </div>
                ))}
                <Reveal label="what a stamp means">
                  {STAMPS.map((s) => (
                    <span key={s.tag} className={styles.stampRow}>
                      <StampChip stamp={s.tag as Stamp} />
                      <span>{s.line}</span>
                    </span>
                  ))}
                </Reveal>
              </div>
            </div>
          </section>
        </div>

        <aside className={styles.ovInbox}>
          <div className={styles.ovInboxHead}>Inbox</div>
          <div className={styles.ovInboxN}>8</div>
          <div className={styles.ovInboxRow}>2 credential-shaped lines, redacted on every read</div>
          <div className={styles.ovInboxRow}>3 notes carry unmarked retired-tool claims</div>
          <div className={styles.ovInboxRow}>1 cold stamp · 2 guest proposals waiting</div>
          <button type="button" className={styles.ovInboxBtn} onClick={onInbox}>
            Open inbox →
          </button>
        </aside>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ ask --- */

function Ask() {
  const [phase, setPhase] = useState<"idle" | "wait" | "done">("idle");
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
  }, []);
  const run = () => {
    if (phase === "wait") return;
    setPhase("wait");
    timer.current = setTimeout(() => setPhase("done"), 1300);
  };
  return (
    <div className={styles.sheet}>
      <section className={`${styles.band} ${styles.bandInk}`}>
        <div className={styles.gridField} aria-hidden />
        <div className={styles.bandInner}>
          <SecHead
            n="01"
            label="Ask"
            title={
              <>
                One question, <b>one proven answer</b>
              </>
            }
            lede="The only screen that uses the brain rather than measuring it. The demo runs a canned ask over the synthetic corpus — same shape, nothing real behind it."
          />
          <div className={styles.askBar}>
            <span className={styles.askInput}>{ASK.q}</span>
            <button type="button" className={styles.askGo} onClick={run} disabled={phase === "wait"}>
              {phase === "done" ? "Ask again" : "Ask"}
            </button>
          </div>
          {phase === "wait" && (
            <div className={styles.askWait}>
              <span className={styles.askWaitBar} />
              {"reading the corpus · proving the quote against the file"}
            </div>
          )}
          {phase === "done" && (
            <div className={styles.askResult}>
              <span className={`${styles.askStamp} ${styles.askStampAnim}`}>{ASK.stamp}</span>
              <p className={styles.askAnswer}>{ASK.answer}</p>
              <div className={styles.askCite}>
                <div className={styles.askCiteHead}>
                  <span className={styles.askCitePath}>{ASK.cite.loc}</span>
                  <span className={styles.askCiteAt}>{ASK.cite.heading}</span>
                </div>
                <p className={styles.askEvidence}>{ASK.cite.quote}</p>
              </div>
              <div className={styles.askMeta}>
                <span>
                  reader <b>{ASK.meta.reader}</b>
                </span>
                <span>
                  <b>{ASK.meta.ms} ms</b>
                </span>
                <span>
                  corpus <b>{ASK.meta.corpus}</b> → pack <b>{ASK.meta.pack}</b>
                </span>
                <span>verifier: deterministic — no model in the loop</span>
              </div>
            </div>
          )}
        </div>
      </section>

      <section className={styles.band}>
        <div className={styles.bandInner}>
          <SecHead n="02" label="The tools" title={<>Six tools, <b>two doors</b></>} />
          {TOOLS.map((t) => (
            <div key={t.name} className={styles.toolRow2}>
              <span className={styles.toolName2}>{t.name}</span>
              <span className={styles.toolWhat2}>{t.what}</span>
              <span className={styles.toolDoors}>
                {["code", "connector", "guest"].map((d) => (
                  <span key={d} className={`${styles.toolDoor} ${t.doors.includes(d) ? styles.toolDoorOn : ""}`}>
                    {d}
                  </span>
                ))}
              </span>
              <span className={styles.toolCalls}>{t.calls}</span>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}

/* --------------------------------------------------------------- trends --- */

const CW = 600;
const CH = 150;
const XA = 12;
const XB = CW - 12;
const YT = 16;
const YB = CH - 12;

function chartPoints(vals: number[], max: number): Array<[number, number]> {
  const n = Math.max(2, vals.length);
  return vals.map((v, i) => [XA + ((XB - XA) * i) / (n - 1), YB - ((YB - YT) * v) / max]);
}

function chartPath(pts: Array<[number, number]>): string {
  return pts.reduce((d, p, i) => {
    if (i === 0) return `M${p[0]},${p[1]}`;
    const q = pts[i - 1];
    const m = (q[0] + p[0]) / 2;
    return `${d} C${m},${q[1]} ${m},${p[1]} ${p[0]},${p[1]}`;
  }, "");
}

function MemoryChart() {
  const buckets = TRENDS.buckets;
  const busiest = buckets.reduce((bi, b, i) => (b.memory + b.fresh > buckets[bi].memory + buckets[bi].fresh ? i : bi), 0);
  const [sel, setSel] = useState(busiest);
  const max = Math.max(1, ...buckets.map((b) => Math.max(b.memory, b.fresh)));
  const pm = chartPoints(buckets.map((b) => b.memory), max);
  const pf = chartPoints(buckets.map((b) => b.fresh), max);
  const memD = chartPath(pm);
  const freshD = chartPath(pf);
  const fillD = `${memD} L${XB},${YB} L${XA},${YB} Z`;
  const i = Math.min(sel, buckets.length - 1);
  const tipLeft = `${((pm[i][0] / CW) * 100).toFixed(2)}%`;
  const flip = i >= buckets.length - 2;
  return (
    <>
      <div className={styles.mcPlot}>
        <svg viewBox={`0 0 ${CW} ${CH}`} preserveAspectRatio="none" aria-hidden>
          <defs>
            <linearGradient id="demoMcFill" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0" stopColor="#1fbdd6" stopOpacity="0.2" />
              <stop offset="1" stopColor="#1fbdd6" stopOpacity="0" />
            </linearGradient>
          </defs>
          <path d={fillD} fill="url(#demoMcFill)" stroke="none" />
          <path d={freshD} fill="none" stroke="var(--ink-500)" strokeWidth="1.5" strokeDasharray="5 5" vectorEffect="non-scaling-stroke" />
          <path d={memD} fill="none" stroke="var(--field-live)" strokeWidth="2" vectorEffect="non-scaling-stroke" />
        </svg>
        <span className={styles.mcRule} style={{ left: tipLeft }} />
        <span className={`${styles.mcDot} ${styles.mcDotMem}`} style={{ left: tipLeft, top: `${((pm[i][1] / CH) * 100).toFixed(2)}%` }} />
        <span className={styles.mcDot} style={{ left: tipLeft, top: `${((pf[i][1] / CH) * 100).toFixed(2)}%` }} />
        <span
          className={styles.mcTags}
          style={flip ? { left: `calc(${tipLeft} - 12px)`, transform: "translateX(-100%)" } : { left: `calc(${tipLeft} + 12px)` }}
        >
          <span className={`${styles.mcTag} ${styles.mcTagMem}`}>
            <i />
            {buckets[i].memory} from memory
          </span>
          <span className={styles.mcTag}>
            <i />
            {buckets[i].fresh} not in memory
          </span>
        </span>
        <span className={styles.mcZones}>
          {buckets.map((b, z) => (
            <button
              key={b.label}
              type="button"
              aria-label={`${b.label}: ${b.memory} from memory, ${b.fresh} not in memory`}
              onMouseEnter={() => setSel(z)}
              onFocus={() => setSel(z)}
              onClick={() => setSel(z)}
            />
          ))}
        </span>
      </div>
      <div className={styles.mcAxis}>
        {buckets.map((b) => (
          <span key={b.label}>{b.label}</span>
        ))}
      </div>
    </>
  );
}

function Trends() {
  return (
    <div className={styles.sheet}>
      <section className={`${styles.band} ${styles.bandInk}`}>
        <div className={styles.gridField} aria-hidden />
        <div className={styles.bandInner}>
          <SecHead
            n="01"
            label="Trends"
            title={
              <>
                What the memory <b>saves</b>
              </>
            }
            lede="Measured where it can be, estimated where it says so — and computed from a synthetic log here."
          />
          <div className={styles.statStrip}>
            {TRENDS.stats.map((s) => (
              <div key={s.label} className={styles.statCell}>
                <div className={styles.label}>{s.label}</div>
                <div className={styles.statFig}>{s.fig}</div>
                <div className={styles.statSub}>{s.sub}</div>
              </div>
            ))}
          </div>
        </div>
      </section>

      <div className={styles.trGrid}>
        <div className={styles.trCol}>
          <section className={styles.card}>
            <div className={styles.sectionHead}>
              <span className={styles.label}>Answers · memory vs typing</span>
              <span className={styles.fig}>8 days</span>
            </div>
            <MemoryChart />
          </section>
          <section className={styles.card}>
            <div className={styles.sectionHead}>
              <span className={styles.label}>Patterns</span>
              <span className={styles.fig}>render only when the log can back them</span>
            </div>
            {TRENDS.patterns.map((p) => (
              <div key={p.title} className={styles.patRow}>
                <span className={`${styles.patArrow} ${p.dir === "down" ? styles.patDown : ""}`} aria-hidden>
                  <svg width="13" height="13" viewBox="0 0 14 14">
                    <path d="M2 12 L12 2 M5 2 h7 v7" stroke="currentColor" fill="none" strokeWidth="1.5" />
                  </svg>
                </span>
                <span className={styles.patBody}>
                  <span className={styles.patTitle}>{p.title}</span>
                  <span className={styles.patSub}>{p.sub}</span>
                </span>
                <span className={`${styles.patChip} ${p.dir === "down" ? styles.patChipWarn : ""}`}>{p.chip}</span>
              </div>
            ))}
          </section>
        </div>
        <div className={styles.trCol}>
          <section className={styles.card}>
            <div className={styles.sectionHead}>
              <span className={styles.label}>Busy hours</span>
            </div>
            <div className={styles.heatWrap}>
              <span />
              {TRENDS.days.map((d, i) => (
                <span key={`${d}${i}`} className={styles.heatDay}>
                  {d}
                </span>
              ))}
              {TRENDS.heat.map((row, b) => (
                <React.Fragment key={TRENDS.bands[b]}>
                  <span className={styles.heatBand}>{TRENDS.bands[b]}</span>
                  {row.map((v, d) => (
                    <span
                      key={d}
                      className={styles.heatCell}
                      style={{
                        background:
                          v === 100
                            ? "var(--field-warn)"
                            : `color-mix(in oklab, var(--ink-900) ${Math.round(v * 0.55)}%, var(--paper-sunk))`,
                      }}
                    />
                  ))}
                </React.Fragment>
              ))}
            </div>
            <div className={styles.heatKey}>
              <span>less</span>
              <i style={{ background: "var(--paper-sunk)" }} />
              <i style={{ background: "color-mix(in oklab, var(--ink-900) 30%, var(--paper-sunk))" }} />
              <i style={{ background: "color-mix(in oklab, var(--ink-900) 55%, var(--paper-sunk))" }} />
              <i style={{ background: "var(--field-warn)" }} />
              <span>more</span>
            </div>
          </section>
          <section className={styles.card}>
            <div className={styles.sectionHead}>
              <span className={styles.label}>Who answered</span>
            </div>
            <div className={styles.shareBar}>
              {TRENDS.share.map((s) => (
                <i
                  key={s.name}
                  className={s.tone === "live" ? styles.tnLive : undefined}
                  style={{ width: `${s.pct}%`, background: s.tone === "ink" ? "var(--ink-900)" : s.tone === "faint" ? "var(--ink-400)" : undefined }}
                />
              ))}
            </div>
            {TRENDS.share.map((s) => (
              <div key={s.name} className={styles.shareRow}>
                <i
                  className={s.tone === "live" ? styles.tnLive : undefined}
                  style={{ background: s.tone === "ink" ? "var(--ink-900)" : s.tone === "faint" ? "var(--ink-400)" : undefined }}
                />
                <span className={styles.shareName}>{s.name}</span>
                <span className={styles.sharePct}>{s.pct}%</span>
              </div>
            ))}
          </section>
        </div>
      </div>
    </div>
  );
}

/* ---------------------------------------------------------------- notes --- */

const NOTE_QUOTE: Record<string, (typeof QUOTES)[number]> = {
  "projects/aurora.md": QUOTES[0],
  "notes/retrieval-eval.md": QUOTES[1],
  "notes/mcp-architecture.md": QUOTES[2],
};

function Notes({ focus }: { focus: string | null }) {
  const [open, setOpen] = useState<number | null>(() => {
    if (!focus) return null;
    const i = ROWS.findIndex((r) => focus.startsWith(r.dir + r.base));
    return i >= 0 ? i : null;
  });
  return (
    <div className={styles.sheet}>
      <section className={`${styles.band} ${styles.bandGrey}`}>
        <div className={styles.bandInner}>
          <SecHead
            n="01"
            label="Shape"
            title={
              <>
                What this brain is <b>made of</b>
              </>
            }
          />
          {DIRS.map((d) => (
            <div key={d.dir} className={styles.distRow}>
              <span className={styles.distLabel}>{d.dir}/</span>
              <span className={styles.distBar}>
                <i style={{ width: d.share }} />
              </span>
              <span className={styles.distN}>
                {d.tokens} tok · {d.notes} notes
              </span>
            </div>
          ))}
        </div>
      </section>

      <section className={styles.band}>
        <div className={styles.bandInner}>
          <SecHead
            n="02"
            label="Ledger"
            title={
              <>
                Every note, <b>tick by tick</b>
              </>
            }
            lede="Each tick is one block. Solid ink is a retracted passage — kept on the page so a stale answer can be caught quoting it."
          />
          <div className={styles.ledgerBar}>
            <span className={styles.ledgerFilter}>Filter by path</span>
            <span className={styles.ledgerCount}>10 of 68 shown</span>
          </div>
          <div className={styles.thead}>
            <span />
            <span>note</span>
            <span>blocks</span>
            <span className={styles.right}>tokens</span>
            <span className={styles.right}>ret</span>
          </div>
          {ROWS.map((r, i) => {
            const quote = NOTE_QUOTE[r.dir + r.base];
            return (
              <div key={r.dir + r.base}>
                <button type="button" className={`${styles.lrow} ${open === i ? styles.lrowOn : ""}`} onClick={() => setOpen(open === i ? null : i)}>
                  <span className={`${styles.caret} ${open === i ? styles.caretOpen : ""}`} />
                  <span className={styles.lpath}>
                    <span>{r.dir}</span>
                    <b>{r.base}</b>
                  </span>
                  <span className={styles.blocks}>
                    {r.ticks.map((tk, j) => (
                      <i key={j} className={tk.r ? styles.ret : ""} />
                    ))}
                  </span>
                  <span className={`${styles.fig} ${styles.right}`}>{r.tokens}</span>
                  <span className={`${styles.fig} ${styles.right} ${r.ret ? styles.figWarn : styles.figNil}`}>{r.ret ?? "·"}</span>
                </button>
                {open === i && (
                  <div className={styles.noteCard}>
                    <div className={styles.noteTitle}>
                      <span>{r.base.replace(/\.md$/, "").replaceAll("-", " ")}</span>
                      <span className={styles.fig}>
                        {r.blocks} blocks · {r.tokens} tok
                      </span>
                    </div>
                    <p className={styles.noteDesc}>
                      The note's own account of itself — title, outline and retracted passages, read from the file. Synthetic
                      here, like everything on this sheet.
                    </p>
                    <div className={styles.noteOutline}>
                      {["Status", "Decisions", "Retrieval", "Handoff"].map((h, j) => (
                        <span key={h} className={styles.noteHeading}>
                          <span>§{j + 1}</span>
                          <span>{h}</span>
                        </span>
                      ))}
                    </div>
                    {quote && r.ret && (
                      <div className={styles.noteDead}>
                        <span className={styles.noteDeadText}>
                          {quote.loc} {quote.heading} — “{quote.text}”
                        </span>
                      </div>
                    )}
                  </div>
                )}
              </div>
            );
          })}
          <div className={styles.footNote}>
            showing 10 of 68 · archive, tools and generated indexes excluded — the same filter the reader uses
          </div>
        </div>
      </section>
    </div>
  );
}

/* ---------------------------------------------------------------- inbox --- */

function Inbox({ onOpenNote, onAsk }: { onOpenNote: (path: string) => void; onAsk: () => void }) {
  const [sel, setSel] = useState(0);
  const [openProp, setOpenProp] = useState<number | null>(0);
  const [flash, setFlash] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const item = TRIAGE[sel];
  return (
    <div className={styles.sheet}>
      <section className={styles.band}>
        <div className={styles.bandInner}>
          <SecHead
            n="01"
            label="Inbox"
            title={
              <>
                6 findings, <b>2 critical</b> — and 2 proposals waiting
              </>
            }
            lede="A working surface, so it stays on paper. In your deployment the two committing actions write to the brain; the demo declares them instead."
          />

          <div className={styles.triage}>
            <div className={styles.queue}>
              {TRIAGE.map((t, i) => (
                <button key={t.title} type="button" className={`${styles.qRow} ${sel === i ? styles.qOn : ""}`} onClick={() => setSel(i)}>
                  <span className={`${styles.pill} ${t.sev === "crit" ? styles.pillCrit : styles.pillWarn}`}>{t.sev}</span>
                  <span className={styles.qTitle}>{t.title}</span>
                  <span className={styles.qLoc}>{t.loc}</span>
                </button>
              ))}
            </div>
            <div className={styles.detail}>
              <div className={styles.detailLoc}>{item.loc}</div>
              <div className={styles.detailTitle}>{item.title}</div>
              <dl className={styles.kv}>
                {item.kv.map(([k, v]) => (
                  <React.Fragment key={k}>
                    <dt>{k}</dt>
                    <dd>{v}</dd>
                  </React.Fragment>
                ))}
              </dl>
              <div className={styles.triAct}>
                <button type="button" className={styles.triBtn} onClick={() => onOpenNote(item.loc)}>
                  Open the note
                </button>
                <button type="button" className={`${styles.triBtn} ${styles.triBtnAsk}`} onClick={onAsk}>
                  Ask about it
                </button>
                <button
                  type="button"
                  className={`${styles.triBtn} ${styles.triBtnGhost}`}
                  onClick={() => {
                    navigator.clipboard?.writeText(item.loc).catch(() => {});
                    setCopied(true);
                    setTimeout(() => setCopied(false), 1400);
                  }}
                >
                  {copied ? "Copied" : "Copy path"}
                </button>
                <span className={styles.triNote}>
                  The two committing actions — mark retracted, attest re-verified — change a real brain, so the demo
                  declares them instead of faking the write.
                </span>
              </div>
            </div>
          </div>

          <div className={styles.sectionHead} style={{ marginTop: 26 }}>
            <span className={styles.label}>Guest proposals</span>
            <span className={styles.fig}>rendered as text, never markdown</span>
          </div>
          {PROPOSALS.map((p, i) => (
            <div key={p.path + p.mode} className={styles.propRow}>
              <button type="button" className={styles.propHead} onClick={() => setOpenProp(openProp === i ? null : i)}>
                <span className={`${styles.caret} ${openProp === i ? styles.caretOpen : ""}`} />
                <span className={styles.propPath}>{p.path}</span>
                <span className={styles.propMode}>{p.mode}</span>
                <span className={styles.propWhy}>{p.why}</span>
              </button>
              {openProp === i && (
                <div className={styles.propBody}>
                  <pre className={styles.propContent}>{p.content}</pre>
                  <div className={styles.propActions}>
                    {flash && <span className={styles.note}>{flash}</span>}
                    <button
                      type="button"
                      className={`${styles.triBtn} ${styles.triBtnGhost}`}
                      onClick={() => {
                        setFlash("demo — nothing committed");
                        setTimeout(() => setFlash(null), 1600);
                      }}
                    >
                      Reject
                    </button>
                    <button
                      type="button"
                      className={styles.triBtn}
                      onClick={() => {
                        setFlash("demo — nothing committed");
                        setTimeout(() => setFlash(null), 1600);
                      }}
                    >
                      Accept
                    </button>
                  </div>
                </div>
              )}
            </div>
          ))}
        </div>
      </section>

      <section className={`${styles.band} ${styles.bandGrey}`}>
        <div className={styles.bandInner}>
          <SecHead
            n="02"
            label="Corrections"
            title={
              <>
                27 kept <b>on the page</b>
              </>
            }
            lede="Still verbatim in the file, stamped SUPERSEDED rather than VERIFIED. Verbatim is exactly what a stale answer looks like — which is why nothing is erased."
          />
          {QUOTES.map((q) => (
            <div key={q.loc} className={styles.retRow}>
              <span className={styles.retPath}>
                {q.loc} <span className={styles.mono}>{q.heading}</span>
              </span>
              <span className={styles.retText}>{q.text}</span>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}

/* ------------------------------------------------------------- settings --- */

function Settings() {
  const [providers, setProviders] = useState(READER.providers.map((p) => p.set));
  const [scope, setScope] = useState(GUEST.scope.map((s) => s.on));
  const [sources, setSources] = useState(GUEST.showSources);
  const [asks, setAsks] = useState(GUEST.asksPerDay);
  const [k, setK] = useState(GUEST.notesPerAsk);
  const [model, setModel] = useState(READER.active);
  return (
    <div className={styles.sheet}>
      <section className={styles.band}>
        <div className={styles.bandInner}>
          <SecHead
            n="01"
            label="Controls"
            title={
              <>
                Every control <b>in one place</b>
              </>
            }
          />
          <div className={styles.setGrid}>
            <section>
              <div className={styles.setHead}>
                <span className={styles.label}>Reader</span>
                <span className={styles.setHeadMeta}>3 providers</span>
              </div>
              <div className={styles.activeModel}>{model}</div>
              <select className={styles.modelSelect} value={model} onChange={(e) => setModel(e.target.value)} aria-label="Answering model (demo)">
                <option>claude-sonnet-5</option>
                <option>claude-opus-5</option>
                <option>claude-haiku-4-5</option>
                <option>gpt-5.6-terra</option>
              </select>
              {READER.providers.map((p, i) => (
                <div key={p.id} className={styles.setRow}>
                  <span className={styles.setBody}>
                    <span className={styles.setTitle}>{p.id}</span>
                    <span className={styles.setSub}>{p.sub}</span>
                  </span>
                  {p.locked ? (
                    <span className={styles.setLock}>locked</span>
                  ) : (
                    <button
                      type="button"
                      role="switch"
                      aria-checked={providers[i]}
                      aria-label={`${p.id} provider (demo)`}
                      className={`${styles.swt} ${providers[i] ? styles.swtOn : ""} ${!p.set && !providers[i] ? styles.swtDim : ""}`}
                      onClick={() => setProviders(providers.map((v, j) => (j === i ? !v : v)))}
                    />
                  )}
                </div>
              ))}
              <Reveal label="how the reader is chosen">
                The caller's explicit pick, then the deployment's READER_MODEL, then the measured default — and every step
                must land on the allowlist or the ask fails loudly.
              </Reveal>
            </section>

            <section>
              <div className={styles.setHead}>
                <span className={styles.label}>Guest</span>
                <span className={styles.setHeadMeta}>door {GUEST.door}</span>
              </div>
              <div className={styles.gScope}>
                {GUEST.scope.map((s, i) => (
                  <button
                    key={s.area}
                    type="button"
                    className={`${styles.gArea} ${scope[i] ? styles.gOn : ""}`}
                    aria-pressed={scope[i]}
                    onClick={() => setScope(scope.map((v, j) => (j === i ? !v : v)))}
                  >
                    {s.area}
                  </button>
                ))}
              </div>
              <div className={styles.setRow}>
                <span className={styles.setBody}>
                  <span className={styles.setTitle}>Show sources with answers</span>
                  <span className={styles.setSub}>paths and line numbers ride along</span>
                </span>
                <button
                  type="button"
                  role="switch"
                  aria-checked={sources}
                  aria-label="Show sources with answers (demo)"
                  className={`${styles.swt} ${sources ? styles.swtOn : ""}`}
                  onClick={() => setSources(!sources)}
                />
              </div>
              <div className={styles.setRow}>
                <span className={styles.setBody}>
                  <span className={styles.setTitle}>Asks per day</span>
                  <span className={styles.setSub}>the budget the door enforces</span>
                </span>
                <span className={styles.stepper}>
                  <button type="button" className={styles.stepBtn} aria-label="Fewer asks per day" onClick={() => setAsks(Math.max(1, asks - 1))}>
                    −
                  </button>
                  <span className={styles.stepVal}>{asks}</span>
                  <button type="button" className={styles.stepBtn} aria-label="More asks per day" onClick={() => setAsks(asks + 1)}>
                    +
                  </button>
                </span>
              </div>
              <div className={styles.setRow}>
                <span className={styles.setBody}>
                  <span className={styles.setTitle}>Notes per ask</span>
                  <span className={styles.setSub}>max k the reader may cite</span>
                </span>
                <span className={styles.stepper}>
                  <button type="button" className={styles.stepBtn} aria-label="Fewer notes per ask" onClick={() => setK(Math.max(1, k - 1))}>
                    −
                  </button>
                  <span className={styles.stepVal}>{k}</span>
                  <button type="button" className={styles.stepBtn} aria-label="More notes per ask" onClick={() => setK(k + 1)}>
                    +
                  </button>
                </span>
              </div>
              <Reveal label="how scope is enforced">
                Scope bounds sources, not subjects: the guest reader only ever sees the ticked areas, and the budget is
                counted at the door, before any model runs.
              </Reveal>
            </section>

            <section>
              <div className={styles.setHead}>
                <span className={styles.label}>Deployment</span>
                <span className={styles.setHeadMeta}>presence, never values</span>
              </div>
              {[
                ["BRAIN_REPO", true],
                ["GITHUB_TOKEN", true],
                ["CONNECTOR_PATH_SECRET", true],
                ["ANTHROPIC_API_KEY", true],
                ["GEMINI_API_KEY", false],
              ].map(([env, set]) => (
                <div key={String(env)} className={styles.setRow}>
                  <span className={styles.setBody}>
                    <span className={`${styles.setTitle} ${styles.mono}`}>{env}</span>
                  </span>
                  <span className={`${styles.fig} ${set ? "" : styles.figNil}`}>{set ? "set" : "not set"}</span>
                </div>
              ))}
              <p className={styles.demoNote}>{DEMO_NOTE}</p>
            </section>
          </div>
        </div>
      </section>

      <section className={`${styles.band} ${styles.bandInk}`}>
        <div className={styles.gridField} aria-hidden />
        <div className={styles.bandInner}>
          <SecHead
            n="02"
            label="Doors"
            title={
              <>
                Who does what, <b>and through which door</b>
              </>
            }
          />
          <div className={styles.roleGrid}>
            {[
              ["The pen", "the operator — every write is a commit under one name"],
              ["The reader", "one allowlisted model reads; swap it in settings"],
              ["The verifier", "no model — a string match against the file at its commit"],
              ["Guests", "scoped areas, counted budget, proposals instead of writes"],
            ].map(([who, does]) => (
              <div key={who} className={styles.roleCell}>
                <span className={styles.roleWho}>{who}</span>
                <span className={styles.roleDoes}>{does}</span>
              </div>
            ))}
          </div>
          <div className={styles.pathGrid}>
            <div className={styles.pathCard}>
              <div className={styles.pathHead}>
                <span className={styles.pathNum}>01</span>
                <span className={styles.pathName}>Terminal</span>
              </div>
              <div className={styles.pathState}>
                <span className={styles.dotLive} />
                <span className={styles.note}>bearer token · full toolset</span>
              </div>
              <p className={styles.pathWho}>Claude Code, user scope. The token never appears in a URL.</p>
              <pre className={styles.pre}>{`claude mcp add --transport http cortex \\
  https://<host>/api/mcp \\
  --header "Authorization: Bearer <MCP_TOKEN>"`}</pre>
              <p className={styles.pathNote}>one command, every project</p>
            </div>
            <div className={styles.pathCard}>
              <div className={styles.pathHead}>
                <span className={styles.pathNum}>02</span>
                <span className={styles.pathName}>Connector</span>
              </div>
              <div className={styles.pathState}>
                <span className={styles.dotLive} />
                <span className={styles.note}>secret URL · full toolset</span>
              </div>
              <p className={styles.pathWho}>claude.ai web, iOS and desktop — connectors cannot send headers, so the secret rides the path.</p>
              <pre className={styles.pre}>{`https://<host>/api/s/••••••••/mcp
— add once on the web; it syncs to
   iOS and desktop on its own`}</pre>
              <p className={styles.pathNote}>the secret renders as presence, never value</p>
            </div>
            <div className={styles.pathCard}>
              <div className={styles.pathHead}>
                <span className={styles.pathNum}>03</span>
                <span className={styles.pathName}>Guest</span>
              </div>
              <div className={styles.pathState}>
                <span className={styles.dotIdle} />
                <span className={styles.note}>scoped · budgeted · read-only</span>
              </div>
              <p className={styles.pathWho}>A second brain your collaborators can ask — never write. Proposals queue in the inbox instead.</p>
              <pre className={styles.pre}>{`asks per day: 20 · notes per ask: 3
scope: projects/ notes/`}</pre>
              <p className={styles.pathNote}>both doors fail closed — a mismatch answers 404</p>
            </div>
          </div>
          <div className={styles.twoCol}>
            <div>
              <div className={styles.sectionHead} style={{ marginTop: 18 }}>
                <span className={styles.label}>Who reads the answers</span>
              </div>
              <p className={styles.prose}>
                One allowlisted model reads the corpus; <b>the verifier is deterministic</b> — a string match against the
                file at its commit, no model in the loop. Trust comes from the verification, not from the reader.
              </p>
            </div>
            <div>
              <div className={styles.sectionHead} style={{ marginTop: 18 }}>
                <span className={styles.label}>The rituals</span>
              </div>
              {RITUALS.map((r) => (
                <div key={r.tag} className={styles.chevRow}>
                  <span>
                    <span className={styles.chevTag}>{r.tag}</span>
                    {r.text}
                  </span>
                </div>
              ))}
            </div>
          </div>
        </div>
      </section>
    </div>
  );
}

/* ----------------------------------------------------------------- demo --- */

export default function ConsoleDemo() {
  const [screen, setScreen] = useState<ScreenKey>("overview");
  const [t, setT] = useState(0);
  const [focusNote, setFocusNote] = useState<string | null>(null);

  useEffect(() => {
    const iv = setInterval(() => setT((prev) => prev + 1), 1000);
    return () => clearInterval(iv);
  }, []);

  const stream = streamAt(t);
  const go = (k: ScreenKey) => {
    if (k !== "corpus") setFocusNote(null);
    setScreen(k);
  };

  return (
    <div className={`${styles.frame} ${archivo.variable}`}>
      <header className={styles.mast}>
        <span className={styles.wordmark}>Cortex</span>
        <nav className={styles.tabs} aria-label="Console demo">
          {NAV.map((it) => (
            <button
              key={it.k}
              type="button"
              className={`${styles.tab} ${screen === it.k ? styles.tabOn : ""}`}
              aria-pressed={screen === it.k}
              onClick={() => go(it.k)}
            >
              {it.label}
              {it.k === "attention" && <span className={styles.tabN}>8</span>}
            </button>
          ))}
        </nav>
        <span className={styles.spacer} />
        <span className={styles.demoTag}>demo · synthetic data</span>
        <span className={styles.chip}>operator/brain · main</span>
        <span className={styles.clock}>{fmt(START_SEC + t)}</span>
      </header>

      <div className={styles.scroller}>
        {screen === "overview" && (
          <Overview
            stream={stream}
            onInbox={() => go("attention")}
          />
        )}
        {screen === "ask" && <Ask />}
        {screen === "trends" && <Trends />}
        {screen === "corpus" && <Notes focus={focusNote} />}
        {screen === "attention" && (
          <Inbox
            onOpenNote={(path) => {
              setFocusNote(path);
              setScreen("corpus");
            }}
            onAsk={() => go("ask")}
          />
        )}
        {screen === "map" && (
          <div className={styles.mapBleed}>
            <iframe src="/map" title="Demo map — synthetic data" className={styles.mapFrame} />
          </div>
        )}
        {screen === "settings" && <Settings />}

        <footer className={styles.foot}>
          <span className={styles.footMark}>Cortex by Obelyth</span>
          <span className={styles.spacer} />
          <span className={styles.footTag}>build a3f19c72 · synthetic</span>
          <a className={styles.footLink} href="https://github.com/Obelyth/cortex" target="_blank" rel="noreferrer">
            GitHub
          </a>
          <span className={styles.footTag}>© 2026 Obelyth</span>
        </footer>
      </div>
    </div>
  );
}
