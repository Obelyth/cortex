"use client";
/**
 * The Live Board — the full-bleed live map with its floating menu, layers legend and detail
 * drawer. A faithful port of the board design; the component owns chrome and state, the
 * vendored engine owns every pixel of the canvas. Rendered two ways: standalone at
 * /s/<secret>/map (wordmark on) and embedded under the console shell (wordmark off, the
 * masthead already says who we are).
 *
 * Completions over the design mock, all additive: "/" focuses search (opening the menu if
 * shut), Escape closes drawer-then-menu, machine buttons derive from the payload's real tags
 * and hide when the data cannot answer them, and prefers-reduced-motion parks the spin at 0 —
 * the slider stays honest because it is bound to the same state.
 */
import React, { useEffect, useMemo, useRef, useState } from "react";
import { CortexMap, type LegendRow, type MapSelection } from "@/lib/atlas/engine";
import styles from "./board.module.css";

/* The board joined the paper world in the depth pass (2026-09-01): same chrome contract,
   re-derived on paper — ink text, hairline rules, signal orange for actions, ink shadows. */
const PALETTE: Record<string, string> = {
  "--cx-bg": "#f0efed", "--cx-panel": "#f7f6f4", "--cx-line": "rgba(17,19,21,.16)",
  "--cx-fg": "#111315", "--cx-fg2": "#3a3f44", "--cx-faint": "#5f666d",
  "--cx-accent": "#d8500f", "--cx-gold": "#111315", "--cx-detail": "#f7f6f4",
  "--cx-btn": "rgba(17,19,21,.04)", "--cx-btnh": "rgba(17,19,21,.08)",
  "--cx-track": "rgba(17,19,21,.16)", "--cx-shadow": "rgba(17,19,21,.22)",
};

/* Drawn icons — one 16px stroke grid, currentColor, in place of the unicode glyphs the
   craft floor refuses. */
const Ic = {
  menu: (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden>
      <path d="M2 4h12M2 8h12M2 12h12" />
    </svg>
  ),
  down: (
    <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden>
      <path d="M3 6l5 5 5-5" />
    </svg>
  ),
  right: (
    <svg width="11" height="11" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden>
      <path d="M6 3l5 5-5 5" />
    </svg>
  ),
  x: (
    <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden>
      <path d="M3.5 3.5l9 9M12.5 3.5l-9 9" />
    </svg>
  ),
  check: (
    <svg width="10" height="10" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2.2" aria-hidden>
      <path d="M2.5 8.5l3.5 3.5 7-8" />
    </svg>
  ),
};

