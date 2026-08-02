import { requireSecret } from "@/lib/gate";
import { health } from "@/lib/health";
import styles from "../console.module.css";

export const dynamic = "force-dynamic";
export const maxDuration = 60;
export const metadata = { title: "Corpus · Cortex console" };

/** Corpus — the directory strip and the full ledger, straight from NoteRow.strip. */
export default async function Corpus({
  params,
}: {
  params: Promise<{ secret: string }>;
}) {
  await requireSecret(params);
  const h = await health();
  const maxDir = Math.max(1, ...h.byDir.map((d) => d.tokens));

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
            every live note, largest first · each tick is one block · amber ticks are retracted
          </span>
        </div>
        <div className={styles.thead}>
          <div>note</div><div>blocks</div>
          <div className={styles.right}>tokens</div><div className={styles.right}>ret</div>
        </div>
        {h.notes.map((n) => {
          const cut = n.path.lastIndexOf("/");
          return (
            <div key={n.path} className={styles.row}>
              <div className={styles.path}>
                {cut >= 0 && <span>{n.path.slice(0, cut + 1)}</span>}
                <b>{cut >= 0 ? n.path.slice(cut + 1) : n.path}</b>
              </div>
              <div className={styles.blocks}>
                {[...n.strip].map((c, i) => (
                  <i key={i} className={c === "x" ? styles.ret : undefined} />
                ))}
              </div>
              <div className={`${styles.right} ${styles.fig}`}>{n.tokens.toLocaleString()}</div>
              <div className={`${styles.right} ${styles.fig} ${n.retracted ? styles.figWarn : styles.figNil}`}>
                {n.retracted || "·"}
              </div>
            </div>
          );
        })}
        <div className={styles.footNote}>
          archive, tools and generated indexes excluded — the same filter the reader uses
        </div>
      </section>
    </>
  );
}
