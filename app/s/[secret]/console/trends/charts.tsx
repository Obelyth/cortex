/**
 * The Trends instruments' drawings — inline SVG in screen pixels, no chart library, no canvas,
 * nothing on a loop. Every colour is a class carrying a token: steel and amber, cyan only on
 * the thing under the cursor. Hover and click ride hit rects; the drawing itself is inert.
 *
 * Plain components with no hooks, so the strip's sparkline renders on the server and the
 * mirrored bars, the clock and the donut render inside the client instruments alike.
 */

type Tone = "steel" | "snow" | "amber";
type Series = { vals: number[]; label: string; tone: Tone; hoverTone: "accent" | "bright" };
type Hit = { onHover?: (i: number) => void; onLeave?: () => void; onClick?: (i: number) => void; label: (i: number) => string };

function grade(f: number, lo: number, span: number): string {
  return (lo + f * span).toFixed(2);
}

/** A hit rect: hover, click, and the keyboard's Enter/Space, with the readout as its name. */
function hit(props: { x: number; y: number; w: number; h: number; i: number; hit: Hit; on: boolean; className: string }) {
  const { x, y, w, h, i, hit: H, on, className } = props;
  return (
    <rect
      className={`${className}${on ? " trHitOn" : ""}${H.onClick ? " trHitGo" : ""}`}
      x={x} y={y} width={w} height={h}
      role={H.onClick ? "button" : undefined}
      tabIndex={H.onClick ? 0 : undefined}
      aria-label={H.label(i)}
      onMouseEnter={() => H.onHover?.(i)}
      onFocus={() => H.onHover?.(i)}
      onClick={() => H.onClick?.(i)}
      onKeyDown={(e) => { if (H.onClick && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); H.onClick(i); } }}
    />
  );
}

/**
 * Mirrored bars: `up` rises from the midline, `down` hangs from it. The peak bar is amber; the
 * hovered slot swaps to cyan (and its partner to bright); every other bar is its tone graded
 * by its share of the series' maximum.
 */
export function MirrorChart(props: Readonly<{
  id: string;
  up: Series;
  down: Series;
  W: number;
  H: number;
  ticks: string[];
  hover: number | null;
  peak?: number | null;
  hit: Hit;
}>) {
  const { id, up, down, W, H, ticks, hover, peak, hit: H_ } = props;
  const L = 30, R = 10, T = 22, B = 26;
  const n = up.vals.length;
  const maxU = Math.max(1, ...up.vals), maxD = Math.max(1, ...down.vals);
  const mid = T + (H - T - B) * (maxU / (maxU + maxD));
  const slot = (W - L - R) / Math.max(1, n);
  const bw = Math.max(2, Math.min(14, slot * 0.62));
  const x = (i: number) => L + i * slot + slot / 2;
  const tickX = (i: number) => L + (ticks.length === 1 ? 0 : (i / (ticks.length - 1)) * (W - L - R));
  const label = hover === null ? null : `${up.vals[hover]} ${up.label} · ${down.vals[hover] ?? 0} ${down.label}`;
  const left = hover !== null && x(hover) < (L + W) / 2;

  return (
    <svg className="trChart" viewBox={`0 0 ${W} ${H}`} width="100%" role="img" aria-label={`${up.label} above the line, ${down.label} below, one bar per slot`} onMouseLeave={() => H_.onLeave?.()}>
      <line className="trMid" x1={L} x2={W - R} y1={mid} y2={mid} />
      <text className="trAxis trAxisEnd" x={L - 4} y={T + 4}>{maxU}</text>
      <text className="trAxis trAxisEnd" x={L - 4} y={H - B}>{maxD}</text>
      {up.vals.map((v, i) => {
        const hu = (v / maxU) * (mid - T);
        const dv = down.vals[i] ?? 0;
        const hd = (dv / maxD) * (H - B - mid);
        const on = hover === i;
        const upCls = i === peak ? "trBarPeak" : on ? (up.hoverTone === "accent" ? "trBarHover" : "trBarBright") : `trBar-${up.tone}`;
        const dnCls = on ? (down.hoverTone === "accent" ? "trBarHover" : "trBarBright") : `trBar-${down.tone}`;
        return (
          <g key={i}>
            {hit({ x: x(i) - slot / 2, y: 0, w: slot, h: H, i, hit: H_, on, className: "trHit" })}
            <rect className={`trBar trBarUp ${upCls}`} x={x(i) - bw / 2} y={mid - hu} width={bw} height={Math.max(0, hu)} rx={1.5} opacity={on || i === peak ? 1 : grade(v / maxU, 0.3, 0.6)} />
            <rect className={`trBar trBarDown ${dnCls}`} x={x(i) - bw / 2} y={mid} width={bw} height={Math.max(0, hd)} rx={1.5} opacity={on ? 1 : grade(dv / maxD, 0.35, 0.6)} />
          </g>
        );
      })}
      {label !== null && hover !== null && (
        <text className={`trRead${left ? "" : " trAxisEnd"}`} x={left ? Math.max(L, x(hover) - bw / 2) : Math.min(W - R, x(hover) + bw / 2)} y={T - 8}>{label}</text>
      )}
      {ticks.map((t, i) => (
        <text key={`${id}-t${i}`} className={`trAxis${i === 0 ? "" : i === ticks.length - 1 ? " trAxisEnd" : " trAxisMid"}`} x={tickX(i)} y={H - 8}>{t}</text>
      ))}
      {hover === null && <text className="trAxis trAxisEnd trLegend" x={W - R} y={T - 8}>{`▲ ${up.label}   ▼ ${down.label}`}</text>}
    </svg>
  );
}

