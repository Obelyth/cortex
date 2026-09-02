"use client";
import type { HeatTile, HeatView } from "@/lib/heat";
import type { PinState } from "./pin-control";

/**
 * The heat map — temperature-banded rows with segmented pixel meters.
 *
 * THE SURVIVOR. Three treatments of one data layer shipped switchable behind a temporary
 * ?heat= param; the operator picked this one by eye (2026-08-11) and the other two are
 * deleted, not parked — dead code behind a dead param is how a screen grows a second opinion.
 *
 * The palette is the console's own, not a thermometer's: this world has exactly two accents —
 * orange marks heat/attention, cyan marks live — so the HOT band label is orange and the SEAT
 * (literally what is live in every session) is the cyan field. Intensity is a pixel meter: one
 * row of the corpus hero's own 6px block-marks (the operator's amendment — the translucent bars
 * "looked terrible"; the meter now speaks the block-field's language). Lit cells are the field's
 * solid off-white marks, unlit cells its faint base marks; the proportion lit is the access
 * component of the score. Anything nonzero lights at least one cell, so a barely-read note
 * still reads as read.
 */

/** Cells per meter: 17 six-px cells at the field's 3px gap fill the 150px column exactly. */
const METER_CELLS = 17;

function litCells(accessScore: number | null): number {
  const v = accessScore ?? 0;
  if (v <= 0) return 0;
  return Math.min(METER_CELLS, Math.max(1, Math.round(v * METER_CELLS)));
}

/** Coarse recency for tooltips and rows; exact instants ride in the title attribute. */
function ago(iso: string | null): string {
  if (!iso) return "never read";
  const s = Math.max(0, (Date.now() - Date.parse(iso)) / 1000);
  if (s < 3600) return `read ${Math.max(1, Math.round(s / 60))} min ago`;
  if (s < 86400) return `read ${Math.round(s / 3600)} h ago`;
  return `read ${Math.round(s / 86400)} d ago`;
}

const SEAT_WORD: Record<string, string> = {
  profile: "profile — served in full",
  recent: "recent day — served verbatim",
  router: "router row — path and description",
};

/** The whole story of one row, for the title attribute — units and windows stated. */
function tip(t: HeatTile, pin: PinState | null): string {
  return [
    `${t.path} · ~${t.tokens.toLocaleString()} tok`,
    t.temperature ? `${t.temperature}${t.score != null ? ` (score ${t.score}, blend of access/write/prior)` : ""}` : "unscored",
    `${t.reads} read${t.reads === 1 ? "" : "s"} all-time · ${ago(t.lastRead)}`,
    t.seat ? `in the seat: ${SEAT_WORD[t.seat]}` : "not loaded at boot — one call away",
    pin ? `pinned ${pin.temperature}${pin.reason ? ` — ${pin.reason}` : ""}` : "",
  ]
    .filter(Boolean)
    .join(" · ");
}

const BAND_ORDER = ["hot", "warm", "cold", "unscored"] as const;

function byBandGroups(tiles: HeatTile[]): Array<{ band: (typeof BAND_ORDER)[number]; tiles: HeatTile[] }> {
  return BAND_ORDER.map((band) => ({
    band,
    tiles: tiles.filter((t) => (t.temperature ?? "unscored") === band),
  })).filter((g) => g.tiles.length > 0);
}

export interface HeatPanelProps {
  heat: HeatView;
  pinOf: (path: string) => PinState | null;
  busyPath: string | null;
  onPin: (path: string, temperature: "hot" | "cold" | null) => void;
  onOpen: (path: string) => void;
}

export function HeatPanel(p: HeatPanelProps) {
  const scored = p.heat.scoring === "scored";
  return (
    <div className="htWrap">
      <div>
        {byBandGroups(p.heat.tiles).map((g) => (
          <div key={g.band} className="htGroup">
            <div className="htGroupHead">
              <span className={`htGroupLabel htBand-${g.band}`}>{g.band}</span>
              <span className="htGroupN">
                {g.tiles.length} notes · ~{g.tiles.reduce((a, t) => a + t.tokens, 0).toLocaleString()} tok
                {g.band === "cold" ? " · not rendered into the router" : ""}
              </span>
            </div>
            {g.tiles.map((t) => {
              const pin = p.pinOf(t.path);
              return (
                <div key={t.path} className={`htRow${t.seat ? " htSeat" : ""}`}>
                  <button type="button" className="htRowOpen" title={tip(t, pin)} onClick={() => p.onOpen(t.path)}>
                    <span className="htRowPath">{t.path}</span>
                  </button>
                  <span className="htMeter" aria-hidden>
                    {Array.from({ length: METER_CELLS }, (_, i) => (
                      <i key={i} className={i < litCells(t.accessScore) ? "on" : undefined} />
                    ))}
                  </span>
                  <span className="htRowN">{t.reads} read{t.reads === 1 ? "" : "s"}</span>
                  <span className="htRowN">{ago(t.lastRead)}</span>
                  <span className="htRowSeat">{t.seat ? "seat" : "·"}</span>
                  <button
                    type="button"
                    className={`htPinBtn${pin ? ` htPin-${pin.temperature}` : ""}`}
                    disabled={p.busyPath === t.path}
                    onClick={() => p.onPin(t.path, pin ? null : "hot")}
                    title={pin ? `unpin (currently pinned ${pin.temperature})` : "pin hot — keep this in the seat"}
                  >
                    {pin ? `pinned ${pin.temperature}` : "pin"}
                  </button>
                </div>
              );
            })}
          </div>
        ))}
      </div>
      <div className="htLegend">
        <span className="htLegendItem"><i className="htSwSeat" /> in the seat — loaded by every boot call</span>
        <span className="htLegendNote">
          {scored
            ? "lit cells = decayed reads, 30-day half-life, normalised to the busiest note · click any note to open its ledger entry below"
            : "meters are unlit — scoring is not answering, so intensity would be an invention · click any note to open its ledger entry below"}
        </span>
      </div>
    </div>
  );
}
