/**
 * The boot gauge (W09): how much of the brain every session loads before you type, as v2's
 * ringGauge draws it — a sunk disc, a dotted track, one accent arc. Server-safe SVG; the arc's
 * geometry is an attribute, its colour a class. Null is "the boot path did not answer", which is
 * a different fact from 0% and is not drawn as a reassuringly empty ring.
 */
const SIZE = 132, C = SIZE / 2, RADIUS = C - 14;

export function BootRing({ pct }: Readonly<{ pct: number | null }>) {
  const shown = pct === null ? 0 : Math.max(0, Math.min(100, pct));
  return (
    <svg className="ovRing" viewBox={`0 0 ${SIZE} ${SIZE}`} width={SIZE} height={SIZE} role="img" aria-label={pct === null ? "boot cost unreadable this render" : `every session loads ${shown}% of the brain`}>
      <circle className="ovRingDisc" cx={C} cy={C} r={RADIUS - 9} />
      <circle className="ovRingTrack" cx={C} cy={C} r={RADIUS} />
      {pct !== null && <circle className="ovRingArc" cx={C} cy={C} r={RADIUS} pathLength={100} strokeDasharray={`${shown} ${100 - shown}`} transform={`rotate(-90 ${C} ${C})`} />}
      <text className="ovRingPct" x={C} y={C + 4}>{pct === null ? "—" : `${shown}%`}</text>
      <text className="ovRingLabel" x={C} y={C + 20}>{pct === null ? "UNREADABLE" : "PER SESSION"}</text>
    </svg>
  );
}