/** The 24 h clock: one steel wedge per hour of day, the peak amber, the hovered one cyan. */
export function ClockChart(props: Readonly<{ vals: number[]; total: string; hover: number | null; peak: number | null; hit: Hit }>) {
  const { vals, total, hover, peak, hit: H_ } = props;
  const S = 260, C = 130, r0 = 40, R1 = 116;
  const max = Math.max(1, ...vals);
  const arc = (i: number, r: number) => {
    const a0 = ((-90 + i * 15 + 1.2) * Math.PI) / 180, a1 = ((-90 + (i + 1) * 15 - 1.2) * Math.PI) / 180;
    const p = (rr: number, a: number) => [C + rr * Math.cos(a), C + rr * Math.sin(a)] as const;
    const [x0, y0] = p(r0, a0), [x1, y1] = p(r, a0), [x2, y2] = p(r, a1), [x3, y3] = p(r0, a1);
    return `M${x0} ${y0} L${x1} ${y1} A${r} ${r} 0 0 1 ${x2} ${y2} L${x3} ${y3} A${r0} ${r0} 0 0 0 ${x0} ${y0} Z`;
  };
  return (
    <svg className="trClock" viewBox={`0 0 ${S} ${S}`} width="100%" role="img" aria-label="calls by hour of day, one wedge per hour" onMouseLeave={() => H_.onLeave?.()}>
      {[0.33, 0.66, 1].map((f) => (
        <circle key={f} className="trRing" cx={C} cy={C} r={r0 + 6 + f * (R1 - r0 - 6)} />
      ))}
      {vals.map((v, i) => {
        const r = r0 + 6 + (v / max) * (R1 - r0 - 6);
        const on = hover === i;
        const cls = i === peak ? "trWedgePeak" : on ? "trWedgeHover" : v === 0 ? "trWedgeNone" : "trWedge-steel";
        return (
          <g key={i}>
            <path className={`trWedge ${cls}`} d={arc(i, r)} opacity={on || i === peak || v === 0 ? 1 : grade(v / max, 0.22, 0.6)} />
            <path
              className={`trHit${on ? " trHitOn" : ""}${H_.onClick ? " trHitGo" : ""}`}
              d={arc(i, R1)}
              role={H_.onClick ? "button" : undefined}
              tabIndex={H_.onClick ? 0 : undefined}
              aria-label={H_.label(i)}
              onMouseEnter={() => H_.onHover?.(i)}
              onFocus={() => H_.onHover?.(i)}
              onClick={() => H_.onClick?.(i)}
              onKeyDown={(e) => { if (H_.onClick && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); H_.onClick(i); } }}
            />
          </g>
        );
      })}
      {([[0, "00"], [6, "06"], [12, "12"], [18, "18"]] as const).map(([hh, t]) => {
        const a = ((-90 + hh * 15 + 7.5) * Math.PI) / 180;
        return <text key={t} className="trAxis trAxisMid" x={C + (R1 + 9) * Math.cos(a)} y={C + (R1 + 9) * Math.sin(a) + 3}>{t}</text>;
      })}
      <circle className="trClockHub" cx={C} cy={C} r={r0 - 2} />
      <text className="trClockN" x={C} y={C + 1}>{total}</text>
      <text className="trClockSub" x={C} y={C + 14}>CALLS</text>
    </svg>
  );
}