export function LiveBoard({
  data,
  srcline,
  standalone = false,
}: {
  data: unknown;
  srcline: string;
  standalone?: boolean;
}) {
  const rootRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const engineRef = useRef<CortexMap | null>(null);

  const [menu, setMenu] = useState(false);
  const [legend, setLegend] = useState(true);
  // Force + live springs by default — the ring carousel read as a diagram; a cluster map
  // should settle like one, with rings kept as a layout the menu can still choose.
  const [layout, setLayout] = useState("force");
  const [spin, setSpin] = useState(0.3);
  const [spring, setSpring] = useState(0.35);
  const [sizeK, setSizeK] = useState(1);
  const [checks, setChecks] = useState({ labels: true, edges: true, hex: true });
  const [machine, setMachine] = useState("all");
  const [query, setQuery] = useState("");
  const [rows, setRows] = useState<LegendRow[]>([]);
  const [total, setTotal] = useState(0);
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const [sel, setSel] = useState<MapSelection | null>(null);

  const machines = useMemo(() => {
    const nodes = (data as { nodes?: Array<{ machine?: string }> })?.nodes ?? [];
    const tags = new Set(nodes.map((n) => n.machine ?? "all"));
    tags.delete("all");
    tags.delete("both");
    if (!tags.size) return null;
    const rest = [...tags].sort((a, b) => a.localeCompare(b));
    return ["all", ...rest].map((k) => ({ k, label: k[0].toUpperCase() + k.slice(1) }));
  }, [data]);

  useEffect(() => {
    if (!canvasRef.current) return;
    const eng = new CortexMap(canvasRef.current, data, {
      theme: "light",
      onLegend: (p) => { setRows(p.rows); setTotal(p.total); },
      onSelect: setSel,
    });
    engineRef.current = eng;
    // The engine emits its first legend from set(), never the constructor — and the same call
    // establishes the initial spin, zeroed for anyone who asked for no motion.
    const still = matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (still) setSpin(0);
    eng.set({ spin: still ? 0 : 0.3, layout: "force", spring: 0.35 });

    const ro = new ResizeObserver(() => eng.resize());
    if (rootRef.current) ro.observe(rootRef.current);

    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      const typing = t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA");
      if (e.key === "/" && !typing) {
        e.preventDefault();
        setMenu(true);
        requestAnimationFrame(() => searchRef.current?.focus());
      } else if (e.key === "Escape") {
        if (typing) (t as HTMLInputElement).blur();
        else {
          setSel((s) => {
            if (s) { engineRef.current?.clearSelection(); return null; }
            setMenu(false);
            return s;
          });
        }
      }
    };
    window.addEventListener("keydown", onKey);

    return () => {
      window.removeEventListener("keydown", onKey);
      ro.disconnect();
      eng.destroy();
      engineRef.current = null;
    };
    // The payload is server-built once per request; the engine owns it after mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const eng = () => engineRef.current;
  const patch = (p: Record<string, unknown>) => eng()?.set(p);

  return (
    <div className={styles.root} ref={rootRef} style={PALETTE as React.CSSProperties}>
      <canvas ref={canvasRef} className={styles.canvas} />

      {standalone && (
        <div className={styles.wordmark}>
          <div className={styles.wordTitle}><b>Second</b> Brain</div>
          <div className={styles.wordBy}>Cortex by Obelyth</div>
          <div className={styles.wordLive}>
            <span className={styles.liveChip}>Memory live</span> <em>{srcline}</em>
          </div>
        </div>
      )}
      {/* Embedded under the console the wordmark stays off, but the freshness line is data,
          not branding — the aperture still says which rings are live and whether the graph
          made it onto the board. */}
      {!standalone && <div className={styles.srcline}>{srcline}</div>}

      <button type="button"
        className={menu ? `${styles.menuBtn} ${styles.menuBtnOn}` : styles.menuBtn}
        aria-expanded={menu}
        onClick={() => setMenu(!menu)}>
        {Ic.menu} Menu
      </button>

      <div className={menu ? `${styles.panel} ${styles.panelOpen}` : styles.panel}>
        <input ref={searchRef} className={styles.search} value={query}
          placeholder="Search…  ( / )"
          onChange={(e) => { setQuery(e.target.value); patch({ query: e.target.value }); }} />

        <div className={styles.panelLabel}>Layout</div>
        <div className={styles.btnRow}>
          {["rings", "hex", "force"].map((k) => (
            <button type="button" key={k} aria-pressed={layout === k}
              className={layout === k ? `${styles.rowBtn} ${styles.rowBtnOn}` : styles.rowBtn}
              onClick={() => { setLayout(k); patch({ layout: k }); }}>
              {k[0].toUpperCase() + k.slice(1)}
            </button>
          ))}
        </div>

        <div className={styles.panelLabel}>Ring spin <span>{spin.toFixed(2)}</span></div>
        <input className={styles.slider} type="range" min="0" max="1" step="0.01" value={spin}
          onChange={(e) => { const v = parseFloat(e.target.value); setSpin(v); patch({ spin: v }); }} />

        <div className={styles.panelLabel}>Link springs <span>{spring.toFixed(2)}</span></div>
        <input className={styles.slider} type="range" min="0" max="1" step="0.01" value={spring}
          onChange={(e) => { const v = parseFloat(e.target.value); setSpring(v); patch({ spring: v }); }} />

        <div className={styles.panelLabel}>Node size <span>{sizeK.toFixed(2)}</span></div>
        <input className={styles.slider} type="range" min="0.4" max="2" step="0.05" value={sizeK}
          onChange={(e) => { const v = parseFloat(e.target.value); setSizeK(v); patch({ sizeK: v }); }} />

        <div className={styles.panelLabel}>Show</div>
        {(["labels", "edges", "hex"] as const).map((k) => {
          const label = k === "labels" ? "Names" : k === "edges" ? "Links" : "Hex grid";
          const on = checks[k];
          return (
            <button type="button" key={k} aria-pressed={on}
              className={on ? `${styles.checkRow} ${styles.checkRowOn}` : styles.checkRow}
              onClick={() => {
                const next = { ...checks, [k]: !on };
                setChecks(next);
                patch({ [k]: next[k] });
              }}>
              <i className={on ? `${styles.checkBox} ${styles.checkBoxOn}` : styles.checkBox}>
                {on ? Ic.check : null}
              </i>
              <span>{label}</span>
            </button>
          );
        })}

        <div className={styles.panelLabel}>Groups</div>
        <div className={styles.btnRow}>
          <button type="button" className={styles.rowBtn} onClick={() => eng()?.expandAll()}>
            Expand all
          </button>
          <button type="button" className={styles.rowBtn} onClick={() => eng()?.collapseAll()}>
            Collapse all
          </button>
        </div>

        {machines && (
          <>
            <div className={styles.panelLabel}>Machine</div>
            <div className={styles.btnRow}>
              {machines.map((m) => (
                <button type="button" key={m.k} aria-pressed={machine === m.k}
                  className={machine === m.k ? `${styles.rowBtn} ${styles.rowBtnOn}` : styles.rowBtn}
                  onClick={() => { setMachine(m.k); patch({ machine: m.k }); }}>
                  {m.label}
                </button>
              ))}
            </div>
          </>
        )}
      </div>

      <div className={legend ? styles.legend : `${styles.legend} ${styles.legendShut}`}>
        <button type="button" className={styles.legendHead} aria-expanded={legend}
          onClick={() => setLegend(!legend)}>
          <span className={styles.legendTitle}>Layers</span>
          <span className={styles.legendN}>{total}</span>
          <span className={legend ? styles.chev : `${styles.chev} ${styles.chevShut}`}>{Ic.down}</span>
        </button>
        <div className={legend ? styles.legendBody : `${styles.legendBody} ${styles.legendBodyShut}`}>
          {rows.map((r) => (
            <div key={r.key}>
              <div className={r.off ? `${styles.layerRow} ${styles.layerOff}` : styles.layerRow}>
                <button type="button" className={styles.layerChip} style={{ background: r.color }}
                  aria-label={`Toggle ${r.label}`} onClick={() => eng()?.toggleLayer(r.key)} />
                <button type="button" className={styles.layerName} onClick={() => eng()?.toggleLayer(r.key)}>
                  {r.label}
                </button>
                <span className={styles.layerCount}>{r.count}</span>
                <button type="button" aria-expanded={!!open[r.key]}
                  className={open[r.key] ? `${styles.layerCaret} ${styles.caretOpen}` : styles.layerCaret}
                  onClick={() => setOpen((o) => ({ ...o, [r.key]: !o[r.key] }))}>
                  {Ic.right}
                </button>
              </div>
              {open[r.key] && r.groups.map((g) => (
                <button type="button" key={g.key}
                  className={g.expanded ? `${styles.groupRow} ${styles.groupOn}` : styles.groupRow}
                  onClick={() => eng()?.toggleGroup(g.key)}>
                  <span className={styles.groupDot} />
                  <span className={styles.groupName}>{g.group}</span>
                  <span className={styles.groupCount}>{g.count}</span>
                </button>
              ))}
            </div>
          ))}
        </div>
      </div>

      <aside className={sel ? `${styles.drawer} ${styles.drawerOpen}` : styles.drawer} aria-hidden={!sel}>
        <button type="button" className={styles.drawerClose} aria-label="Close"
          onClick={() => { eng()?.clearSelection(); setSel(null); }}>
          {Ic.x}
        </button>
        <div className={styles.drawerHead}>
          <div className={styles.drawerLayer} style={{ color: sel?.layerColor ?? "var(--cx-faint)" }}>
            {sel ? `${sel.layerLabel}${sel.group ? ` · ${sel.group}` : ""}` : ""}
          </div>
          <div className={styles.drawerTitle}>{sel?.label ?? ""}</div>
          <div className={styles.drawerId}>{sel?.id ?? ""}</div>
        </div>
        <div className={styles.drawerBody}>
          <p className={styles.drawerDesc}>{sel?.description ?? ""}</p>
          <dl className={styles.kvGrid}>
            {(sel?.kv ?? []).map(([k, v]) => (
              <React.Fragment key={k}>
                <dt>{k}</dt>
                <dd>{v}</dd>
              </React.Fragment>
            ))}
          </dl>
          {/* A note on the board is a note in the ledger — the drawer is a glance, the ledger
              is the interrogation, and ?note= lands there already filtered to this note. */}
          {sel?.layerKey === "memory" && (
            <a className={styles.ledgerGo}
              href={`${standalone ? "console/" : ""}corpus?note=${encodeURIComponent(sel.id)}`}>
              open in the notes ledger →
            </a>
          )}
          {sel && (sel.edges?.length ?? 0) > 0 && (
            <div>
              <div className={styles.connHead}>Graph ties</div>
              {sel.edges.map((e, i) => (
                <div key={`${e.kind}|${e.id}|${i}`} className={styles.tie}>
                  <button type="button" className={styles.tieRow} onClick={() => eng()?.select(e.id)}>
                    <span className={styles.tieKind}>{e.kind}</span>
                    <span className={styles.tieDir} aria-hidden>
                      {e.dir === "out" ? "→" : e.dir === "in" ? "←" : "↔"}
                    </span>
                    <span className={styles.tieOther}>{e.label}</span>
                    {e.weight && <span className={styles.tieW}>{e.weight}</span>}
                  </button>
                  {e.why && <div className={styles.tieWhy}>{e.why}</div>}
                </div>
              ))}
            </div>
          )}
          {sel && sel.related.length > 0 && (
            <div>
              <div className={styles.connHead}>Connected</div>
              {sel.related.map((r) => (
                <button type="button" key={r.id} className={styles.connRow}
                  onClick={() => eng()?.select(r.id)}>
                  {r.label}
                </button>
              ))}
            </div>
          )}
        </div>
      </aside>
    </div>
  );
}
