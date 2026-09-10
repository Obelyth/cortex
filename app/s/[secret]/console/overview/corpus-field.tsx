"use client";
import { useMemo, useRef, useState, type KeyboardEvent, type MouseEvent } from "react";
import { MAX_BAND, type DotField } from "@/lib/overview";
import { useLens } from "../lens";
import { noteLens } from "./lens-bodies";

/**
 * The corpus as a working surface, not a picture of one (W08): one mark per block of every note,
 * solid where the passage was retracted, capped at MARK_CAP with the cap stated in the caption.
 * Hover reads the block out; click opens the note in the lens (L1); the arrow keys walk the
 * field and Enter opens.
 *
 * Events are delegated to the container. Fourteen hundred marks with their own listeners is
 * fourteen hundred listeners; one listener and a data attribute is the same interaction at a
 * fraction of the cost, and it keeps the marks as bare <i> elements so the field renders the
 * same with JavaScript off. The stagger on entry is a class band (ovD0…ovD12), never an inline
 * delay per mark.
 *
 * The field is a wrapping flex row, so how many marks make a row is a function of the rendered
 * width — around 130 on a desktop panel and under 40 on a phone. ArrowUp/Down therefore measure
 * the stride from the laid-out marks rather than assuming one, or the vertical keys would land
 * somewhere in the middle of a distant row at every width but one.
 */
const IDLE = "hover or tab in and use the arrow keys · click or press Enter to open a note";

export function CorpusField({ field, sha }: Readonly<{ field: DotField; sha: string }>) {
  const lens = useLens();
  const [hot, setHot] = useState<number | null>(null);
  // Which mark the KEYBOARD is on, kept apart from `hot`. The pointer highlight is already a CSS
  // rule (.ovMark:hover in overview.css shares its declarations with .ovMarkHot), so baking
  // `hot === i` into every mark's className made a pointer crossing re-create all 1,400 marks
  // for a highlight the browser had already painted — ~2 ms per crossing, and a sweep crosses
  // dozens a second. Only the keyboard needs the class, and only the keyboard invalidates the
  // memo below; the pointer path now costs one repaint and a readout.
  const [keyHot, setKeyHot] = useState<number | null>(null);
  const fieldEl = useRef<HTMLDivElement>(null);

  /** Marks per rendered row: the index of the first mark that wraps onto a second line. Measured
   *  on the keypress, so a resize between renders cannot leave a stale stride behind. */
  const rowStride = (): number => {
    const marks = fieldEl.current?.children;
    if (!marks || marks.length < 2) return 1;
    const top = (marks[0] as HTMLElement).offsetTop;
    for (let i = 1; i < marks.length; i++) {
      if ((marks[i] as HTMLElement).offsetTop !== top) return i;
    }
    return marks.length;   // one row holds the whole field
  };

  // Flat index → (note, block, mark). One walk, and the marks are rendered from it, so the
  // index the hover reads and the mark the cursor is over cannot come apart: they are the same
  // array. Memoised on the field, which is the only thing it depends on.
  const at = useMemo(
    () => field.notes.flatMap((n, ni) => Array.from(n.strip, (c, b) => ({ n: ni, b, c }))),
    [field]
  );

  const from = (e: MouseEvent): number | null => {
    const el = (e.target as HTMLElement).closest("i[data-k]");
    if (!el) return null;
    const k = Number(el.getAttribute("data-k"));
    return Number.isFinite(k) ? k : null;
  };
  const open = (k: number) => lens.open(noteLens(field.notes[at[k].n], sha));
  const onKey = (e: KeyboardEvent) => {
    if (!at.length) return;
    const cur = hot ?? 0;
    const vertical = e.key === "ArrowDown" || e.key === "ArrowUp";
    const row = vertical ? rowStride() : 0;
    const step: Record<string, number> = { ArrowRight: 1, ArrowLeft: -1, ArrowDown: row, ArrowUp: -row };
    if (e.key in step) {
      e.preventDefault();
      const next = Math.max(0, Math.min(at.length - 1, cur + step[e.key]));
      setHot(next);
      setKeyHot(next);
    }
    else if ((e.key === "Enter" || e.key === " ") && hot !== null) { e.preventDefault(); open(hot); }
  };

  const marks = useMemo(
    () => at.map((m, i) => {
      const band = Math.min(MAX_BAND, Math.floor((i * 0.6) / 70));
      return <i key={`${m.n}-${m.b}`} data-k={i} className={`ovMark${m.c === "x" ? " ovMarkX" : ""}${keyHot === i ? " ovMarkHot" : ""} ovD${band}`} />;
    }),
    [at, keyHot]
  );

  const h = hot === null ? null : at[hot];
  const note = h ? field.notes[h.n] : null;
  const retracted = h ? h.c === "x" : false;
  return (
    <>
      <div
        className="ovField"
        ref={fieldEl}
        role="group"
        tabIndex={0}
        aria-label={`the corpus: ${field.shown.toLocaleString()} of ${field.total.toLocaleString()} blocks as marks, one per block, solid where retracted`}
        onMouseMove={(e) => { setHot(from(e)); setKeyHot(null); }}
        onMouseLeave={() => setHot(null)}
        onBlur={() => { setHot(null); setKeyHot(null); }}
        onKeyDown={onKey}
        onClick={(e) => { const i = from(e); if (i !== null) open(i); }}
      >
        {marks}
      </div>
      {/* Always present so the field never reflows under the cursor. */}
      <div className="ovFieldRead" aria-live="polite">
        {note && h
          ? `${note.path} · block ${h.b + 1} of ${note.blocks}${retracted ? " · retracted — kept on the page" : ""} · ~${note.tokens.toLocaleString()} estimated body tokens`
          : IDLE}
      </div>
    </>
  );
}
