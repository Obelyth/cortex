"use client";
/**
 * The live map inside the console shell — the vendored canvas engine over real buildAtlas()
 * data. The component owns only chrome: controls mutate the engine through set()/toggles, the
 * detail drawer renders whatever onSelect hands back. Layout maths stay in the engine.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { CortexMap, type LegendRow, type MapSelection } from "@/lib/atlas/engine";
import styles from "./map.module.css";

export function MapClient({ data, capturedAt }: { data: unknown; capturedAt: string | null }) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const engineRef = useRef<CortexMap | null>(null);
  const [legend, setLegend] = useState<LegendRow[]>([]);
  const [sel, setSel] = useState<MapSelection | null>(null);
  const [layout, setLayout] = useState("rings");
  const [machine, setMachine] = useState("all");
  const [spin, setSpin] = useState(30);
  const [toggles, setToggles] = useState({ labels: true, edges: true, hex: true });
  const [legendOpen, setLegendOpen] = useState(true);

  // The machine filter only exists if the payload can answer it — a snapshot that tags every
  // node "all" (or "both") would make the buttons a dead control, so they derive from the data.
  const machines = useMemo(() => {
    const nodes = (data as { nodes?: Array<{ machine?: string }> })?.nodes ?? [];
    const tags = new Set(nodes.map((n) => n.machine ?? "all"));
    tags.delete("all");
    tags.delete("both");
    return tags.size ? ["all", ...[...tags].sort((a, b) => a.localeCompare(b))] : null;
  }, [data]);

  useEffect(() => {
    if (!canvasRef.current) return;
    const eng = new CortexMap(canvasRef.current, data, {
      theme: "dark",
      onLegend: (p) => setLegend(p.rows),
      onSelect: setSel,
    });
    engineRef.current = eng;
    const ro = new ResizeObserver(() => eng.resize());
    if (wrapRef.current) ro.observe(wrapRef.current);
    // The engine only emits its legend from set()/toggles, never from the constructor —
    // the mount patch forces the first emission so the layers panel is populated at mount.
    if (matchMedia("(prefers-reduced-motion: reduce)").matches) {
      setSpin(0); // keep the slider honest about the engine state
      eng.set({ spin: 0 });
    } else {
      eng.set({});
    }
    return () => {
      ro.disconnect();
      eng.destroy();
      engineRef.current = null;
    };
    // The payload is fetched server-side once per request; the engine owns it after mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const eng = () => engineRef.current;

  return (
    <div className={styles.mapWrap} ref={wrapRef}>
      <canvas ref={canvasRef} className={styles.canvas} />

      <div className={styles.hud}>
        <div className={styles.hudRow}>
          {["rings", "hex", "force"].map((l) => (
            <button key={l} className={`${styles.hudBtn}${layout === l ? " " + styles.onBtn : ""}`}
              aria-pressed={layout === l}
              onClick={() => { setLayout(l); eng()?.set({ layout: l }); }}>
              {l}
            </button>
          ))}
        </div>
        <div className={styles.hudRow}>
          {(["labels", "edges", "hex"] as const).map((k) => (
            <button key={k} className={`${styles.hudBtn}${toggles[k] ? " " + styles.onBtn : ""}`}
              aria-pressed={toggles[k]}
              onClick={() => {
                const next = { ...toggles, [k]: !toggles[k] };
                setToggles(next);
                eng()?.set({ [k]: next[k] });
              }}>
              {k === "labels" ? "names" : k === "hex" ? "hex grid" : "links"}
            </button>
          ))}
        </div>
        {machines && (
          <div className={styles.hudRow}>
            {machines.map((m) => (
              <button key={m} className={`${styles.hudBtn}${machine === m ? " " + styles.onBtn : ""}`}
                aria-pressed={machine === m}
                onClick={() => { setMachine(m); eng()?.set({ machine: m }); }}>
                {m}
              </button>
            ))}
          </div>
        )}
        <div className={styles.hudRow}>
          <button className={styles.hudBtn} onClick={() => eng()?.expandAll()}>expand all</button>
          <button className={styles.hudBtn} onClick={() => eng()?.collapseAll()}>collapse</button>
        </div>
        <label className={styles.sliderRow}>
          <span>spin</span>
          <input type="range" min="0" max="100" value={spin}
            onChange={(e) => {
              const v = Number(e.target.value);
              setSpin(v);
              eng()?.set({ spin: v / 100 });
            }} />
        </label>
        <label className={styles.sliderRow}>
          <span>springs</span>
          <input type="range" min="0" max="100" defaultValue="0"
            onChange={(e) => eng()?.set({ spring: Number(e.target.value) / 100 })} />
        </label>
        <label className={styles.sliderRow}>
          <span>size</span>
          <input type="range" min="50" max="200" defaultValue="100"
            onChange={(e) => eng()?.set({ sizeK: Number(e.target.value) / 100 })} />
        </label>
        <input className={styles.search} placeholder="Search…"
          onChange={(e) => eng()?.set({ query: e.target.value.trim() })} />
        <div className={styles.capNote}>
          {capturedAt ? `machine rings ${capturedAt} · memory live` : "machine rings absent · memory live"}
        </div>
      </div>

      <div className={legendOpen ? styles.legend : `${styles.legend} ${styles.legendShut}`}>
        <button className={styles.legendHead} onClick={() => setLegendOpen(!legendOpen)}
          aria-expanded={legendOpen}>
          layers
        </button>
        {legendOpen && legend.map((row) => (
          <div key={row.key}>
            <button className={styles.legendRow}
              style={{ opacity: row.off ? 0.45 : 1 }}
              onClick={() => eng()?.toggleLayer(row.key)}>
              <i style={{ background: row.color }} />
              <span>{row.label}</span>
              <b>{row.count}</b>
            </button>
            {!row.off && row.groups.map((g) => (
              <button key={g.key} className={styles.legendGroup}
                aria-expanded={g.expanded}
                onClick={() => eng()?.toggleGroup(g.key)}>
                <em>{g.expanded ? "▾" : "▸"}</em>
                <span>{g.group}</span>
                <b>{g.count}</b>
              </button>
            ))}
          </div>
        ))}
      </div>

      {sel && (
        <aside className={styles.drawer}>
          <button className={styles.drawerClose} aria-label="Close"
            onClick={() => { setSel(null); eng()?.clearSelection(); }}>
            ×
          </button>
          <div className={styles.drawerLayer} style={{ color: sel.layerColor }}>
            {sel.layerLabel}{sel.group ? ` · ${sel.group}` : ""}
          </div>
          <h2 className={styles.drawerTitle}>{sel.label}</h2>
          <div className={styles.drawerId}>{sel.id}</div>
          {sel.description !== "—" && <p className={styles.drawerDesc}>{sel.description}</p>}
          <dl className={styles.drawerKv}>
            {sel.kv.map(([k, v]) => (
              <div key={k}><dt>{k}</dt><dd>{v}</dd></div>
            ))}
          </dl>
          {sel.related.length > 0 && (
            <div className={styles.drawerRel}>
              <div className={styles.drawerRelHead}>linked</div>
              {sel.related.map((r) => (
                <button key={r.id} className={styles.drawerRelRow} onClick={() => eng()?.select(r.id)}>
                  <span>{r.label}</span>
                  <b>{r.layer}</b>
                </button>
              ))}
            </div>
          )}
        </aside>
      )}
    </div>
  );
}
