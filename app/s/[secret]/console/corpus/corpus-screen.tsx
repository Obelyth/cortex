"use client";
import { useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Band } from "../band";
import styles from "../console.module.css";
import { LedgerClient, type LedgerConnections, type LedgerRetracted, type LedgerRow } from "./ledger-client";
import { HeatPanel } from "./heat-panel";
import { HandoffPanel } from "./handoff-panel";
import { PinControl, type PinState } from "./pin-control";
import type { HeatView } from "@/lib/heat";

/**
 * The corpus screen, as one client composition.
 *
 * It became a client component the day the heat view arrived: a tile clicked in band 01 opens
 * the ledger expansion in band 04, and the pin placed in either place must read the same in
 * both — shared state needs one owner, and this is it. The page (page.tsx) stays the server
 * half: gate, load, serialize. Nothing here fetches except the two gated POSTs (pin, staging),
 * both relative so the secret never enters markup.
 */

export interface ShapeRow {
  dir: string;
  notes: number;
  tokens: number;
}

export function CorpusScreen({
  heat,
  projects,
  sha,
  byDir,
  rows,
  retractedByPath,
  connections,
  initialFilter,
}: Readonly<{
  heat: HeatView;
  projects: string[];
  sha: string;
  byDir: ShapeRow[];
  rows: LedgerRow[];
  retractedByPath: Record<string, LedgerRetracted[]>;
  connections: LedgerConnections | null;
  initialFilter?: string;
}>) {
  const router = useRouter();
  const [jump, setJump] = useState<{ path: string; seq: number } | null>(null);
  const [busyPath, setBusyPath] = useState<string | null>(null);
  const [pinErr, setPinErr] = useState<string | null>(null);
  const [pinOverride, setPinOverride] = useState<Record<string, PinState | null>>({});
  const ledgerRef = useRef<HTMLDivElement>(null);

  const initialPins = useMemo(() => {
    const m: Record<string, PinState> = {};
    for (const t of heat.tiles) {
      if (t.pinned) m[t.path] = { temperature: t.pinned, reason: t.pinReason };
    }
    return m;
  }, [heat.tiles]);

  const pinOf = (path: string): PinState | null =>
    path in pinOverride ? pinOverride[path] : (initialPins[path] ?? null);

  const openNote = (path: string) => {
    setJump((j) => ({ path, seq: (j?.seq ?? 0) + 1 }));
    ledgerRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
  };

  async function onPin(path: string, temperature: "hot" | "cold" | null) {
    setBusyPath(path);
    setPinErr(null);
    try {
      const res = await fetch("heat/pin", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ path, pin: temperature ? { temperature, reason: "" } : null }),
      });
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) throw new Error(data.error ?? `pin failed (HTTP ${res.status})`);
      setPinOverride((o) => ({ ...o, [path]: temperature ? { temperature, reason: "" } : null }));
      // The seat and the temperatures recompute server-side; refresh so the view tells the
      // truth about what the pin just changed rather than only marking the tile.
      router.refresh();
    } catch (e) {
      setPinErr(
        `${path}: ${e instanceof Error ? e.message : String(e)}`
      );
    } finally {
      setBusyPath(null);
    }
  }

  const s = heat.seat;
  const tok = (bytes: number) => Math.round(bytes / 4).toLocaleString();

  const bubbleWord =
    s.bubble === "live"
      ? `working state ~${tok(s.bubbleBytes)} tok`
      : s.bubble === "empty"
        ? "an empty bubble"
        : s.bubble === "failed"
          ? "bubble unavailable this render"
          : "no bubble on this deploy";
  const recentWord = s.expandedDays.length
    ? `${s.expandedDays.length} recent day${s.expandedDays.length === 1 ? "" : "s"} verbatim ~${tok(s.recentBytes)} tok`
    : s.digestedDays.length
      ? `${s.digestedDays.length} recent day${s.digestedDays.length === 1 ? "" : "s"} as digest lines`
      : "no recent days";

  const heatLede =
    heat.scoring === "off"
      ? "Half of this view cannot exist on this deploy: SUPABASE_URL is unset, so there is no mirror, " +
        "no access log, no note_scores and no note_pins — temperatures, intensity and pins are " +
        "impossible here, not empty. What remains is real: the corpus from git, and the seat — the " +
        "router renders every row unranked under its 20 KB budget, which is exactly what boot serves " +
        "without scoring."
      : heat.scoring === "unavailable"
        ? "note_scores did not answer on this render, so temperatures and intensity are unknown — " +
          "unknown, not cool. The store itself is untouched; reload to retry. The seat below is the " +
          "unranked router, which is exactly what boot serves while scoring is down."
        : heat.scoring === "empty"
          ? "The mirror holds no scored rows yet — the first sync fills it (any brain read heals the " +
            "mirror). Until then the tiles carry no temperature and the router renders unranked."
          : `What one brain_context boot call serves right now at ${heat.sha}: profile ~${tok(s.profileBytes)} tok · ` +
            `router ${s.routerRows} rows ~${tok(s.routerBytes)} tok (${s.droppedRows} refused by the 20 KB boot budget, ` +
            `${s.coldRows} cold not rendered) · ${bubbleWord} · ${recentWord}. Tokens ≈ chars/4 at this commit. ` +
            `Below: every live note, banded hot/warm/cold from note_scores.`;

  return (
    <div className="ovSheet">
      <Band
        n="01"
        label="Heat"
        tone="ink"
        title={
          <>
            Under the hood: <b>~{s.tokens.toLocaleString()} tokens in the seat.</b>
          </>
        }
        lede={heatLede}
      >
        {heat.coldStart && (
          <div className="htColdStart">
            Scores are live but no note has ever been read — every temperature below is carried by
            write-recency and the directory prior. That is the designed cold start, not usage.
          </div>
        )}
        <HeatPanel
          heat={heat}
          pinOf={pinOf}
          busyPath={busyPath}
          onPin={heat.pinsAvailable ? onPin : () => setPinErr("pins are unavailable on this deploy — note_pins cannot be reached, so nothing was changed")}
          onOpen={openNote}
        />
        {pinErr && <div className="htErr">pin not saved — {pinErr}. note_pins holds its previous state.</div>}
      </Band>

      <Band
        n="02"
        label="Handoff"
        tone="paper"
        title={
          <>
            What resumes <b>a project today.</b>
          </>
        }
        lede="Pick a project: the panel runs the exact brain_handoff walk at the live head and shows its decisions — the coverage line verbatim, every included piece with its citation, every excluded candidate with the reason it is out. Staging reads nothing into the access log."
      >
        <HandoffPanel projects={projects} />
      </Band>

      <Band
        n="03"
        label="Shape"
        tone="grey"
        title={
          <>
            {rows.length} notes across <b>{byDir.length} folders.</b>
          </>
        }
        lede={`${byDir.reduce((a, d) => a + d.tokens, 0).toLocaleString()} tokens in all. Archive, tools and generated indexes are excluded here — the same filter the reader uses, so this is the corpus as a session actually sees it.`}
      >
        {byDir.map((d) => {
          const maxDir = Math.max(1, ...byDir.map((x) => x.tokens));
          return (
            <div key={d.dir} className={styles.distRow}>
              <span className={styles.distLabel}>{d.dir}</span>
              <span className={styles.distBar}>
                <i style={{ width: `${(d.tokens / maxDir) * 100}%` }} />
              </span>
              <span className={styles.distN}>
                {d.tokens.toLocaleString()} tok · {d.notes} notes
              </span>
            </div>
          );
        })}
      </Band>

      <div ref={ledgerRef}>
        <Band
          n="04"
          label="Ledger"
          tone="paper"
          title={
            <>
              Every note, every block,
              <br />
              <b>live at {sha}.</b>
            </>
          }
          lede="Each tick is one block; solid ticks are retracted passages, kept on the page. Click a row to read the note's own account of itself — title, first sentence, outline, what it crossed out, and what it connects to."
        >
          <LedgerClient
            initialFilter={initialFilter}
            connections={connections}
            jump={jump}
            pinPanel={(path) => (
              <PinControl
                path={path}
                pin={pinOf(path)}
                available={heat.pinsAvailable}
                busy={busyPath === path}
                onPin={onPin}
              />
            )}
            rows={rows}
            retractedByPath={retractedByPath}
          />
        </Band>
      </div>
    </div>
  );
}
