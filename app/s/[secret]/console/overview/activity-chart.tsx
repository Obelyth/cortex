"use client";
import { useEffect, useRef, useState } from "react";
import { chartNote, MAX_BAND, type Activity, type RangeKey } from "@/lib/overview";
import { useLens } from "../lens";
import { callsLens } from "./lens-bodies";

/**
 * Activity (W10): the 30-day call log bucketed by hour or day, drawn as v2's mirrored bars —
 * reads & writes up, asks down, amber on the peak. The three ranges arrive precomputed from the
 * server with every bucket's call window already summarised, so a click opens the lens (L9) on
 * the rows that bucket counted without a second read. The SVG is drawn in screen pixels: the
 * trough is measured after mount and the viewBox follows it, so text never scales with the grid.
 *
 * The peak is the busiest bucket by total calls and both its halves carry the mark. Only the
 * reads & writes bar carried it before, so an hour that was all asks won the peak with a
 * zero-height up bar: amber on nothing, while the readout said "· peak" and the legend pointed
 * at an empty column.
 *
 * The svg is a group, not an image: role="img" makes its descendants presentational, which took
 * the focusable per-bucket buttons out of the accessibility tree entirely — they kept DOM focus
 * and announced as nothing. role="group" carries the same summary label without flattening them.
 */
const L = 30, R = 10, T = 22, B = 26, H = 190;
const IDLE = "hover or tab for the count · click or press Enter to list a bucket’s calls";
const RANGES: Array<[RangeKey, string]> = [["day", "24 h"], ["week", "week"], ["month", "month"]];

export function ActivityChart({ a }: Readonly<{ a: Activity }>) {
  const lens = useLens();
  const [range, setRange] = useState<RangeKey>("day");
  const [hover, setHover] = useState<number | null>(null);
  const [W, setW] = useState(600);
  const trough = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = trough.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setW(Math.max(240, Math.round(el.clientWidth - 16))));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const r = a[range];
  const bs = r.buckets;
  const n = bs.length;
  const up = bs.map((b) => b.n - b.asks);
  const down = bs.map((b) => b.asks);
  const maxU = Math.max(1, ...up), maxD = Math.max(1, ...down);
  const mid = T + (H - T - B) * (maxU / (maxU + maxD));
  const slot = (W - L - R) / n;
  const bw = Math.max(2, Math.min(14, slot * 0.62));
  const x = (i: number) => L + i * slot + slot / 2;
  const total = bs.reduce((s, b) => s + b.n, 0);
  const peak = total ? bs.reduce((p, b, i) => (b.n > bs[p].n ? i : p), 0) : null;
  const pick = (k: RangeKey) => { setRange(k); setHover(null); };
  const open = (i: number) => lens.open(callsLens(`Calls · ${bs[i].label}`, `${range} view · bucket ${i + 1} of ${n} · ${new Date(bs[i].from).toISOString().slice(0, 16)} → ${new Date(bs[i].to).toISOString().slice(11, 16)} utc`, bs[i].win));
  const note = chartNote(r.note, a.callsNote, total);
  const readout = hover === null
    ? total === 0 ? `no calls in this window · ${r.note ?? "the log covers it"}` : IDLE
    : `${bs[hover].label} · ${bs[hover].n} call${bs[hover].n === 1 ? "" : "s"} · ${bs[hover].asks} ask${bs[hover].asks === 1 ? "" : "s"}${hover === peak ? " · peak" : ""}`;

  return (
    <>
      <div className="ovPanelHead">
        <h2 className="ovPanelTitle" id="ov-activity">Activity · tool calls</h2>
        <span className="ovRanges" role="group" aria-label="window">
          {RANGES.map(([k, label]) => (
            <button key={k} type="button" className={`ovRange${range === k ? " ovRangeOn" : ""}`} aria-pressed={range === k} onClick={() => pick(k)}>{label}</button>
          ))}
        </span>
      </div>
      <div className="ovTrough" ref={trough}>
        <svg className="ovChart" viewBox={`0 0 ${W} ${H}`} width="100%" role="group" aria-label={`${total} tool calls over the ${range === "day" ? "last 24 hours" : range === "week" ? "last 7 days" : "last 30 days"}, ${bs.reduce((s, b) => s + b.asks, 0)} of them asks — ${note}`} onMouseLeave={() => setHover(null)}>
          <line className="ovAxisMid" x1={L} x2={W - R} y1={mid} y2={mid} />
          <text className="ovAxisText" x={L - 4} y={T + 4} textAnchor="end">{maxU}</text>
          <text className="ovAxisText" x={L - 4} y={H - B} textAnchor="end">{maxD}</text>
          {bs.map((b, i) => {
            const hu = (up[i] / maxU) * (mid - T);
            const hd = (down[i] / maxD) * (H - B - mid);
            const on = hover === i;
            const band = Math.min(MAX_BAND, Math.floor((80 + i * 10) / 70));
            return (
              <g key={`${range}-${i}`}>
                <rect className={`ovBarUp${i === peak ? " ovBarPeak" : on ? " ovBarUpOn" : ""} ovD${band}`} x={x(i) - bw / 2} y={mid - hu} width={bw} height={Math.max(0, hu)} rx={1.5} opacity={on || i === peak ? 1 : 0.35 + (up[i] / maxU) * 0.65} />
                <rect className={`ovBarDown${i === peak ? " ovBarPeak" : on ? " ovBarDownOn" : ""} ovD${band}`} x={x(i) - bw / 2} y={mid} width={bw} height={Math.max(0, hd)} rx={1.5} opacity={on || i === peak ? 1 : 0.35 + (down[i] / maxD) * 0.65} />
                <rect
                  className={`ovHit${on ? " ovHitOn" : ""}`}
                  x={x(i) - slot / 2} y={0} width={slot} height={H}
                  tabIndex={0} role="button"
                  aria-label={`${b.label}: ${b.n} calls, ${b.asks} asks — open the window`}
                  onMouseEnter={() => setHover(i)} onFocus={() => setHover(i)}
                  onClick={() => open(i)}
                  onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); open(i); } }}
                />
              </g>
            );
          })}
          {r.ticks.map((t, i) => (
            <text key={t + i} className="ovAxisText" x={L + (r.ticks.length === 1 ? 0 : (i / (r.ticks.length - 1)) * (W - L - R))} y={H - 8} textAnchor={i === 0 ? "start" : i === r.ticks.length - 1 ? "end" : "middle"}>{t}</text>
          ))}
          {hover === null
            ? <text className="ovChartLegend" x={W - R} y={T - 8} textAnchor="end">{"▲ reads & writes   ▼ asks   ▮ peak"}</text>
            : <text className="ovChartHover" x={x(hover) < (L + W) / 2 ? Math.max(L, x(hover) - bw / 2) : Math.min(W - R, x(hover) + bw / 2)} y={T - 8} textAnchor={x(hover) < (L + W) / 2 ? "start" : "end"}>{`${up[hover]} reads & writes · ${down[hover]} asks`}</text>}
        </svg>
      </div>
      <div className="ovActRead" aria-live="polite">{readout}</div>
      <div className="ovActNote">{note}</div>
    </>
  );
}
