"use client";
import { useState } from "react";

export interface ChartBucket {
  label: string;
  memory: number;
  fresh: number;
}

/**
 * The design's "Answers · memory vs typing" line chart: smooth cubic paths, a cyan
 * memory line over a gradient fill, a dashed line for questions the brain could not answer,
 * and hover zones that pin a tooltip pair to the nearest bucket. Client-side only for the
 * hover state — the buckets arrive computed from the server's call log.
 */
const W = 600;
const H = 180;
const XA = 12;
const XB = W - 12;
const YT = 18;
const YB = H - 12;

function points(vals: number[], max: number): Array<[number, number]> {
  const n = Math.max(2, vals.length);
  return vals.map((v, i) => [
    XA + ((XB - XA) * i) / (n - 1),
    YB - ((YB - YT) * v) / max,
  ]);
}

function path(pts: Array<[number, number]>): string {
  return pts.reduce((d, p, i) => {
    if (i === 0) return `M${p[0]},${p[1]}`;
    const q = pts[i - 1];
    const m = (q[0] + p[0]) / 2;
    return `${d} C${m},${q[1]} ${m},${p[1]} ${p[0]},${p[1]}`;
  }, "");
}

export function MemoryChart({ buckets }: Readonly<{ buckets: ChartBucket[] }>) {
  // First paint pins the busiest bucket — a tooltip reading 0/0 teaches nothing.
  const busiest = buckets.reduce((bi, b, i) => (b.memory + b.fresh > buckets[bi].memory + buckets[bi].fresh ? i : bi), 0);
  const [sel, setSel] = useState(busiest);
  const max = Math.max(1, ...buckets.map((b) => Math.max(b.memory, b.fresh)));
  const pm = points(buckets.map((b) => b.memory), max);
  const pf = points(buckets.map((b) => b.fresh), max);
  const memD = path(pm);
  const freshD = path(pf);
  const fillD = `${memD} L${XB},${YB} L${XA},${YB} Z`;
  const i = Math.min(sel, buckets.length - 1);
  const tipLeft = `${((pm[i][0] / W) * 100).toFixed(2)}%`;
  const flip = i >= buckets.length - 2;

  return (
    <>
      <div className="mcPlot">
        <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" aria-hidden>
          <defs>
            <linearGradient id="mcFill" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0" stopColor="var(--accent)" stopOpacity="0.2" />
              <stop offset="1" stopColor="var(--accent)" stopOpacity="0" />
            </linearGradient>
          </defs>
          <path d={fillD} fill="url(#mcFill)" stroke="none" />
          <path d={freshD} fill="none" stroke="var(--faint)" strokeWidth="1.5" strokeDasharray="5 5" vectorEffect="non-scaling-stroke" />
          <path d={memD} fill="none" stroke="var(--accent)" strokeWidth="2" vectorEffect="non-scaling-stroke" />
        </svg>
        <span className="mcRule" style={{ left: tipLeft }} />
        <span className="mcDot mcDotMem" style={{ left: tipLeft, top: `${((pm[i][1] / H) * 100).toFixed(2)}%` }} />
        <span className="mcDot" style={{ left: tipLeft, top: `${((pf[i][1] / H) * 100).toFixed(2)}%` }} />
        <span
          className="mcTags"
          style={flip
            ? { left: `calc(${tipLeft} - 12px)`, transform: "translateX(-100%)" }
            : { left: `calc(${tipLeft} + 12px)` }}
        >
          <span className="mcTag mcTagMem"><i />{buckets[i].memory} from memory</span>
          <span className="mcTag"><i />{buckets[i].fresh} not in memory</span>
        </span>
        <span className="mcZones">
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
      <div className="mcAxis">
        {buckets.map((b) => <span key={b.label}>{b.label}</span>)}
      </div>
    </>
  );
}
