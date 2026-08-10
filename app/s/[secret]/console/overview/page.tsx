import { requireSecret } from "@/lib/gate";
import { health } from "@/lib/health";
import { listCommits, type CommitInfo } from "@/lib/github";
import { readCalls, SCOPE_NOTE } from "@/lib/calls";
import { readSettings, safeActiveReader } from "@/lib/settings";
import { providerOf, providerConfigured } from "@/lib/reader";
import { Reveal } from "../reveal";
import styles from "../console.module.css";

export const dynamic = "force-dynamic";
export const maxDuration = 60;
export const metadata = { title: "Overview · Cortex console" };

const VERDICT_ORDER = [
  { tag: "Verified", stamp: "VERIFIED", cls: styles.vPass },
  { tag: "Superseded", stamp: "SUPERSEDED", cls: styles.vWarn },
  // Its own row, not folded into Superseded: "answered from dead text" and "answered from a
  // passage that records its own correction" are different events, and only the first is a
  // problem. Counting them together is what let the stamp start crying wolf.
  { tag: "Corrected", stamp: "CORRECTED", cls: styles.vCyan },
  { tag: "Partially verified", stamp: "PARTIALLY VERIFIED", cls: styles.vWarn },
  { tag: "Not in brain", stamp: "NOT IN BRAIN", cls: styles.vCyan },
  { tag: "Unverified", stamp: "UNVERIFIED", cls: styles.vFail },
  { tag: "Error", stamp: "ERROR", cls: styles.vFail },
];

/**
 * Overview — corpus load and the three counts, then what the server has actually seen: calls
 * per hour, the verdict split, which doors are in use, and the ingest feed.
 *
 * The call panels read the in-process log, which starts empty on a cold boot. Every one of them
 * states the window it really covers rather than claiming a flat 24 hours — an empty chart
 * labelled "24 hours" would read as silence when it means "no log yet".
 */
