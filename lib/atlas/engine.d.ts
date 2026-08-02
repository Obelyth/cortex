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
export interface MapSelection {
  id: string;
  label: string;
  layerLabel: string;
  layerColor: string;
  group?: string;
  description: string;
  /** Ordered key/value pairs: detail, status, machine (when not "both"), links. */
  kv: Array<[string, string]>;
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
