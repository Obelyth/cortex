"use client";
import { useRef, useState } from "react";

/**
 * The corpus as a working surface, not a picture of one.
 *
 * The first version of this band was art that stated a fact and did nothing — a decorative
 * halftone made of real data, which is still decoration. Every mark here is one block of one
 * note, so the field is already an index; it just was not addressable. Now it is: hover reads
 * the block out, click opens that note in the ledger with the path filtered in.
 *
 * Events are delegated to the container. 1,800 marks with their own listeners is 1,800
 * listeners; one listener and a data-index attribute is the same interaction at a fraction of
 * the cost, and it keeps the marks as bare <i> elements so the field still renders identically
 * with JavaScript off.
 */
export type Mark = {
  /** note path */ p: string;
  /** block number within the note, 1-based */ b: number;
  /** retracted */ x: boolean;
};

export function CorpusField({
  marks,
  total,
  shown,
}: Readonly<{ marks: Mark[]; total: number; shown: number }>) {
  const [hover, setHover] = useState<number | null>(null);
  const ref = useRef<HTMLDivElement>(null);

  const idxFrom = (e: React.MouseEvent) => {
    const el = (e.target as HTMLElement).closest("i[data-i]");
    if (!el) return null;
    const n = Number(el.getAttribute("data-i"));
    return Number.isFinite(n) ? n : null;
  };

  const m = hover === null ? null : marks[hover];

  return (
    <>
      <div
        ref={ref}
        className="dotField dotFieldLive"
        onMouseMove={(e) => setHover(idxFrom(e))}
        onMouseLeave={() => setHover(null)}
        onClick={(e) => {
          const i = idxFrom(e);
          if (i === null) return;
          // Relative, so the secret comes from the address bar and never from markup.
          window.location.href = `corpus?note=${encodeURIComponent(marks[i].p)}`;
        }}
      >
        {marks.map((mk, i) => (
          <i
            key={i}
            data-i={i}
            className={`${mk.x ? "on" : ""}${hover === i ? " hot" : ""}`}
            style={{ ["--d" as string]: `${Math.min(i, 600) * 1.1}ms` }}
          />
        ))}
      </div>

      {/* The readout is always present so the field never reflows under the cursor — the row
          holds its height and only its content changes. A layout that jumps while you are
          pointing at something is the fastest way to make a surface feel cheap. */}
      <div className="fieldRead" aria-live="polite">
        {m ? (
          <>
            <span className="fieldReadPath">{m.p}</span>
            <span className="fieldReadSep">·</span>
            <span>block {m.b}</span>
            <span className="fieldReadSep">·</span>
            <span className={m.x ? "fieldReadRet" : undefined}>
              {m.x ? "retracted — kept on the page" : "live"}
            </span>
            <span className="fieldReadGo">open in the ledger →</span>
          </>
        ) : (
          <span className="fieldReadIdle">
            {shown < total
              ? `${shown.toLocaleString()} of ${total.toLocaleString()} blocks — point at one`
              : `${total.toLocaleString()} blocks — point at one`}
          </span>
        )}
      </div>
    </>
  );
}
