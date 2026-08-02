import { requireSecret } from "@/lib/gate";
import { health } from "@/lib/health";
import { listCommits, type CommitInfo } from "@/lib/github";
import styles from "../console.module.css";

export const dynamic = "force-dynamic";
export const maxDuration = 60;
export const metadata = { title: "Overview · Cortex console" };

/** Overview — the instrument row, the write rhythm, the corpus split and the ingest feed.
 *  All real: panels for telemetry cortex does not keep (calls/hour, verdict stream,
 *  last-seen surfaces) are cut rather than faked. */
export default async function Overview({
  params,
}: {
  params: Promise<{ secret: string }>;
}) {
  await requireSecret(params);
  const h = await health();
  let commits: CommitInfo[] = [];
  try {
    commits = await listCommits(100);
  } catch {
    /* feed degrades to empty */
  }

  const t = h.totals;
  const pct = Math.round((t.tokens / t.ceiling) * 100);
  const crit = h.triage.filter((q) => q.sev === "crit").length;

  const byDay = new Map<string, number>();
  for (const c of commits) {
    const d = c.date.slice(0, 10);
    byDay.set(d, (byDay.get(d) ?? 0) + 1);
  }
  const days: { label: string; n: number }[] = [];
  for (let i = 29; i >= 0; i--) {
    const d = new Date(Date.now() - i * 86_400_000).toISOString().slice(0, 10);
    days.push({ label: d.slice(5), n: byDay.get(d) ?? 0 });
  }
  const maxDay = Math.max(1, ...days.map((d) => d.n));
  const maxDir = Math.max(1, ...h.byDir.map((d) => d.tokens));
  const ago = (iso: string) => {
    const t = new Date(iso).getTime();
    if (!Number.isFinite(t)) return "—";
    const m = Math.floor((Date.now() - t) / 60_000);
    return m < 1 ? "now" : m < 60 ? `${m} min` : m < 2880 ? `${Math.floor(m / 60)} hr` : `${Math.floor(m / 1440)} d`;
  };

  return (
    <>
      <div className={styles.instruments}>
        <div className={styles.cell}>
          <div className={styles.cellLabel}>Corpus load</div>
          <div className={styles.big}>{pct}<span className={styles.unit}>%</span></div>
          <div className={styles.meter}><i style={{ width: `${pct}%` }} /></div>
          <div className={styles.cellNote}>
            {t.tokens.toLocaleString()} of {t.ceiling.toLocaleString()} tok · one tarball, one head lookup
          </div>
        </div>
        <div className={styles.cell}>
          <div className={styles.cellLabel}>Notes live</div>
          <div className={styles.big}>{t.notes}</div>
          <div className={styles.cellNote}>{t.blocks.toLocaleString()} blocks · {h.byDir.length} directories</div>
        </div>
        <div className={styles.cell}>
          <div className={styles.cellLabel}>Retracted</div>
          <div className={styles.big}>{t.retractedBlocks}</div>
          <div className={styles.cellNote}>kept on the page, in {t.notesWithRetracted} notes</div>
        </div>
        <div className={`${styles.cell} ${crit ? styles.cellCrit : styles.cellWarn}`}>
          <div className={styles.cellLabel}>Attention</div>
          <div className={styles.big}>{h.triage.length}</div>
          <div className={styles.cellNote}>{crit} critical · {h.triage.length - crit} warnings</div>
        </div>
      </div>

      <section className={styles.block}>
        <div className={styles.blockHead}>
          <span>Writes · last 30 days</span>
          <span className={styles.dim}>
            every bar is commits, not calls — cortex keeps no call log
            {commits.length === 100 ? " · newest 100 writes shown" : ""}
          </span>
        </div>
        <div className={styles.chart} role="img"
          aria-label={`Commit activity, last 30 days, peak ${maxDay} per day`}>
          {days.map((d) => (
            <i key={d.label} style={{ height: `${Math.max(4, (d.n / maxDay) * 100)}%` }}
              className={d.n ? styles.barOn : styles.barOff} title={`${d.label}: ${d.n}`} />
          ))}
        </div>
        <div className={styles.chartAxis}>
          <span>{days[0].label}</span><span>{days[15].label}</span><span>now</span>
        </div>
      </section>

      <div className={styles.twoCol}>
        <section className={styles.block}>
          <div className={styles.blockHead}><span>Corpus by directory</span></div>
          {h.byDir.map((d) => (
            <div key={d.dir} className={styles.distRow}>
              <span className={styles.distLabel}>{d.dir}</span>
              <span className={styles.distBar}><i style={{ width: `${(d.tokens / maxDir) * 100}%` }} /></span>
              <span className={styles.distN}>{d.tokens.toLocaleString()} tok · {d.notes}</span>
            </div>
          ))}
        </section>

        <section className={styles.block}>
          <div className={styles.blockHead}>
            <span>Ingest · every write is a commit</span>
            <span className={styles.dim}>{commits[0] ? `last write ${ago(commits[0].date)} ago` : ""}</span>
          </div>
          {commits.slice(0, 8).map((c) => (
            <div key={c.sha} className={styles.commitRow}>
              <span className={styles.sha}>{c.sha}</span>
              <span className={styles.msg}>{c.message}</span>
              <span className={styles.agoCol}>{ago(c.date)}</span>
            </div>
          ))}
        </section>
      </div>
    </>
  );
}
