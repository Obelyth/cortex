import { GLYPHS, type GlyphName } from "@/lib/glyphs";

/** One glyph, 20 or 16px. tone=ink by default; signal only for structure; paper on ink grounds. */
export function Glyph({ name, size = 20, tone = "ink", label }: Readonly<{ name: GlyphName; size?: 16 | 20; tone?: "ink" | "signal" | "paper"; label?: string }>) {
  const g = GLYPHS[name];
  // tone="paper" means paper-on-ink: the glyph sits on an ink ground. It must read the token
  // that IS paper on ink (--band-ink-on), not --paper, because .bandInk re-points --paper at the
  // ink itself so that sunk wells stay dark there — which painted every timeline glyph ink on
  // ink, invisible (critique 2026-09-05).
  const color = tone === "signal" ? "var(--signal)" : tone === "paper" ? "var(--band-ink-on)" : "var(--ink)";
  return (
    <svg className="glyph" width={size} height={size} viewBox="0 0 20 20" role={label ? "img" : undefined} aria-label={label} aria-hidden={label ? undefined : true} style={{ color, display: "block", flex: "none" }}>
      {g.field === "live" && <rect x="2" y="2" width="16" height="16" fill="var(--field-live)" />}
      {g.paths.map((d, i) => <path key={i} d={d} fill="none" stroke={g.field ? "var(--field-on)" : "currentColor"} strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />)}
      <circle cx={g.grain.cx} cy={g.grain.cy} r={name === "point" ? 2.6 : 1.1} fill={g.field ? "var(--field-on)" : "currentColor"} />
    </svg>
  );
}
