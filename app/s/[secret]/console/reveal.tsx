"use client";
import { useState, type ReactNode } from "react";

/**
 * The console's one disclosure primitive.
 *
 * The screens accreted a sentence of explanation beside every number until the explanations
 * became the clutter — a first-time operator met a wall of qualifiers before a single figure.
 * The correction: numbers and symbols speak first, sentences appear on request. Anything that
 * used to be an always-on caption becomes a caret; the words are all still there, one click
 * down, where curiosity finds them instead of fatigue.
 *
 * A real <button> with aria-expanded, not a hover tooltip: touch screens have no hover, and
 * the collapsed state must be reachable, not just discoverable.
 */
export function Reveal({
  label,
  children,
  compact = false,
}: {
  label: string;
  children: ReactNode;
  compact?: boolean;
}) {
  const [open, setOpen] = useState(false);
  return (
    <span className={compact ? "revWrap revCompact" : "revWrap"}>
      <button
        type="button"
        className={`revBtn${open ? " revOpen" : ""}`}
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        <span className="revCaret" aria-hidden />
        {label}
      </button>
      {open && <span className="revBody">{children}</span>}
    </span>
  );
}
