/**
 * A band: one full-bleed passage of the page, on its own ground.
 *
 * The console was one continuous sheet, which is why it read as a stack of boxes rather than a
 * composed page. Alternating grounds — paper, grey, near-black — is what divides a long screen
 * into passages, and it is the single device the reference leans on hardest.
 *
 * Every band carries the same header anatomy so the rhythm is identical on every screen: a
 * filled number chip, a label chip, then the heading at display scale in sentence case. One
 * component means a screen cannot quietly invent its own variant.
 */
export type BandTone = "paper" | "grey" | "ink";

const TONE: Record<BandTone, string> = {
  paper: "bandPaper",
  grey: "bandGrey",
  ink: "bandInk",
};

export function Band({
  n,
  label,
  title,
  lede,
  tone = "paper",
  grid = false,
  children,
}: Readonly<{
  /** Section number, rendered in the orange chip. Zero-padded by the caller's order, not here. */
  n: string;
  label: string;
  title?: React.ReactNode;
  lede?: React.ReactNode;
  tone?: BandTone;
  /** Draws the construction grid behind the band. Reserve it for bands carrying art or figures
   *  — behind dense text it is noise, which is why it is opt-in rather than default. */
  grid?: boolean;
  children: React.ReactNode;
}>) {
  return (
    <section className={`band ${TONE[tone]}`}>
      {grid && <div className="gridField" aria-hidden />}
      <div className="bandInner" data-cx="rise">
        <div className="secHead">
          <span className="secTag" data-cx="print" style={{ "--cx-d": "120ms" } as React.CSSProperties}>
            <span className="secTagN">{n}</span>
            <span className="secTagLabel">{label}</span>
          </span>
          {title && <h2 className="secTitle">{title}</h2>}
          {lede && <p className="secLede">{lede}</p>}
        </div>
        {children}
      </div>
    </section>
  );
}
