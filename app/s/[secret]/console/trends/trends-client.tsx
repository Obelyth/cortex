"use client";
import { createContext, useContext, useEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from "react";
import { useReaderSave } from "../use-reader-save";
import { useLens } from "../lens";
import {
  BANDS, CUT_OFF_CAVEAT, DAYS, HOUR, answeredFromMemory, argmax, byModel, clockHours, countBy, cutOff, dayOf, elapsedLabel, fmtWin, heatGrid, hourBins, hourOf,
  isAsk, memoryBuckets, p50, patternsOf, proven, scoredAsk, timedOut, type CallLite, type Pattern, type Tz,
} from "@/lib/trends";
import { ClockChart, DonutChart, MirrorChart, SHARE } from "./charts";

/**
 * The five Trends instruments and the one state they share — the cross-filter window. A pulse
 * hour (or a memory bucket) clicked sets it; the clock, the heat, the patterns and the readers
 * re-derive from the rows inside it; a second click, or any "· clear", lets it go. Every click
 * also opens the lens on the window's calls (L9), a pattern on its derivation (L10), a reader
 * on its asks (L11).
 *
 * The provider is a client boundary with server-rendered children: the `data-cx` entrance
 * wrappers around each instrument stay server nodes, so a state change here never strips the
 * reveal class the kinetic layer put on them.
 */

export interface ReaderLite {
  model: string;
  provider: string;
  configured: boolean;
  disabled: boolean;
  evalState: "measured" | "unstable" | "unmeasured";
  evalNote: string;
  isDefault: boolean;
}

interface Win { from: number; to: number; label: string }

interface Ctx {
  rows: CallLite[];
  now: number;
  hoursN: number;
  covers: number;
  /** "48 h" when the log fills the window, else "5 h of log". */
  span: string;
  win: Win | null;
  /** The rows the windowed instruments read: inside the window, or everything. */
  rowsW: CallLite[];
  tz: Tz;
  tzLabel: string;
  readers: ReaderLite[];
  writable: boolean;
  toggleWin: (from: number, to: number, label: string) => void;
  clearWin: () => void;
  openCalls: (title: string, id: string, rows: CallLite[], covered: boolean) => void;
  openPattern: (p: Pattern) => void;
  openReader: (model: string, rows: CallLite[]) => void;
}

const TrendsContext = createContext<Ctx | null>(null);
function useTrends(): Ctx {
  const c = useContext(TrendsContext);
  if (!c) throw new Error("a Trends instrument must sit inside TrendsProvider");
  return c;
}

const hhmm = (ts: number) => new Date(ts).toISOString().slice(11, 16);
/** "1 call", "2 calls" — the readouts say the number, not a template. */
const n = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"}`;

export function TrendsProvider({ rows, now, hoursN, covers, readers, writable, children }: Readonly<{
  rows: CallLite[]; now: number; hoursN: number; covers: number; readers: ReaderLite[]; writable: boolean; children: ReactNode;
}>) {
  const lens = useLens();
  const [win, setWin] = useState<Win | null>(null);
  // Wall-clock instruments run in the browser's zone once it is known. The server knows only
  // UTC, and a first paint that disagreed with hydration would be a mismatch — so both start at
  // utc and the browser moves to local after mount, saying which it is at all times.
  const [tz, setTz] = useState<Tz>("utc");
  useEffect(() => { setTz("local"); }, []);

  const rowsW = useMemo(() => (win ? rows.filter((r) => r.ts >= win.from && r.ts < win.to) : rows), [rows, win]);
  const span = hoursN === 48 ? "48 h" : `${hoursN} h of log`;

  const openCalls = (title: string, id: string, list: CallLite[], covered: boolean) => {
    const asks = list.filter(isAsk);
    const mem = asks.filter((r) => answeredFromMemory(r.stamp)).length;
    const fresh = asks.filter((r) => r.stamp === "NOT IN BRAIN").length;
    const errors = asks.filter((r) => r.stamp === "ERROR").length;
    const cut = asks.filter(cutOff).length;
    const timed = asks.filter(timedOut).length;
    const scored = asks.filter(scoredAsk).length;
    const desc = list.length
      ? `${list.length} call${list.length === 1 ? "" : "s"}, ${asks.length} of them ask${asks.length === 1 ? "" : "s"}. Every row is one tool call as the log recorded it — surface, tool, stamp and latency.`
      : covered
        ? "No calls in this window. Silence, not zero: the log covers it and nothing happened."
        : `No calls here. The log covers ${span} — this slot may fall before it began, so this is absence of log, not of calls.`;
    lens.open({
      kind: "call log · window",
      title,
      body: (
        <LensBody
          id={id}
          desc={desc}
          kv={[
            ["asks", asks.length ? `${asks.length} · ${mem} from memory · ${fresh} not in memory · ${errors} error${errors === 1 ? "" : "s"}${cut ? ` · ${cut} cut off by the platform` : ""}${timed ? ` · ${timed} timed out in budget` : ""}` : "0"],
            // Cut-offs and timeouts answered nothing, so like errors they leave the denominator;
            // a cut-off's ms is the wall and a timeout's is time spent not answering, so both
            // leave the latency figure too.
            ["from memory", asks.length ? `${Math.round((mem / Math.max(1, scored)) * 100)}%` : "—"],
            ["p50 latency", p50(asks.filter((r) => !r.cached && scoredAsk(r)).map((r) => r.ms))],
            ["by tool", list.length ? countBy(list, "tool") : "—"],
            ["by door", list.length ? countBy(list, "surface") : "—"],
          ]}
          tiesLabel={asks.length ? "Asks in this window · newest first" : null}
          ties={[...asks].sort((a, b) => b.ts - a.ts).slice(0, 14).map((r) => ({
            kind: r.stamp,
            label: `${hhmm(r.ts)} utc · ${r.model ?? "—"} · ${elapsedLabel(r)}`,
            why: `${r.surface}${r.cached ? " · served from cache" : ""}`,
          }))}
          actions={<a className="trLensAct trLensActPrimary" href="ask">Ask the brain now</a>}
          note={`rows are CallRow {ts, surface, tool, stamp, ms, model, cached, saved} · question text is never logged${cut ? ` · ${CUT_OFF_CAVEAT}` : ""}`}
        />
      ),
    });
  };

  const toggleWin = (from: number, to: number, label: string) => {
    const same = win !== null && win.from === from && win.to === to;
    setWin(same ? null : { from, to, label });
    if (!same) {
      openCalls(`Calls · ${label}`, `window ${label} · ${new Date(from).toISOString().slice(0, 16).replace("T", " ")} → ${hhmm(to)} utc`, rows.filter((r) => r.ts >= from && r.ts < to), true);
    }
  };

  const openPattern = (p: Pattern) => {
    lens.open({
      kind: "pattern",
      title: p.title,
      body: (
        <LensBody
          id={p.chip}
          desc={p.sub}
          kv={p.how}
          note="a pattern renders only when its premise holds in the data — it is never shown dimmed, it is not shown at all"
        />
      ),
    });
  };

  const openReader = (model: string, list: CallLite[]) => {
    const card = readers.find((c) => c.model === model) ?? null;
    lens.open({
      kind: "reader",
      title: model,
      // Keyed by model: the lens shell re-renders its body in place, and an unkeyed body would
      // carry one reader's "saved" state over to the next reader opened.
      body: <ReaderLensBody key={model} model={model} card={card} rows={list} writable={writable} />,
    });
  };

  const value: Ctx = {
    rows, now, hoursN, covers, span, win, rowsW, tz, tzLabel: tz === "local" ? "local time" : "utc", readers, writable,
    toggleWin, clearWin: () => setWin(null), openCalls, openPattern, openReader,
  };
  return <TrendsContext.Provider value={value}>{children}</TrendsContext.Provider>;
}

/** The measured content width of a trough, so a chart is drawn 1:1 with the grid it sits in. */
function useWidth<T extends HTMLElement>(fallback: number): [RefObject<T | null>, number] {
  const ref = useRef<T>(null);
  const [w, setW] = useState(fallback);
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver((entries) => {
      const width = entries[0]?.contentRect.width;
      if (width) setW(Math.max(240, Math.round(width)));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, w];
}

/** A section header: the label, a note, and the window's "· clear" while one is set. */
function Head({ label, children }: Readonly<{ label: string; children?: ReactNode }>) {
  const c = useTrends();
  return (
    <div className="trSecHead">
      <h2 className="trSecLabel">{label}</h2>
      <span className="trSecNote">
        {children}
        {c.win && (
          <button type="button" className="trWinClear" onClick={c.clearWin} aria-label={`clear the window ${c.win.label}`}>
            {c.win.label} · clear
          </button>
        )}
      </span>
    </div>
  );
}

/* ── W25 · the pulse, and the 24 h clock beside it ─────────────────────────── */

export function Pulse() {
  const c = useTrends();
  const [hover, setHover] = useState<number | null>(null);
  const [clockHover, setClockHover] = useState<number | null>(null);
  const [readout, setReadout] = useState("");
  const [ref, W] = useWidth<HTMLDivElement>(1092);

  const bins = useMemo(() => hourBins(c.rows, c.now, c.hoursN), [c.rows, c.now, c.hoursN]);
  const calls = bins.map((b) => b.calls);
  const total = calls.reduce((a, n) => a + n, 0);
  const peak = total ? argmax(calls) : null;
  const tickN = Math.min(5, c.hoursN + 1);
  const ticks = Array.from({ length: tickN }, (_, i) => (i === tickN - 1 ? "now" : `-${Math.round(c.hoursN * (1 - i / (tickN - 1)))}h`));

  const byHour = useMemo(() => clockHours(c.rowsW, c.tz), [c.rowsW, c.tz]);
  const peakHour = c.rowsW.length ? argmax(byHour) : null;
  const hh2 = (n: number) => String(n).padStart(2, "0");
  const hourLabel = (i: number) => `${hh2(i)}:00–${hh2((i + 1) % 24)}:00 ${c.tzLabel}`;

  const meta = total
    ? `${n(c.rows.length, "call")} · peak ${bins[peak!].calls} at ${fmtWin(bins[peak!].from, bins[peak!].to, c.now)} · click an hour to open it`
    : `no calls in ${c.span}`;

  return (
    <section className="trSec" aria-label="Pulse" onMouseLeave={() => { setReadout(""); setHover(null); setClockHover(null); }}>
      <Head label={`Pulse · calls per hour · ${c.span}`}><span className="trSecMeta">{meta}</span></Head>
      <div className="trPulse">
        <div className="trTrough trPulseTrough" ref={ref}>
          <MirrorChart
            id="pulse"
            W={W}
            H={230}
            up={{ vals: bins.map((b) => b.calls - b.asks), label: "reads & writes", tone: "steel", hoverTone: "bright" }}
            down={{ vals: bins.map((b) => b.asks), label: "asks", tone: "snow", hoverTone: "accent" }}
            ticks={ticks}
            hover={hover}
            peak={peak}
            hit={{
              label: (i) => `${fmtWin(bins[i].from, bins[i].to, c.now)} · ${n(bins[i].calls, "call")} · ${n(bins[i].asks, "ask")}`,
              onHover: (i) => {
                setHover(i);
                setReadout(`${fmtWin(bins[i].from, bins[i].to, c.now)} · ${n(bins[i].calls, "call")} · ${n(bins[i].asks, "ask")}${i === peak ? " · the peak hour" : ""}`);
              },
              onLeave: () => { setHover(null); setReadout(""); },
              onClick: (i) => c.toggleWin(bins[i].from, bins[i].to, fmtWin(bins[i].from, bins[i].to, c.now)),
            }}
          />
        </div>
        <div className="trClockCol">
          <ClockChart
            vals={byHour}
            total={String(c.rowsW.length)}
            hover={clockHover}
            peak={peakHour}
            hit={{
              label: (i) => `${hourLabel(i)} · ${n(byHour[i], "call")}`,
              onHover: (i) => {
                setClockHover(i);
                setReadout(`${hourLabel(i)} · ${n(byHour[i], "call")} · ${n(c.rowsW.filter((r) => hourOf(r.ts, c.tz) === i && isAsk(r)).length, "ask")}${i === peakHour ? " · peak" : ""}`);
              },
              onLeave: () => { setClockHover(null); setReadout(""); },
              onClick: (i) => c.openCalls(`Calls · ${hourLabel(i)}`, `hour ${i} · every day in the window · ${c.tzLabel}`, c.rowsW.filter((r) => hourOf(r.ts, c.tz) === i), c.hoursN >= 24),
            }}
          />
          <div className="trClockCap">
            {peakHour === null
              ? `no calls in the window · ${c.tzLabel}`
              : <>peak hour <b className="trAmber">{hh2(peakHour)}:00</b> · {n(byHour[peakHour], "call")} in that hour · {Math.round((byHour[peakHour] / Math.max(1, c.rowsW.length)) * 100)}% of the window · {c.tzLabel}</>}
          </div>
        </div>
      </div>
      <div className="trReadout" aria-live="polite">{readout || "hover an hour or a wedge · click to open it in the lens · a second click on an hour clears the window"}</div>
    </section>
  );
}

/* ── W20 · answers from memory vs not, across the window ──────────────────── */

export function MemoryVsTyping() {
  const c = useTrends();
  const [hover, setHover] = useState<number | null>(null);
  const [readout, setReadout] = useState("");
  const [ref, W] = useWidth<HTMLDivElement>(648);
  const buckets = useMemo(() => memoryBuckets(c.rows, c.now, c.hoursN), [c.rows, c.now, c.hoursN]);
  const asks = c.rows.filter(isAsk).length;

  const line = (i: number) => {
    const b = buckets[i];
    const share = b.memory + b.fresh ? Math.round((b.memory / (b.memory + b.fresh)) * 100) : null;
    return `${fmtWin(b.from, b.to, c.now)} · ${n(b.all, "ask")} · ${b.memory} from memory · ${b.fresh} not in memory${share === null ? "" : ` · ${share}% answered from memory`}`;
  };

  return (
    <section className="trSec" aria-label="Answers, memory vs typing" onMouseLeave={() => { setReadout(""); setHover(null); }}>
      <Head label={`Answers · memory vs typing · ${c.span}`}>
        <span className="trSw"><i className="trSwSnow" />▲ from memory</span>
        <span className="trSw"><i className="trSwAmber" />▼ not in memory</span>
      </Head>
      {asks === 0 ? (
        <div className="trNone">no asks in {c.span} yet — the chart fills from the first stamped answer</div>
      ) : (
        <div className="trTrough trMemTrough" ref={ref}>
          <MirrorChart
            id="mem"
            W={W}
            H={210}
            up={{ vals: buckets.map((b) => b.memory), label: "from memory", tone: "snow", hoverTone: "accent" }}
            down={{ vals: buckets.map((b) => b.fresh), label: "not in memory", tone: "amber", hoverTone: "bright" }}
            ticks={buckets.map((b) => b.label)}
            hover={hover}
            hit={{
              label: line,
              onHover: (i) => { setHover(i); setReadout(line(i)); },
              onLeave: () => { setHover(null); setReadout(""); },
              onClick: (i) => c.toggleWin(buckets[i].from, buckets[i].to, fmtWin(buckets[i].from, buckets[i].to, c.now)),
            }}
          />
        </div>
      )}
      <div className="trReadout" aria-live="polite">{readout || "▲ answered from memory · ▼ not in memory · click a window to open it"}</div>
    </section>
  );
}

/* ── W21 · patterns the window can back ───────────────────────────────────── */

function windowBounds(c: Ctx): { from: number; to: number; label: string } {
  return c.win ? { from: c.win.from, to: c.win.to, label: c.win.label } : { from: c.now - c.hoursN * HOUR, to: c.now, label: c.span };
}

export function Patterns() {
  const c = useTrends();
  const { from, to, label } = windowBounds(c);
  const heat = useMemo(() => heatGrid(c.rowsW, c.tz), [c.rowsW, c.tz]);
  const patterns = useMemo(() => patternsOf({ rows: c.rowsW, heat, from, to, windowLabel: label }), [c.rowsW, heat, from, to, label]);
  return (
    <section className="trSec" aria-label="Patterns">
      <Head label="Patterns"><span className="trSecMeta">read from {label}</span></Head>
      {patterns.map((p) => (
        <button key={p.title} type="button" className="trRow trPat" onClick={() => c.openPattern(p)}>
          <span className={`trPatArrow ${p.pop ? "trAmber" : "trSteel"}`} aria-hidden>{p.up ? "↗" : "↘"}</span>
          <span className="trRowBody">
            <span className="trRowTitle">{p.title}</span>
            <span className="trRowSub">{p.sub}</span>
          </span>
          <span className={`trChip ${p.pop ? "trAmber" : "trSteel"}`}>{p.chip}</span>
        </button>
      ))}
      {patterns.length === 0 && <div className="trNone">no patterns the window can back — they appear as calls accrue</div>}
    </section>
  );
}

/* ── W22 · busy hours, 6 bands × 7 days ───────────────────────────────────── */

export function BusyHours() {
  const c = useTrends();
  const [readout, setReadout] = useState("");
  const heat = useMemo(() => heatGrid(c.rowsW, c.tz), [c.rowsW, c.tz]);
  const heatMax = Math.max(0, ...heat.flat());
  const level = (v: number) => (v === 0 ? "trHeatNone" : v === heatMax ? "trHeatPeak" : v / heatMax > 0.66 ? "trHeatHigh" : v / heatMax > 0.33 ? "trHeatMid" : "trHeatLow");
  const cellRows = (bi: number, di: number) => c.rowsW.filter((r) => Math.floor(hourOf(r.ts, c.tz) / 4) === bi && dayOf(r.ts, c.tz) === di);
  return (
    <section className="trSec" aria-label="Busy hours" onMouseLeave={() => setReadout("")}>
      <Head label="Busy hours · by hour of day">
        <span className="trSecMeta">{c.covers < 7 * 24 * HOUR ? "a sketch until a week accrues" : "full week"} · {c.tzLabel}</span>
      </Head>
      <div className="trHeat" role="grid" aria-label="calls by weekday and four-hour band">
        <span />
        {DAYS.map((d) => <span key={d} className="trHeatDay">{d}</span>)}
        {heat.map((band, bi) => (
          <HeatRow key={BANDS[bi]} band={BANDS[bi]}>
            {band.map((v, di) => {
              const title = `${DAYS[di]} ${BANDS[bi]} · ${n(v, "call")}`;
              return (
                <button
                  key={DAYS[di]}
                  type="button"
                  className={`trHeatCell ${level(v)}`}
                  aria-label={title}
                  onMouseEnter={() => setReadout(title + (v && v === heatMax ? " · peak" : ""))}
                  onFocus={() => setReadout(title + (v && v === heatMax ? " · peak" : ""))}
                  onClick={() => c.openCalls(`Calls · ${DAYS[di]} ${BANDS[bi]}–${BANDS[(bi + 1) % 6]}`, `${DAYS[di]} · band ${bi} · ${c.tzLabel}`, cellRows(bi, di), c.hoursN >= 168)}
                />
              );
            })}
          </HeatRow>
        ))}
      </div>
      <div className="trHeatKey">
        <span className="trKey"><i className="trHeatNone" />none</span>
        <span className="trKey"><i className="trHeatLow" />low</span>
        <span className="trKey"><i className="trHeatMid" />mid</span>
        <span className="trKey"><i className="trHeatHigh" />high</span>
        <span className="trKey"><i className="trHeatPeak" />peak</span>
        <span className="trSpacer" />
        <span className="trHeatRead" aria-live="polite">{readout || "hover an hour · click to list its calls"}</span>
      </div>
    </section>
  );
}

function HeatRow({ band, children }: Readonly<{ band: string; children: ReactNode }>) {
  return (
    <>
      <span className="trHeatBand">{band}</span>
      {children}
    </>
  );
}

/* ── W23 · who answered ───────────────────────────────────────────────────── */

export function WhoAnswered() {
  const c = useTrends();
  const [hover, setHover] = useState<number | null>(null);
  const asks = useMemo(() => c.rowsW.filter(isAsk), [c.rowsW]);
  const shares = useMemo(() => byModel(asks), [asks]);
  const attributed = asks.filter((r) => r.model).length;
  return (
    <section className="trSec" aria-label="Who answered">
      <Head label={`Who answered · ${c.span}`}><a className="trSecLink" href="settings">models ›</a></Head>
      <div className="trWho">
        <div className="trDonutBox">
          <DonutChart segs={shares.map((m, i) => ({ pct: m.pct, cls: SHARE[i % SHARE.length] }))} center={String(attributed)} sub="ASKS" hover={hover} onHover={setHover} onLeave={() => setHover(null)} />
        </div>
        <div className="trWhoList">
          {shares.map((m, i) => (
            <button
              key={m.model}
              type="button"
              className={`trRow trModel${hover === i ? " trRowOn" : ""}`}
              onMouseEnter={() => setHover(i)}
              onMouseLeave={() => setHover(null)}
              onClick={() => c.openReader(m.model, asks.filter((r) => r.model === m.model))}
            >
              <i className={`trDot ${SHARE[i % SHARE.length]}`} aria-hidden />
              <span className="trRowBody">
                <span className="trModelName">{m.model}</span>
                <span className="trRowSub">{n(m.n, "ask")} · {m.ok} proven · p50 {m.p50}</span>
              </span>
              <span className="trPct">{m.pct}%</span>
            </button>
          ))}
          {shares.length === 0 && <div className="trNone">no attributed asks in the window</div>}
        </div>
      </div>
    </section>
  );
}

/* ── The lens bodies ──────────────────────────────────────────────────────── */

function LensBody({ id, desc, kv, tiesLabel, ties, actions, note }: Readonly<{
  id: string;
  desc: string;
  kv: ReadonlyArray<readonly [string, string]>;
  tiesLabel?: string | null;
  ties?: Array<{ kind: string; label: string; why?: string }>;
  actions?: ReactNode;
  note?: string;
}>) {
  return (
    <div className="trLens">
      <div className="trLensId">{id}</div>
      <p className="trLensDesc">{desc}</p>
      <dl className="trLensKv">
        {kv.map(([k, v]) => (
          <div key={k} className="trLensRow">
            <dt className="trLensK">{k}</dt>
            <dd className="trLensV">{v}</dd>
          </div>
        ))}
      </dl>
      {tiesLabel && ties && ties.length > 0 && (
        <>
          <div className="trLensTiesLabel">{tiesLabel}</div>
          <ul className="trLensTies">
            {ties.map((t, i) => (
              <li key={i} className="trLensTie">
                <span className="trLensTieKind">{t.kind}</span>
                <span className="trRowBody">
                  <span className="trLensTieLabel">{t.label}</span>
                  {t.why && <span className="trLensTieWhy">{t.why}</span>}
                </span>
              </li>
            ))}
          </ul>
        </>
      )}
      {actions && <div className="trLensActions">{actions}</div>}
      {note && <div className="trLensNote">{note}</div>}
    </div>
  );
}

/** L11 — a reader: its card, its asks in the window, and "Make default" → settings/save (S1). */
function ReaderLensBody({ model, card, rows, writable }: Readonly<{ model: string; card: ReaderLite | null; rows: CallLite[]; writable: boolean }>) {
  // One save path for the reader, shared with the overview select and the models table — the
  // hook owns the URL derivation, the POST, the refresh and what a refusal says.
  const { pending, error: why, save } = useReaderSave();
  const [saved, setSaved] = useState(card?.isDefault === true);
  const measured = rows.filter((r) => !r.cached);
  const state: "idle" | "busy" | "done" | "failed" = pending ? "busy" : saved ? "done" : why ? "failed" : "idle";
  const canMake = writable && !!card && card.configured && !card.disabled && (state === "idle" || state === "failed");

  async function makeDefault() {
    setSaved(await save(model));
  }

  return (
    <LensBody
      id={card ? `${card.provider} · ${card.configured ? "key set" : "key missing"}${card.disabled ? " · provider off" : ""}${state === "done" ? " · default" : ""}` : `${model} · not on the current allowlist`}
      desc={card ? card.evalNote : "this reader answered in the window but is no longer an allowed model — its record stays, its chair is gone"}
      kv={[
        ["eval", card ? card.evalState : "—"],
        ["asks · window", String(rows.length)],
        ["proven", `${rows.filter((r) => proven(r.stamp)).length} verified + corrected`],
        ["unverified", String(rows.filter((r) => r.stamp === "UNVERIFIED").length)],
        ["p50 latency", measured.length ? `${p50(measured.map((r) => r.ms))}${measured.length < rows.length ? ` · ${rows.length - measured.length} cached, not timed` : ""}` : "—"],
      ]}
      tiesLabel={rows.length ? "Its asks · newest first" : null}
      ties={[...rows].sort((a, b) => b.ts - a.ts).slice(0, 10).map((r) => ({ kind: r.stamp, label: `${hhmm(r.ts)} utc · ${r.cached ? "cached" : elapsedLabel(r)}`, why: r.surface }))}
      actions={
        <>
          <button type="button" className="trLensAct trLensActPrimary" disabled={!canMake} onClick={() => void makeDefault()}>
            {state === "busy" ? "Saving…" : state === "done" ? "Default" : "Make default"}
          </button>
          <a className="trLensAct" href="settings">Open settings</a>
          {why && <span className="trLensWhy" role="alert">{why}</span>}
          {!writable && state !== "done" && <span className="trLensWhy">no settings store — set READER_MODEL in the environment</span>}
        </>
      }
      note="the default follows the measurement, not the logo — a reader takes the chair by beating the labelled eval"
    />
  );
}
