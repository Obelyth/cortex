/** Types for the vendored canvas engine. Shapes transcribed from engine.js emit()/openDetail(). */
export interface LegendGroup {
  key: string;
  group: string;
  count: number;
  expanded: boolean;
}
export interface LegendRow {
  key: string;
  label: string;
  color: string;
  count: number;
  off: boolean;
  groups: LegendGroup[];
}
export interface LegendPayload {
  rows: LegendRow[];
  total: number;
}
/** One note-graph tie as the drawer receives it: the other end, the claim's kind, its
 *  direction, a captioned weight ("3 refs", "bm25 12.4") and the evidence string. */
export interface MapTie {
  id: string;
  label: string;
  kind: string;
  dir: "out" | "in" | "both";
  weight: string;
  why: string;
}
export interface MapSelection {
  id: string;
  label: string;
  layerLabel: string;
  layerColor: string;
  /** The layer's payload key ("memory", "applications", …) — the drawer keys note-only
   *  affordances (the ledger jump) off this, never off the display label. */
  layerKey: string;
  group?: string;
  description: string;
  /** Ordered key/value pairs: detail, status, temperature (notes with heat), machine (when
   *  not "both"), links. */
  kv: Array<[string, string]>;
  /** Note-graph ties with their evidence. Empty for machine nodes and unbuilt graphs. */
  edges: MapTie[];
  /** Neighbours the note graph does not explain (the machine wiring). */
  related: Array<{ id: string; label: string; layer: string }>;
}
export class CortexMap {
  constructor(
    canvas: HTMLCanvasElement,
    data: unknown,
    opts?: {
      theme?: "dark" | "light";
      onLegend?: (payload: LegendPayload) => void;
      onSelect?: (sel: MapSelection | null) => void;
    },
  );
  destroy(): void;
  resize(): void;
  setTheme(name: "dark" | "light"): void;
  set(patch: Record<string, unknown>): void;
  toggleLayer(key: string): void;
  toggleGroup(key: string): void;
  expandAll(): void;
  collapseAll(): void;
  select(id: string): void;
  clearSelection(): void;
}
