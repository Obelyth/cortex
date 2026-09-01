"use client";
import { useEffect, useState } from "react";
import type { NoteEdge } from "@/lib/edges";
import styles from "../console.module.css";

/**
 * The corpus ledger, made interrogable.
 *
 * It was a parts list: path, tick strip, two numbers, and a hover that promised something and
 * delivered nothing. Every row now answers the click it always invited — the note's own title,
 * its first sentence, its outline, and the exact retracted passages hiding behind the amber
 * ticks. Nothing here is new information; it is information that stopped hiding.
 *
 * All strings arrive pre-redacted from health() — this component displays, it never scrubs,
 * because two scrubbing opinions drift and the second one is always the one that misses.
 */

export interface LedgerRow {
  path: string;
  title: string;
  desc: string;
  headings: Array<{ h: string; line: number }>;
  strip: string;
  tokens: number;
  blocks: number;
  retracted: number;
}

export interface LedgerRetracted {
  line: number;
  heading: string;
  text: string;
}

/**
 * The connections graph, as the ledger receives it. "off" never reaches this component — the
 * page collapses it to null so an unconfigured deployment renders no panel at all (the opt-in
 * law). The other degraded states DO arrive, because each names something true the operator can
 * act on, and a panel that vanished instead would make the console lie by omission.
 */
export type LedgerConnections =
  | { state: "missing" | "empty" | "unavailable" }
  | { state: "built"; head: string; builtAt: string; byNote: Record<string, NoteEdge[]> };

/** Strongest claim first: an explicit link outranks a correction chain outranks shared tags
 *  outranks co-reading outranks mere lexical similarity. */
const KIND_ORDER: Array<NoteEdge["kind"]> = ["link", "correction", "tag", "coaccess", "lexical"];

/** Each weight with its unit and scope — a bare number on this console is a QC failure. */
function weightLabel(e: NoteEdge): string {
  switch (e.kind) {
    case "link":
      return `${e.weight} ref${e.weight === 1 ? "" : "s"}`;
    case "correction":
      return `${e.weight} marker${e.weight === 1 ? "" : "s"}`;
    case "tag":
      return `${e.weight} shared tag${e.weight === 1 ? "" : "s"}`;
    case "coaccess":
      return `${e.weight} co-read windows`;
    case "lexical":
      return `bm25 ${e.weight}`;
  }
}

/** Coarse on purpose: the exact instant rides in the title attribute. Client-only — this only
 *  renders inside an expansion the user has already clicked, so it can never mismatch SSR. */
