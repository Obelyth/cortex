"use client";
import { useState } from "react";
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

export function LedgerClient({
  rows,
  retractedByPath,
}: Readonly<{
  rows: LedgerRow[];
  retractedByPath: Record<string, LedgerRetracted[]>;
}>) {
  const [open, setOpen] = useState<string | null>(null);

  return (
    <>
      <div className={styles.thead}>
        <div />
        <div>note</div>
        <div>blocks</div>
        <div className={styles.right}>tokens</div>
        <div className={styles.right}>ret</div>
      </div>
      {rows.map((n) => {
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
              </div>
            )}
          </div>
        );
      })}
    </>
  );
}
