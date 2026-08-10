import { requireSecret } from "@/lib/gate";
import { health } from "@/lib/health";
import { LedgerClient, type LedgerRetracted } from "./ledger-client";
import styles from "../console.module.css";

export const dynamic = "force-dynamic";
export const maxDuration = 60;
export const metadata = { title: "Corpus · Cortex console" };

/**
 * Corpus — the directory strip and the ledger. Every ledger row expands to the note's own
 * account of itself: title, first sentence, outline, and the retracted passages behind its
 * amber ticks. The prose that used to sit under the table lives inside the rows now — the
 * screen shows numbers until asked a question.
 */
export default async function Corpus({
  params,
}: {
  params: Promise<{ secret: string }>;
}) {
  await requireSecret(params);
  const h = await health();
  const maxDir = Math.max(1, ...h.byDir.map((d) => d.tokens));

  // Grouped once here so the client gets a plain serializable map, capped per note — an
  // expansion is a glance, not the attention screen.
  const retractedByPath: Record<string, LedgerRetracted[]> = {};
  for (const r of h.retractedList) {
    (retractedByPath[r.path] ??= []).push({ line: r.line, heading: r.heading, text: r.text });
  }
  for (const k of Object.keys(retractedByPath)) {
    retractedByPath[k] = retractedByPath[k].slice(0, 6);
  }

  return (
    <>
      <section className={styles.block}>
        <div className={styles.blockHead}><span>Directories</span></div>
        {h.byDir.map((d) => (
          <div key={d.dir} className={styles.distRow}>
            <span className={styles.distLabel}>{d.dir}</span>
            <span className={styles.distBar}><i style={{ width: `${(d.tokens / maxDir) * 100}%` }} /></span>
            <span className={styles.distN}>{d.tokens.toLocaleString()} tok · {d.notes} notes</span>
          </div>
        ))}
      </section>

      <section className={styles.block}>
        <div className={styles.blockHead}>
          <span>Corpus ledger · live @{h.sha}</span>
          <span className={styles.dim}>
            each tick one block · amber retracted · click a row to read its note&rsquo;s account
          </span>
        </div>
        <LedgerClient
          rows={h.notes.map((n) => ({
            path: n.path,
            title: n.title,
            desc: n.desc,
            headings: n.headings,
            strip: n.strip,
            tokens: n.tokens,
            blocks: n.blocks,
            retracted: n.retracted,
          }))}
          retractedByPath={retractedByPath}
        />
        <div className={styles.footNote}>
          archive, tools and generated indexes excluded — the same filter the reader uses
        </div>
      </section>
    </>
  );
}