function ago(iso: string): string {
  const s = Math.max(0, (Date.now() - Date.parse(iso)) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} d ago`;
}

export function LedgerClient({
  rows,
  retractedByPath,
  initialFilter,
  connections,
  jump,
  pinPanel,
}: Readonly<{
  rows: LedgerRow[];
  retractedByPath: Record<string, LedgerRetracted[]>;
  initialFilter?: string;
  connections?: LedgerConnections | null;
  /** A heat tile was clicked: filter to this path and open its expansion. `seq` increments per
   *  click so the same tile clicked twice re-opens after the operator closed it. */
  jump?: { path: string; seq: number } | null;
  /** The pin control, rendered by the owner so the pin state has one home (the corpus screen)
   *  and this component stays what it is: a display of the note's own account of itself. */
  pinPanel?: (path: string) => React.ReactNode;
}>) {
  const [open, setOpen] = useState<string | null>(null);
  // The heat view's tiles land here: same behaviour as the connections panel's own
  // "open <path>" button — filter to the note, expand it.
  useEffect(() => {
    if (!jump) return;
    setQ(jump.path);
    setOpen(jump.path);
    setEviOpen(null);
  // eslint-disable-next-line react-hooks/exhaustive-deps -- seq IS the trigger; path rides along
  }, [jump?.seq]);
  // Which edge's evidence is unfolded, keyed by note|kind|other. One at a time, like the
  // triage queue: evidence is a glance, and five open drawers is a wall.
  const [eviOpen, setEviOpen] = useState<string | null>(null);
  // Ninety rows and no way to reach one: finding your own note meant scrolling the whole
  // corpus. Substring match on the path, which is what the operator actually knows — they
  // think "cortex" or "log/2026-08", not a folder position in a sorted list.
  // Seeded from ?note= so a mark clicked in the overview's corpus field lands on that note with
  // the ledger already filtered to it — the field is an index, and an index that drops you at
  // the top of an unfiltered list is not one.
  const [q, setQ] = useState(initialFilter ?? "");
  const needle = q.trim().toLowerCase();
  const shown = needle ? rows.filter((n) => n.path.toLowerCase().includes(needle)) : rows;

  return (
    <>
      <div className="ledgerBar">
        <input
          className="ledgerFilter"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="filter by path — projects/, log/2026-08, cortex…"
          aria-label="Filter notes by path"
          autoComplete="off"
        />
        <span className="ledgerCount">
          {needle ? `${shown.length} of ${rows.length}` : `${rows.length} notes`}
        </span>
      </div>
      <div className={styles.thead}>
        <div />
        <div>note</div>
        <div>blocks</div>
        <div className={styles.right}>tokens</div>
        <div className={styles.right}>ret</div>
      </div>
      {shown.length === 0 && (
        <div className="ledgerNone">nothing matches “{q.trim()}” — the corpus has {rows.length} notes</div>
      )}
      {shown.map((n) => {
        const cut = n.path.lastIndexOf("/");
        const isOpen = open === n.path;
        const dead = retractedByPath[n.path] ?? [];
        return (
          <div key={n.path}>
            <button
              type="button"
              className={`${styles.row} ${styles.rowBtn}${isOpen ? " " + styles.rowOn : ""}`}
              aria-expanded={isOpen}
              onClick={() => setOpen(isOpen ? null : n.path)}
            >
              <span className={`revCaret${isOpen ? " revCaretOpen" : ""}`} aria-hidden />
              <span className={styles.path}>
                {cut >= 0 && <span>{n.path.slice(0, cut + 1)}</span>}
                <b>{cut >= 0 ? n.path.slice(cut + 1) : n.path}</b>
              </span>
              <span className={styles.blocks}>
                {[...n.strip].map((c, i) => (
                  <i key={i} className={c === "x" ? styles.ret : undefined} />
                ))}
              </span>
              <span className={`${styles.right} ${styles.fig}`}>{n.tokens.toLocaleString()}</span>
              <span
                className={`${styles.right} ${styles.fig} ${n.retracted ? styles.figWarn : styles.figNil}`}
              >
                {n.retracted || "·"}
              </span>
            </button>

            {isOpen && (
              <div className={styles.noteCard}>
                <div className={styles.noteTitle}>
                  {n.title}
                  <span className={styles.note}>
                    {n.blocks} blocks · ~{n.tokens.toLocaleString()} tokens
                    {n.retracted > 0 && ` · ${n.retracted} retracted`}
                  </span>
                </div>
                {n.desc && <p className={styles.noteDesc}>{n.desc}</p>}

                {n.headings.length > 1 && (
                  <div className={styles.noteOutline}>
                    {n.headings.map((h) => (
                      <div key={`${h.line}`} className={styles.noteHeading}>
                        <span className={styles.fig}>{h.line}</span>
                        <span>{h.h}</span>
                      </div>
                    ))}
                  </div>
                )}

                {dead.length > 0 && (
                  <div className={styles.noteDead}>
                    {dead.map((r, i) => (
                      <div key={i} className={styles.noteDeadRow}>
                        <span className={styles.fig}>{r.line}</span>
                        <span>{r.text}</span>
                      </div>
                    ))}
                    <div className={styles.note}>
                      kept on the page and flagged — a quote from here is stamped, never silently
                      trusted
                    </div>
                  </div>
                )}

                {pinPanel?.(n.path)}

                {connections && (
                  <div className={styles.cxnPanel}>
                    <div className={styles.cxnHead}>
                      <span className={styles.cxnLabel}>connections</span>
                      {connections.state === "built" && (
                        <span className={styles.cxnMeta} title={connections.builtAt}>
                          edges at {connections.head} · rebuilt {ago(connections.builtAt)} · top 5
                          per kind by weight
                        </span>
                      )}
                    </div>

                    {connections.state === "missing" && (
                      <div className={styles.cxnNone}>
                        no connections built — migration pending, run scripts/migrate.ts --apply
                      </div>
                    )}
                    {connections.state === "empty" && (
                      <div className={styles.cxnNone}>
                        no connections built yet — the next brain write triggers the first build,
                        or run scripts/build-edges.ts
                      </div>
                    )}
                    {connections.state === "unavailable" && (
                      <div className={styles.cxnNone}>
                        connections unavailable — the graph store did not answer, so this panel is
                        dark; the graph itself is untouched. Reload to retry.
                      </div>
                    )}

                    {connections.state === "built" &&
                      ((connections.byNote[n.path] ?? []).length === 0 ? (
                        <div className={styles.cxnNone}>
                          no edges reach this note at {connections.head} — it shares no links,
                          tags, markers, co-reads or top-5 lexical neighbours
                        </div>
                      ) : (
                        KIND_ORDER.filter((k) =>
                          (connections.byNote[n.path] ?? []).some((e) => e.kind === k)
                        ).map((kind) => (
                          <div key={kind} className={styles.cxnGroup}>
                            {(connections.byNote[n.path] ?? [])
                              .filter((e) => e.kind === kind)
                              .map((e) => {
                                const key = `${n.path}|${e.kind}|${e.other}`;
                                const isEvi = eviOpen === key;
                                return (
                                  <div key={key}>
                                    <button
                                      type="button"
                                      className={styles.cxnRow}
                                      aria-expanded={isEvi}
                                      onClick={() => setEviOpen(isEvi ? null : key)}
                                    >
                                      <span
                                        className={`revCaret${isEvi ? " revCaretOpen" : ""}`}
                                        aria-hidden
                                      />
                                      <span className={styles.cxnKind}>{e.kind}</span>
                                      <span className={styles.cxnDir} aria-hidden>
                                        {e.dir === "out" ? "→" : e.dir === "in" ? "←" : "↔"}
                                      </span>
                                      <span className={styles.cxnOther}>{e.other}</span>
                                      <span className={styles.cxnW}>{weightLabel(e)}</span>
                                    </button>
                                    {isEvi && (
                                      <div className={styles.cxnEvi}>
                                        <span>{e.evidence}</span>
                                        <button
                                          type="button"
                                          className={styles.cxnGo}
                                          onClick={() => {
                                            setQ(e.other);
                                            setOpen(e.other);
                                            setEviOpen(null);
                                          }}
                                        >
                                          open {e.other}
                                        </button>
                                      </div>
                                    )}
                                  </div>
                                );
                              })}
                          </div>
                        ))
                      ))}
                  </div>
                )}
              </div>
            )}
          </div>
        );
      })}
    </>
  );
}
