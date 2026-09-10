// The brand's first deliberate icon decision (spec §12.1). 20px grid, 1.6px stroke, round
// terminals, one grain per glyph where the eye enters. Ink by default; the component decides
// colour, never the path.
export type GlyphName = "fold-open" | "fold-closed" | "point" | "done" | "run" | "pause" | "run-again" | "notices" | "needs-you" | "go" | "opens-elsewhere" | "find" | "close" | "snooze" | "correct" | "live" | "trend" | "note" | "register" | "key" | "verified";
export interface GlyphSpec { paths: string[]; grain: { cx: number; cy: number }; field?: "live" }

export const GLYPHS: Record<GlyphName, GlyphSpec> = {
  "fold-open":   { paths: ["M5.5 7.5c1.6 1.9 3.1 3.6 4.6 5.2 1.4-1.7 2.8-3.4 4.4-5"], grain: { cx: 5.3, cy: 7.3 } },
  "fold-closed": { paths: ["M7.5 5.5c1.9 1.6 3.6 3.1 5.2 4.6-1.7 1.4-3.4 2.8-5 4.4"], grain: { cx: 7.3, cy: 5.3 } },
  point:         { paths: [], grain: { cx: 10, cy: 10.4 } },
  done:          { paths: ["M4.5 10.6c1.5 1.4 2.7 2.8 3.8 4.3 2.1-3.4 4.4-6.4 7.2-9.2"], grain: { cx: 15.6, cy: 5.6 } },
  run:           { paths: ["M7 4.8c3 1.5 5.6 3.3 8 5.4-2.4 2-5 3.8-8 5.2z"], grain: { cx: 7, cy: 4.8 } },
  pause:         { paths: ["M7 5v10", "M13 5v10"], grain: { cx: 7, cy: 5 } },
  "run-again":   { paths: ["M5.4 10.4a4.8 4.8 0 1 0 1.4-3.4", "M6.4 3.8v3.4h3.4"], grain: { cx: 6.4, cy: 3.8 } },
  notices:       { paths: ["M10 3.6c-2.9 0-4.6 2.3-4.6 5.1 0 2.4-.7 3.9-1.8 5.1h12.8c-1.1-1.2-1.8-2.7-1.8-5.1 0-2.8-1.7-5.1-4.6-5.1z", "M8.4 16.2c.4 .9 .9 1.3 1.6 1.3s1.2-.4 1.6-1.3"], grain: { cx: 15.2, cy: 4.8 } },
  "needs-you":   { paths: ["M10 4.2v6.6"], grain: { cx: 10, cy: 14.6 } },
  go:            { paths: ["M4.6 10.2c2.3-.3 4.5-.3 6.8 0", "M8.6 7.4c1.2.9 2.2 1.8 3 2.8-.8 1-1.8 1.9-3 2.8"], grain: { cx: 4.6, cy: 10.2 } },
  "opens-elsewhere": { paths: ["M8 5.2h6.8v6.8", "M14.6 5.4c-3.2 3-6.2 6.1-9.2 9.2"], grain: { cx: 5.4, cy: 14.6 } },
  find:          { paths: ["M13.6 9a4.6 4.6 0 1 1-9.2 0 4.6 4.6 0 0 1 9.2 0z", "M12.4 12.6c1.2 1 2.3 2 3.4 3.1"], grain: { cx: 15.8, cy: 15.7 } },
  close:         { paths: ["M5.6 5.8c3 2.8 5.9 5.7 8.8 8.6", "M14.4 5.8c-3 2.8-5.9 5.7-8.8 8.6"], grain: { cx: 5.6, cy: 5.8 } },
  snooze:        { paths: ["M10 4.4a5.6 5.6 0 1 0 5.6 5.6", "M10 6.8v3.4l2.4 1.6"], grain: { cx: 15.6, cy: 10 } },
  correct:       { paths: ["M4.6 15.4c.3-1.4.7-2.6 1.4-3.6 2.4-3 4.8-5.6 7.4-8 .9.8 1.7 1.6 2.4 2.5-2.4 2.6-4.9 5.1-7.9 7.5-1 .7-2.2 1.2-3.3 1.6z"], grain: { cx: 4.6, cy: 15.4 } },
  live:          { paths: ["M5 10.6c1.7-3 3.3-3 5 0s3.3 3 5 0"], grain: { cx: 5, cy: 10.6 }, field: "live" },
  trend:         { paths: ["M4.6 14.6c1.2-1.4 2.3-2.6 3.4-3.6 1 .6 1.9 1.3 2.7 2.1 1.8-2.2 3.4-4.2 4.9-6.2"], grain: { cx: 4.6, cy: 14.6 } },
  note:          { paths: ["M6 4.8h6.2l2.8 2.8v7.6H6z", "M8.4 10.4h3.4M8.4 12.8h3.4"], grain: { cx: 12.2, cy: 4.8 } },
  register:      { paths: ["M4.6 6.4c3.6 0 7.2 0 10.8 0M4.6 10c2.4 0 4.8 0 7.2 0M4.6 13.6c3.6 0 7.2 0 10.8 0"], grain: { cx: 4.6, cy: 6.4 } },
  key:           { paths: ["M6.4 8.2v-1a3.6 3.6 0 0 1 7.2 0v1", "M5.2 8.2h9.6v7.2H5.2z"], grain: { cx: 10, cy: 11.8 } },
  verified:      { paths: ["M10 3.8c-3 1.3-4.6 1.6-5.8 1.6v5.2c0 2.8 2.4 4.6 5.8 5.8 3.4-1.2 5.8-3 5.8-5.8V5.4c-1.2 0-2.8-.3-5.8-1.6z"], grain: { cx: 10, cy: 10.2 } },
};