export default async function Overview({
  params,
}: {
  params: Promise<{ secret: string }>;
}) {
  await requireSecret(params);
  const h = await health();
  let commits: CommitInfo[] = [];
  try {
    commits = await listCommits(20);
  } catch {
    /* the ingest feed degrades to empty */
  }

  const t = h.totals;
  const pct = Math.round((t.tokens / t.ceiling) * 100);
  const crit = h.triage.filter((q) => q.sev === "crit").length;

  const now = Date.now();
  const { rows, partial, covers, durable, source } = await readCalls(86_400_000, now);
  const hours = Array.from({ length: 24 }, (_, i) => {
    // (24 - i), not (23 - i): the last bucket must end at now, or the bar the axis calls
    // "now" covers the next hour and is structurally always empty.
    const from = now - (24 - i) * 3_600_000;
    const to = from + 3_600_000;
    const inHour = rows.filter((r) => r.ts >= from && r.ts < to);
    return {
      total: inHour.length,
      verified: inHour.filter((r) => r.stamp === "VERIFIED").length,
    };
  });
  const peak = Math.max(1, ...hours.map((x) => x.total));
  const verdictRows = VERDICT_ORDER.map((v) => ({
    ...v,
    n: rows.filter((r) => r.stamp === v.stamp).length,
  }));
  const verdictMax = Math.max(1, ...verdictRows.map((v) => v.n));
  // Only stamps with a bar. READ / COMMITTED / BOOT are real calls with no verdict, so
  // counting them in this header would read as verdicts that came back blank.
  const verdictTotal = verdictRows.reduce((a, v) => a + v.n, 0);

  // Which reader answered, per model. The verdict panel above is an aggregate across every
  // model that ran in the window, and once more than one can read the brain an aggregate stops
  // being a fact about trustworthiness — it is a blend whose mix nobody stated. This is the
  // mix. Rows logged before the model field shipped are counted OUT LOUD as unattributed
  // rather than folded into whichever model happens to be reading today.
  const asks = rows.filter((r) => r.tool === "brain_ask");
  const attributed = asks.filter((r) => r.model);
  const unattributed = asks.length - attributed.length;
  const byReader = [...new Set(attributed.map((r) => r.model as string))]
    .map((m) => {
      const mine = attributed.filter((r) => r.model === m);
      return {
        model: m,
        calls: mine.length,
        verified: mine.filter((r) => r.stamp === "VERIFIED").length,
        bad: mine.filter((r) => r.stamp === "UNVERIFIED" || r.stamp === "ERROR").length,
      };
    })
    .sort((a, b) => b.calls - a.calls);
  const byMax = Math.max(1, ...byReader.map((b) => b.calls));

  const settings = await readSettings();
  const { active, error: resolveError } = await safeActiveReader(settings);
  const activeProvider = active ? providerOf(active.model)! : null;
  // Presence only — the secret itself never reaches a rendered page.
  const guestOpen = Boolean(process.env.GUEST_PATH_SECRET?.trim());

  const doors = (
    [
      { name: "Terminal", auth: "bearer", key: "terminal" as const, trust: "writes" },
      { name: "Connectors", auth: "secret url", key: "connector" as const, trust: "writes" },
      // Listed even when unconfigured, so the panel answers "is there a guest door open?"
      // rather than only ever showing doors that happen to have traffic.
      { name: "Guest", auth: "guest url", key: "guest" as const, trust: "proposes only" },
    ]
  ).map((d) => {
    const mine = rows.filter((r) => r.surface === d.key);
    return {
      ...d,
      last: mine.length ? Math.max(...mine.map((r) => r.ts)) : null,
      calls: mine.length,
    };
  });

  const ago = (ms: number) => {
    const m = Math.floor((now - ms) / 60_000);
    return m < 1 ? "now" : m < 60 ? `${m} min` : m < 2880 ? `${Math.floor(m / 60)} hr` : `${Math.floor(m / 1440)} d`;
  };
  const agoIso = (iso: string) => {
    const ts = new Date(iso).getTime();
    return Number.isFinite(ts) ? ago(ts) : "—";
  };
  const window =
    covers < 60_000
      ? "log just started"
      : `log covers ${covers < 3_600_000 ? `${Math.round(covers / 60_000)} min` : `${Math.round(covers / 3_600_000)} hr`}`;

  return (
    <div className={styles.screen}>
      <div className={styles.headRow}>
        <div>
          <div className={styles.label}>Corpus load</div>
          <div className={styles.bigRow}>
            <span className={styles.big}>{pct}</span>
            <span className={styles.bigUnit}>%</span>
          </div>
          <div className={styles.meter}><i style={{ width: `${Math.min(100, pct)}%` }} /></div>
          <div className={styles.note}>
            {t.tokens.toLocaleString()} of {t.ceiling.toLocaleString()} tokens · one tarball, one head lookup
          </div>
        </div>
        <div className={styles.statTrio}>
          <div className={styles.stat}>
            <div className={styles.label}>Notes live</div>
            <div className={styles.statN}>{t.notes}</div>
            <div className={styles.note}>{t.blocks.toLocaleString()} blocks</div>
          </div>
          <div className={styles.stat}>
            <div className={styles.label}>Retracted</div>
            <div className={styles.statN}>{t.retractedBlocks}</div>
            <div className={styles.note}>in {t.notesWithRetracted} notes</div>
          </div>
          <div className={styles.stat}>
            <div className={styles.label}>Attention</div>
            <div className={`${styles.statN} ${styles.statWarn}`}>{h.triage.length}</div>
            <div className={styles.note}>{crit} critical</div>
          </div>
        </div>
      </div>

      <div className={styles.rule} />

      <div className={styles.split}>
        <div className={styles.splitMain}>
          <section>
            <div className={styles.sectionHead}>
              <span className={styles.label}>Calls · last 24 hours</span>
              {/* Symbols first; the qualifying sentence lives one caret down. The two states a
                  glance must not miss — a partial window, a non-durable log — stay visible, as
                  two words rather than a clause. Honesty is not the same thing as paragraphs. */}
              <span className="swatches">
                <span className="swatch"><i style={{ background: "var(--accent)" }} />verified</span>
                <span className="swatch"><i style={{ background: "var(--ob-ink-600)" }} />other</span>
                {partial && <span className={styles.note}>{window}</span>}
                {source !== "store" && (
                  <Reveal label={source === "unconfigured" ? "no store" : "store down"}>
                    {source === "unconfigured"
                      ? `No durable store is configured, so this is one instance's in-memory log — ${SCOPE_NOTE}.`
                      : `The shared store was unreachable this render, so this is the in-memory fallback — ${SCOPE_NOTE}.`}
                  </Reveal>
                )}
              </span>
            </div>
            <div className={styles.chart} role="img"
              aria-label={`Calls per hour, peak ${peak}${partial ? `, ${window}` : ""}`}>
              {hours.map((x, i) => (
                <div key={i} className={styles.barCol}>
                  <i className={styles.barRest}
                    style={{ height: `${((x.total - x.verified) / peak) * 100}%` }} />
                  <i className={styles.barVerified}
                    style={{ height: `${(x.verified / peak) * 100}%` }} />
                </div>
              ))}
            </div>
            <div className={styles.chartAxis}>
              {/* Relative, because the window is: absolute clock labels are only true for a
                  page loaded exactly at midnight. */}
              <span>-24h</span><span>-18h</span><span>-12h</span><span>-6h</span><span>now</span>
            </div>
            {rows.length === 0 && (
              <div className={styles.empty}>
                {/* The verdict stays visible in five words; the reasoning waits behind the
                    caret. What must never hide is WHICH of the two claims is being made —
                    "quiet" and "can't tell" are different sentences on purpose. */}
                {durable && !partial ? "No calls — the server was quiet." : "No calls shown — the log cannot attest the full day."}{" "}
                <Reveal label="why">
                  {durable
                    ? partial
                      ? `Collection began too recently: the store covers ${window.replace("log covers ", "")} of the last 24 hours.`
                      : "This is the shared record — every instance writes to the cortex-calls store, so an empty chart means the server really was quiet."
                    : `This is one instance's in-memory view — ${SCOPE_NOTE}. An empty chart here does not mean the server was idle.`}
                </Reveal>
              </div>
            )}
          </section>

          <section>
            <div className={styles.sectionHead}>
              <span className={styles.label}>
                Verdicts · {verdictTotal} of {rows.length} calls returned one
              </span>
              <span className={styles.note}>
                {byReader.length > 1 ? `blended across ${byReader.length} readers` : "every reader, together"}
              </span>
            </div>
            {verdictRows.map((v) => (
              <div key={v.tag} className={styles.verdictRow}>
                <span className={`${styles.verdictTag} ${v.cls}`}>{v.tag}</span>
                <span className={styles.verdictBar}>
                  <i className={v.cls} style={{ width: `${(v.n / verdictMax) * 100}%` }} />
                </span>
                <span className={styles.verdictN}>{v.n}</span>
              </div>
            ))}
          </section>

          <section>
            <div className={styles.sectionHead}>
              <span className={styles.label}>By reader</span>
              <span className="swatches">
                {byReader.length > 0 && (
                  <>
                    <span className="swatch"><i style={{ background: "var(--ok)" }} />verified</span>
                    <span className="swatch"><i style={{ background: "var(--crit)" }} />failed</span>
                    <span className="swatch"><i style={{ background: "var(--ob-ink-600)" }} />other</span>
                  </>
                )}
                {unattributed > 0 && (
                  <Reveal label={`${unattributed} unattributed`}>
                    Logged before the per-model field shipped — they belong to no reader row, and
                    counting them into one would rewrite history.
                  </Reveal>
                )}
              </span>
            </div>
            {/* A row per reader, and each row goes somewhere: the readers screen is where this
                mix becomes a control. Mute rows teach people to stop clicking. */}
            {byReader.map((b) => (
              <a key={b.model} href="readers" className={styles.byRow}>
                <span className={styles.byName}>{b.model}</span>
                <span className={styles.rdTrack} style={{ width: `${(b.calls / byMax) * 100}%` }}>
                  <i className={styles.rdPass} style={{ flex: b.verified }} />
                  <i className={styles.rdFail} style={{ flex: b.bad }} />
                  <i className={styles.rdRest} style={{ flex: Math.max(0, b.calls - b.verified - b.bad) }} />
                </span>
                <span className={`${styles.right} ${styles.fig}`}>{b.calls}</span>
              </a>
            ))}
            {byReader.length === 0 && (
              <div className={styles.empty}>
                {asks.length === 0 ? "No asks in this window." : "Asks exist, but none carry a reader yet."}{" "}
                <Reveal label="why this panel matters">
                  Once more than one reader has answered, this is where their records diverge —
                  and the aggregate above stops being the whole story.
                </Reveal>
              </div>
            )}
          </section>
        </div>

        <div className={styles.rail}>
          <section>
            <div className={styles.label}>Reading as</div>
            <div className={styles.doorRow}>
              <span
                className={
                  active && activeProvider && providerConfigured(activeProvider)
                    ? styles.dotLive
                    : styles.dotWarn
                }
              />
              <span className={styles.doorName}>
                <span className={styles.byName}>{active ? active.model : "unresolved"}</span>
                <span className={styles.note}>
                  {active && activeProvider
                    ? `${activeProvider} · ${
                        active.source === "console"
                          ? "set in the console"
                          : active.source === "env"
                            ? "from READER_MODEL"
                            : "built-in default"
                      }`
                    : "no reader resolves"}
                </span>
              </span>
              <a className={styles.railLink} href="readers">readers</a>
            </div>
            {resolveError && <div className={styles.railNote}>{resolveError}</div>}
            {active && activeProvider && !providerConfigured(activeProvider) && (
              <div className={styles.railNote}>
                This reader&rsquo;s provider key is missing, so brain_ask will error on the next
                call. Set it, or change the default on the readers screen.
              </div>
            )}
            {settings.disabledProviders.length > 0 && (
              <div className={styles.railNote}>
                {settings.disabledProviders.join(", ")} switched off — callers cannot select
                those models.
              </div>
            )}
          </section>

          <section>
            <div className={styles.sectionHead}>
              <span className={styles.label}>Doors</span>
              {/* The panel says which doors exist; the guide says how to wire one. Relative
                  href, so the secret stays out of markup like every other console link. */}
              <a className={styles.railLink} href="guide">set up</a>
            </div>
            {doors.map((d) => (
              <div key={d.key} className={styles.doorRow}>
                <span className={d.last ? styles.dotLive : styles.dotIdle} />
                <span className={styles.doorName}>
                  <span>{d.name}</span>
                  <span className={styles.note}>
                    {d.auth} · {d.trust}
                    {d.key === "guest" && !guestOpen && " · not configured"}
                  </span>
                </span>
                <span className={styles.note}>{d.last ? ago(d.last) : "no calls"}</span>
              </div>
            ))}
            <div className={styles.railNote}>
              <Reveal label="what a door can tell you">
                The server sees which door a call used, not which app sent it — bearer is a
                terminal client, the secret URL is a connector, the guest URL is an assistant
                the operator does not control. The first two may write; the guest may only propose.
                {durable ? "" : ` Counts are ${SCOPE_NOTE}.`}
              </Reveal>
            </div>
          </section>

          <section>
            <div className={styles.label}>Ingest · every write is a commit</div>
            {commits.slice(0, 6).map((c) => (
              <div key={c.sha} className={styles.commitRow}>
                <span className={styles.sha}>{c.sha}</span>
                <span className={styles.msg}>{c.message}</span>
                <span className={styles.agoCol}>{agoIso(c.date)}</span>
              </div>
            ))}
          </section>
        </div>
      </div>
    </div>
  );
}
