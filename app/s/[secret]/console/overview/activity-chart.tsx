"use client";
import { useState } from "react";

export interface RangeData {
  bars: number[];
  labels: string[];
  axis: string[];
  /** How much of this range the log actually covers — shown beside the total. */
  note: string | null;
}

export type Ranges = Record<"day" | "week" | "month", RangeData>;

/**
 * The design's activity panel, working: 24H / WEEK / MONTH rebucket the same log, a clicked
 * bar pins its count into the header note, unselected bars dim. All three ranges arrive
 * precomputed from the server, every range stays clickable, and what a range cannot attest
 * rides in its coverage note. A window with zero calls renders a designed quiet state — the
 * old all-zero bars were invisible against the card, leaving the biggest panel on the screen
 * a black rectangle whose caption asked the operator to click bars that were not there.
 */
export function ActivityChart({ ranges }: Readonly<{ ranges: Ranges }>) {
  const [range, setRange] = useState<keyof Ranges>("day");
  const [sel, setSel] = useState<number | null>(null);

  const r = ranges[range];
  const total = r.bars.reduce((a, n) => a + n, 0);
  const peak = Math.max(1, ...r.bars);
  const note =
    sel === null
      ? total === 0
        ? `no tool calls in this window${r.note ? ` · ${r.note}` : ""} · this environment`
        : `${total} tool calls · this environment · click a bar${r.note ? ` · ${r.note}` : ""}`
      : `${r.bars[sel]} call${r.bars[sel] === 1 ? "" : "s"} · ${r.labels[sel]}`;

  const pick = (k: keyof Ranges) => {
    setRange(k);
    setSel(null);
  };

  return (
    <>
      <div className="actHead">
        <span className="actLabel">Activity</span>
        <span className="actNote">{note}</span>
        <a className="softLink" href="trends">all trends</a>
        <span className="segWrap">
          {(["day", "week", "month"] as const).map((k) => (
            <button
              key={k}
              type="button"
              className={`segBtn${range === k ? " on" : ""}`}
              onClick={() => pick(k)}
            >
              {k === "day" ? "24 h" : k}
            </button>
          ))}
        </span>
      </div>
      {total === 0 ? (
        <div className="capQuiet">
          The brain was quiet here — no MCP calls landed in this window on this environment.
          Notes served (top of the page) count every surface{range === "month" ? "." : " — and a wider window may still hold bars."}
        </div>
      ) : (
      <div className="capChart">
        {r.bars.map((n, i) => (
          <button
            key={`${range}-${i}`}
            type="button"
            className="capCol capBtn"
            style={{ opacity: sel === null || sel === i ? 1 : 0.35 }}
            title={`${n} call${n === 1 ? "" : "s"} · ${r.labels[i]}`}
            aria-label={`${n} call${n === 1 ? "" : "s"}, ${r.labels[i]}`}
            onClick={() => setSel(sel === i ? null : i)}
          >
            {n > 0 && <i className="capCap" />}
            <i className="capBody" style={{ height: `${Math.max(2, (n / peak) * 100)}%`, opacity: n ? 1 : 0.25 }} />
          </button>
        ))}
      </div>
      )}
      {total > 0 && (
        <div className="mcAxis">
          {r.axis.map((a) => <span key={a}>{a}</span>)}
        </div>
      )}
    </>
  );
}
