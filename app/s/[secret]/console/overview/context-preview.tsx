import type { HandoffPreview } from "@/lib/handoff";
import styles from "./working-context.module.css";

const NOTE = /^(profile\.md|(?:projects|notes|log|history)\/[A-Za-z0-9._-]+\.md)$/i;
/** The bounded handoff decisions, not a second copy of the saved notes or a model call. */
export function ContextPreview({ view }: Readonly<{ view: HandoffPreview }>) {
  const included = view.pieces.filter(piece => piece.included);
  const excluded = view.pieces.filter(piece => !piece.included);
  const label = (value: string) => NOTE.test(value)
    ? <a href={`ask?note=${encodeURIComponent(value)}`}>{value}</a> : value;
  const pieces = (items: HandoffPreview["pieces"]) => items.map((piece, i) => <li key={`${piece.kind}:${piece.label}:${i}`} className={styles.piece}>
    <span>{label(piece.label)}</span><span>{(piece.bytes / 1000).toFixed(1)} KB · {piece.kind}</span>
    <p>{piece.excludedBy === "budget" ? "Outside the bundle budget. " : piece.excludedBy === "log-share" ? "Outside the log section’s share. " : ""}{piece.why}</p>
  </li>);
  return <div className={styles.preview}>
    <p className={styles.description}>{view.coverage}</p>
    <dl className={styles.facts}>
      <div><dt>Project</dt><dd>{view.project}</dd></div>
      <div><dt>Budget</dt><dd>{(view.budgetBytes / 1000).toFixed(0)} KB</dd></div>
      <div><dt>Source commit</dt><dd>{view.sha}</dd></div>
      <div><dt>Working notes</dt><dd>{view.bubble === "read" ? "Read" : view.bubble === "absent" ? "Store not configured" : "Unavailable for this preview"}</dd></div>
      <div><dt>Related notes</dt><dd>{view.graph === "on" ? "Graph enabled" : "Graph not configured"}</dd></div>
    </dl>
    <h3 className={styles.heading}>Included · {included.length}</h3>
    <ul className={styles.pieces}>{pieces(included)}</ul>
    <details className={styles.excluded}>
      <summary>Left out · {excluded.length + view.rankExcludedTotal}</summary>
      <ul className={styles.pieces}>{pieces(excluded)}
        {view.rankExcluded.map(piece => <li key={piece.path} className={styles.piece}>
          <span>{label(piece.path)}</span><span>Below the top 8 related notes</span><p>{piece.why}</p>
        </li>)}
      </ul>
      {view.rankExcludedTotal > view.rankExcluded.length && <p className={styles.description}>{view.rankExcludedTotal - view.rankExcluded.length} more ranked exclusions are not listed.</p>}
      {!excluded.length && !view.rankExcludedTotal && <p className={styles.description}>Every candidate fit within the budget.</p>}
    </details>
    {view.warnings.map((warning, i) => <p key={i} className={styles.description}>{warning}</p>)}
  </div>;
}