/** Share by reader: steel leads, then amber, snow, green, the disabled grey. */
export const SHARE = ["trArc-steel", "trArc-amber", "trArc-snow", "trArc-ok", "trArc-grey"] as const;

export function DonutChart(props: Readonly<{ segs: Array<{ pct: number; cls: string }>; center: string; sub: string; hover: number | null; onHover: (i: number) => void; onLeave: () => void }>) {
  const { segs, center, sub, hover, onHover, onLeave } = props;
  const S = 150, C = 75, r = 58;
  let acc = 0;
  return (
    <svg className="trDonut" viewBox={`0 0 ${S} ${S}`} width="100%" role="img" aria-label="share of asks by reader" onMouseLeave={onLeave}>
      <circle className="trDonutTrack" cx={C} cy={C} r={r} />
      {segs.map((sg, i) => {
        const on = Math.max(0, sg.pct - 1);
        const el = (
          <circle
            key={i}
            className={`trArc ${sg.cls}${hover === i ? " trArcOn" : ""}`}
            cx={C} cy={C} r={r}
            pathLength={100}
            strokeDasharray={`${on} ${100 - on}`}
            strokeDashoffset={-acc}
            transform={`rotate(-90 ${C} ${C})`}
            onMouseEnter={() => onHover(i)}
          />
        );
        acc += sg.pct;
        return el;
      })}
      <text className="trDonutN" x={C} y={C + 2}>{center}</text>
      <text className="trDonutSub" x={C} y={C + 16}>{sub}</text>
    </svg>
  );
}

function smooth(p: Array<[number, number]>): string {
  if (p.length < 2) return "";
  let d = `M${p[0][0]} ${p[0][1]}`;
  for (let i = 0; i < p.length - 1; i++) {
    const a = p[i - 1] ?? p[i], b = p[i], c = p[i + 1], e = p[i + 2] ?? c;
    d += ` C${b[0] + (c[0] - a[0]) / 6} ${b[1] + (c[1] - a[1]) / 6} ${c[0] - (e[0] - b[0]) / 6} ${c[1] - (e[1] - b[1]) / 6} ${c[0]} ${c[1]}`;
  }
  return d;
}

/** A 96 × 26 sparkline in the strip's own ink, the last point marked. */
export function Spark({ vals }: Readonly<{ vals: number[] }>) {
  const W = 96, H = 26;
  const max = Math.max(1, ...vals), min = Math.min(...vals);
  const span = Math.max(1e-9, max - min);
  const pts = vals.map((v, i) => [2 + (i / Math.max(1, vals.length - 1)) * (W - 4), 3 + (1 - (v - min) / span) * (H - 6)] as [number, number]);
  const last = pts[pts.length - 1];
  return (
    <svg className="trSpark" viewBox={`0 0 ${W} ${H}`} width={W} height={H} aria-hidden>
      <path className="trSparkLine" d={smooth(pts)} />
      {last && <circle className="trSparkDot" cx={last[0]} cy={last[1]} r={2.4} />}
    </svg>
  );
}
