import type { ReactNode } from "react";

/**
 * The row every settings group shares: a title and a one-line sub at left, the control at right.
 * A plain module (no directive) so the server composition and the client rows render the same
 * markup — a settings screen that invents a second row is two rows to keep honest.
 */
export function Row({ label, sub, children }: Readonly<{ label: string; sub?: ReactNode; children?: ReactNode }>) {
  return (
    <div className="setRow">
      <span className="setRowBody">
        <span className="setLabel">{label}</span>
        {sub && <span className="setSub">{sub}</span>}
      </span>
      {children}
    </div>
  );
}

/** A text value at the right of a row: set (accent), not set (faint), a reading (muted), or ink. */
export function Val({ tone = "ink", children }: Readonly<{ tone?: "on" | "off" | "muted" | "ink"; children: ReactNode }>) {
  const cls = tone === "on" ? "setVal setValOn" : tone === "off" ? "setVal setValOff" : tone === "muted" ? "setVal setValMuted" : "setVal";
  return <span className={cls}>{children}</span>;
}
