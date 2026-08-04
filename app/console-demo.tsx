"use client";

/**
 * The landing's console demo — the gated console's operations shell rendered over the same
 * kind of synthetic data as the demo map. It exists so the landing can show the instrument
 * without showing an inventory: every number, path and SHA comes from console-demo-data.ts,
 * the clock is a counter rather than the time, and nothing here links to a gated route.
 * The map tab embeds /map — the public demo map, already synthetic and labelled.
 */

import Image from "next/image";
import { useEffect, useState } from "react";
import {
  BARS,
  COLD,
  COMMITS,
  CREDS,
  DIRS,
  NAV,
  POOL,
  QUOTES,
  RETIRED,
  RITUALS,
  ROWS,
  STAMPS,
  STAMP_STATUS,
  SURFACES,
  TOOLS,
  type BadgeStatus,
  type ScreenKey,
  type Stamp,
} from "./console-demo-data";
import styles from "./console-demo.module.css";

/* ---------------------------------------------------------------- atoms --- */

const ICONS: Record<string, React.ReactNode> = {
  signal: <polyline points="1.5,9.5 4.5,9.5 6.5,3.5 9.5,13 11.5,7.5 13.5,7.5" />,
  database: (
    <>
      <ellipse cx="7.5" cy="3.5" rx="5.5" ry="2.2" />
      <path d="M2 3.5v8c0 1.2 2.5 2.2 5.5 2.2s5.5-1 5.5-2.2v-8" />
      <path d="M2 7.5c0 1.2 2.5 2.2 5.5 2.2s5.5-1 5.5-2.2" />
    </>
  ),
  alert: <path d="M7.5 1.8 14 13.2H1zM7.5 6v3.4m0 1.8v.4" />,
  grid: <path d="M1.5 1.5h5v5h-5zM8.5 1.5h5v5h-5zM1.5 8.5h5v5h-5zM8.5 8.5h5v5h-5z" />,
  info: <path d="M7.5 14A6.5 6.5 0 1 0 7.5 1a6.5 6.5 0 0 0 0 13zm0-9.5v.4m0 2.1V11" />,
  bell: <path d="M7.5 1.8a4 4 0 0 0-4 4c0 3.2-1.3 4.4-1.3 4.4h10.6S11.5 9 11.5 5.8a4 4 0 0 0-4-4zM6 12.5a1.6 1.6 0 0 0 3 0" />,
  settings: (
    <>
      <circle cx="7.5" cy="7.5" r="2.2" />
      <path d="M7.5 1v2.2M7.5 11.8V14M1 7.5h2.2M11.8 7.5H14M2.9 2.9l1.6 1.6M10.5 10.5l1.6 1.6M12.1 2.9l-1.6 1.6M4.5 10.5l-1.6 1.6" />
    </>
  ),
};

function Icon({ name }: { name: string }) {
  return (
    <svg viewBox="0 0 15 15" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="1.3" aria-hidden="true">
      {ICONS[name]}
    </svg>
  );
}

function Badge({ status, children }: { status: BadgeStatus; children: React.ReactNode }) {
  return <span className={`${styles.badge} ${styles["b_" + status]}`}>{children}</span>;
}

function StampBadge({ stamp }: { stamp: Stamp }) {
  return <Badge status={STAMP_STATUS[stamp]}>{stamp}</Badge>;
}

function Cap({ children, tone }: { children: React.ReactNode; tone?: "fail" | "warn" }) {
  return <div className={`${styles.cap} ${tone ? styles["cap_" + tone] : ""}`}>{children}</div>;
}

/* ----------------------------------------------------------------- demo --- */

const START_SEC = 52327;

function fmt(sec: number): string {
  const s = ((sec % 86400) + 86400) % 86400;
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(Math.floor(s / 3600))}:${p(Math.floor(s / 60) % 60)}:${p(s % 60)}`;
}

type StreamRow = (typeof POOL)[number] & { time: string; key: number };

const event = (i: number, sec: number): StreamRow => ({
  ...POOL[((i % POOL.length) + POOL.length) % POOL.length],
  time: fmt(sec),
  key: i,
});

const INITIAL_STREAM = [0, 1, 2, 3, 4, 5, 6, 7].map((i) => event(i, START_SEC - i * 37));

export default function ConsoleDemo() {
  const [screen, setScreen] = useState<ScreenKey>("overview");
  const [t, setT] = useState(0);
  const [stream, setStream] = useState<StreamRow[]>(INITIAL_STREAM);

  useEffect(() => {
    const iv = setInterval(() => {
      setT((prev) => {
        const next = prev + 1;
        if (next % 3 === 0) {
          setStream((s) => [event(Math.floor(next / 3) + 8, START_SEC + next)].concat(s).slice(0, 8));
        }
        return next;
      });
    }, 1000);
    return () => clearInterval(iv);
  }, []);

  const sec = START_SEC + t;

  return (
    <div className={styles.frame}>
      {/* ------------------------------------------------------- top bar --- */}
      <div className={styles.bar}>
        <Image src="/brand/obelyth-emblem.png" alt="" width={26} height={26} />
        <div className={styles.lockup}>
          <span className={styles.word}>Cortex</span>
          <span className={styles.by}>by Obelyth</span>
        </div>
        <div className={styles.vr} />
        <span className={styles.barTag}>private memory server</span>
        <span className={`${styles.barTag} ${styles.demoTag}`}>demo · synthetic data</span>
        <div className={styles.sp} />
        <div className={styles.chip}>
          <span className={styles.chipLabel}>head</span>
          <span className={styles.chipVal}>0e1f2a3</span>
        </div>
        <div className={styles.clock}>
          <span className={styles.blip} />
          <span>{fmt(sec)}</span>
        </div>
        <button type="button" className={styles.iconBtn} aria-label="Alerts (demo)">
          <Icon name="bell" />
        </button>
        <button type="button" className={styles.iconBtn} aria-label="Settings (demo)">
          <Icon name="settings" />
        </button>
      </div>

      <div className={styles.body}>
        {/* ------------------------------------------------------ sidebar --- */}
        <div className={styles.side}>
          <div className={styles.navCap}>Monitor</div>
          {NAV.slice(0, 3).map((it) => (
            <button
              key={it.k}
              type="button"
              className={`${styles.navBtn} ${screen === it.k ? styles.navOn : ""}`}
              aria-pressed={screen === it.k}
              onClick={() => setScreen(it.k)}
            >
              <Icon name={{ overview: "signal", corpus: "database", attention: "alert" }[it.k as string] ?? "signal"} />
              <span className={styles.navLabel}>{it.label}</span>
              {it.count && <span className={styles.navCount}>{it.count}</span>}
            </button>
          ))}
          <div className={styles.navCap}>System</div>
          {NAV.slice(3).map((it) => (
            <button
              key={it.k}
              type="button"
              className={`${styles.navBtn} ${screen === it.k ? styles.navOn : ""}`}
              aria-pressed={screen === it.k}
              onClick={() => setScreen(it.k)}
            >
              <Icon name={it.k === "map" ? "grid" : "info"} />
              <span className={styles.navLabel}>{it.label}</span>
            </button>
          ))}
          <div className={styles.sp} />
          <div className={styles.endpoint}>
            <div className={styles.navCapIn}>Endpoint</div>
            <div className={styles.epRow}>
              <span className={styles.dotPass} />
              <span className={styles.epPath}>/api/mcp · bearer</span>
            </div>
            <div className={styles.epRow}>
              <span className={styles.dotPass} />
              <span className={styles.epPath}>{"/api/s/<secret>/mcp"}</span>
            </div>
            <div className={styles.epNote}>Both fail closed. A mismatch answers 404.</div>
          </div>
        </div>

        {/* --------------------------------------------------------- main --- */}
        <div className={styles.main}>
          {screen === "overview" && (
            <div className={styles.screen}>
              <div className={styles.headRow}>
                <div>
                  <div className={styles.kicker}>Live monitor</div>
                  <div className={styles.title}>Read path</div>
                </div>
                <div className={styles.headSide}>
                  <span className={styles.mutedMono}>last write 2 min ago</span>
                  <button type="button" className={styles.btn}>Refresh</button>
                </div>
              </div>

              <div className={styles.stats4}>
                <div className={styles.card}>
                  <div className={styles.statLabel}>corpus load</div>
                  <div className={styles.statValue}>64%</div>
                  <div className={styles.meter}><i style={{ width: "64%" }} /></div>
                  <div className={styles.statSub}>96,240 / 150,000 tok</div>
                </div>
                <div className={styles.card}>
                  <div className={styles.statLabel}>notes live</div>
                  <div className={styles.statValue}>68</div>
                  <div className={styles.statSub}>3,184 blocks · 4 directories</div>
                </div>
                <div className={styles.card}>
                  <div className={styles.statLabel}>retracted passages</div>
                  <div className={styles.statValue}>27</div>
                  <div className={styles.statSub}>across 9 of 68 notes</div>
                </div>
                <div className={`${styles.card} ${styles.cardWarn}`}>
                  <div className={styles.statLabel}>needs attention</div>
                  <div className={`${styles.statValue} ${styles.warnText}`}>11</div>
                  <div className={styles.statSub}>2 critical · 9 warnings</div>
                </div>
              </div>

              <div className={styles.cols}>
                <div className={styles.colMain}>
                  <div className={styles.card}>
                    <div className={styles.chartHead}>
                      <span className={styles.capText}>calls · last 24 h</span>
                      <span className={styles.mutedMono}>
                        341 asks · <span className={styles.cyan}>97.1% verified</span>
                      </span>
                    </div>
                    <div className={styles.bars}>
                      {BARS.map((b, i) => (
                        <div key={i} className={styles.barCol}>
                          <div style={{ height: b.uh }} className={styles.barU} />
                          <div style={{ height: b.vh }} className={`${styles.barV} ${b.last ? styles.barLast : ""}`} />
                        </div>
                      ))}
                    </div>
                    <div className={styles.axis}>
                      <span>00:00</span><span>06:00</span><span>12:00</span><span>18:00</span><span>now</span>
                    </div>
                  </div>

                  <div className={`${styles.card} ${styles.flush}`}>
                    <Cap>
                      <span className={styles.blip} />
                      <span className={styles.capText}>verdict stream</span>
                      <div className={styles.sp} />
                      <span className={styles.mutedMono}>deterministic verifier · no model in the loop</span>
                    </Cap>
                    <div className={`${styles.streamRow} ${styles.streamHead}`}>
                      <span>time</span><span>surface</span><span>tool</span><span>stamp</span><span>cited file</span>
                      <span className={styles.right}>ms</span>
                    </div>
                    {stream.map((e) => (
                      <div key={e.key} className={styles.streamRow}>
                        <span className={styles.numMono}>{e.time}</span>
                        <span className={styles.mutedMono}>{e.surface}</span>
                        <span className={styles.toolMono}>{e.tool}</span>
                        <span><StampBadge stamp={e.stamp} /></span>
                        <span className={styles.pathMono}>{e.path}</span>
                        <span className={`${styles.numMono} ${styles.right}`}>{e.ms}</span>
                      </div>
                    ))}
                  </div>
                </div>

                <div className={styles.colSide}>
                  <div className={`${styles.card} ${styles.flush}`}>
                    <Cap><span className={styles.capText}>Surfaces</span></Cap>
                    {SURFACES.map((s) => (
                      <div key={s.name} className={styles.surfRow}>
                        <div className={styles.surfMain}>
                          <div className={styles.surfName}>{s.name}</div>
                          <div className={styles.surfSub}>{s.sub} · {s.auth}</div>
                        </div>
                        <span className={styles.mutedMono}>{s.ago}</span>
                        <Badge status={s.status}>{s.state}</Badge>
                      </div>
                    ))}
                  </div>

                  <div className={`${styles.card} ${styles.flush}`}>
                    <Cap><span className={styles.capText}>Ingest · every write is a commit</span></Cap>
                    {COMMITS.map((c) => (
                      <div key={c.sha} className={styles.commitRow}>
                        <span className={styles.sha}>{c.sha}</span>
                        <span className={styles.commitMsg}>{c.msg}</span>
                        <span className={styles.mutedMono}>{c.ago}</span>
                      </div>
                    ))}
                    <div className={styles.ceiling}>
                      <div className={styles.ceilingHead}>
                        <span>corpus ceiling</span><span>96,240 / 150,000</span>
                      </div>
                      <div className={styles.ceilingBar}>
                        {DIRS.map((d) => (
                          <div key={d.dir} style={{ width: d.w, background: d.fill }} />
                        ))}
                        <div className={styles.ceilingRest} />
                      </div>
                      <div className={styles.legend}>
                        {DIRS.map((d) => (
                          <span key={d.dir} className={styles.legendItem}>
                            <i style={{ background: d.fill }} />
                            {d.dir} {d.tokens}
                          </span>
                        ))}
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          )}

          {screen === "corpus" && (
            <div className={styles.screen}>
              <div className={styles.headRow}>
                <div>
                  <div className={styles.kicker}>Storage · live @0e1f2a3</div>
                  <div className={styles.title}>Corpus</div>
                </div>
                <div className={styles.headSide}>
                  <span className={styles.fakeInput}>Filter by path</span>
                  <button type="button" className={styles.btn}>Export</button>
                </div>
              </div>

              <div className={styles.stats4}>
                {DIRS.map((d) => (
                  <div key={d.dir} className={styles.card}>
                    <div className={styles.statLabel}>{d.dir}</div>
                    <div className={styles.dirTokens}>
                      <span>{d.tokens}</span>
                      <span className={styles.mutedMono}>tok</span>
                    </div>
                    <div className={styles.meter}><i style={{ width: d.share, background: d.fill }} /></div>
                    <div className={styles.statSub}>{d.notes} notes</div>
                  </div>
                ))}
              </div>

              <div className={`${styles.card} ${styles.flush}`}>
                <Cap>
                  <span className={styles.capText}>Notes · largest first</span>
                  <div className={styles.sp} />
                  <span className={styles.mutedMono}>each tick is one block · amber is retracted</span>
                </Cap>
                <div className={`${styles.noteRow} ${styles.streamHead}`}>
                  <span>note</span><span>blocks</span><span className={styles.right}>tokens</span>
                  <span className={styles.right}>ret</span>
                </div>
                {ROWS.map((r) => (
                  <div key={r.dir + r.base} className={styles.noteRow}>
                    <span className={styles.notePath}>
                      <span className={styles.mutedMono}>{r.dir}</span>
                      <b>{r.base}</b>
                    </span>
                    <span className={styles.ticks}>
                      {r.ticks.map((tk, i) => (
                        <i key={i} className={tk.r ? styles.tickRet : styles.tick} />
                      ))}
                    </span>
                    <span className={`${styles.numMono} ${styles.right}`}>{r.tokens}</span>
                    <span className={`${styles.numMono} ${styles.right} ${r.ret ? styles.warnText : styles.mutedMono}`}>
                      {r.ret ?? "·"}
                    </span>
                  </div>
                ))}
                <div className={styles.tableFoot}>
                  showing 10 of 68 · archive, tools and generated indexes excluded — the same filter the reader uses
                </div>
              </div>
            </div>
          )}

          {screen === "attention" && (
            <div className={styles.screen}>
              <div className={styles.headRow}>
                <div>
                  <div className={styles.kicker}>Triage · 11 open</div>
                  <div className={styles.title}>Attention</div>
                </div>
                <div className={styles.headSide}>
                  <Badge status="fail">2 critical</Badge>
                  <Badge status="warn">9 warnings</Badge>
                </div>
              </div>

              <div className={styles.cols2}>
                <div className={styles.colHalf}>
                  <div className={`${styles.card} ${styles.flush} ${styles.cardFail}`}>
                    <Cap tone="fail">
                      <span className={styles.capText}>Credential-shaped lines</span>
                      <div className={styles.sp} />
                      <span className={styles.mutedMono}>redacted on every read · still in the repo</span>
                    </Cap>
                    {CREDS.map((c) => (
                      <div key={c.loc} className={styles.credRow}>
                        <span className={styles.sha}>{c.loc}</span>
                        <span className={styles.tag}>{c.kind}</span>
                        <button type="button" className={styles.btnGhost}>Open</button>
                      </div>
                    ))}
                  </div>

                  <div className={`${styles.card} ${styles.flush}`}>
                    <Cap tone="warn">
                      <span className={styles.capText}>Unmarked retired-tool claims</span>
                      <div className={styles.sp} />
                      <span className={styles.mutedMono}>7 in 3 notes</span>
                    </Cap>
                    {RETIRED.map((r) => (
                      <div key={r.path} className={styles.retiredRow}>
                        <div className={styles.retiredTop}>
                          <span className={styles.sha}>{r.path}</span>
                          <span className={styles.mutedMono}>{r.lines}</span>
                          <div className={styles.sp} />
                          <Badge status="warn">{r.unmarked} unmarked</Badge>
                        </div>
                        <div className={styles.termRow}>
                          {r.terms.map((term) => (
                            <span key={term} className={`${styles.tag} ${styles.tagAccent}`}>{term}</span>
                          ))}
                        </div>
                      </div>
                    ))}
                    <div className={styles.cardNote}>
                      A passage naming a deleted tool with no retraction marker verifies clean and reads as
                      current fact. The fix is to mark them, not to delete them.
                    </div>
                  </div>
                </div>

                <div className={styles.colHalf}>
                  <div className={`${styles.card} ${styles.flush}`}>
                    <Cap tone="warn">
                      <span className={styles.capText}>Cold verification stamps</span>
                      <div className={styles.sp} />
                      <span className={styles.mutedMono}>oldest 34 d</span>
                    </Cap>
                    {COLD.map((c) => (
                      <div key={c.path} className={styles.coldRow}>
                        <span className={styles.sha}>{c.path}</span>
                        <span className={styles.mutedMono}>verified {c.verified}</span>
                        <span className={`${styles.numMono} ${c.warm ? "" : styles.warnText}`}>{c.age}d</span>
                      </div>
                    ))}
                  </div>

                  <div className={`${styles.card} ${styles.flush}`}>
                    <Cap>
                      <span className={styles.capText}>Retracted passages</span>
                      <div className={styles.sp} />
                      <span className={styles.mutedMono}>3 shown of 27</span>
                    </Cap>
                    {QUOTES.map((q) => (
                      <div key={q.loc} className={styles.quoteRow}>
                        <div className={styles.sha}>
                          {q.loc} <span className={styles.mutedMono}>{q.heading}</span>
                        </div>
                        <div className={styles.quoteText}>{q.text}</div>
                      </div>
                    ))}
                    <div className={styles.cardNote}>
                      Still verbatim in the file, and stamped SUPERSEDED rather than VERIFIED. Verbatim is
                      exactly what a stale answer looks like.
                    </div>
                  </div>
                </div>
              </div>
            </div>
          )}

          {screen === "map" && (
            <iframe src="/map" title="Demo map — synthetic data" className={styles.mapFrame} />
          )}

          {screen === "guide" && (
            <div className={styles.screen}>
              <div className={styles.headRow}>
                <div>
                  <div className={styles.kicker}>Help</div>
                  <div className={styles.title}>Guide</div>
                </div>
              </div>
              <div className={styles.cols2}>
                <div className={styles.colHalf}>
                  <div className={styles.card}>
                    <div className={styles.statLabel}>Wire a terminal</div>
                    <p className={styles.guideText}>
                      One command, user scope. The token is the bearer{" "}
                      <span className={styles.inlineMono}>MCP_TOKEN</span>; it never appears in a URL.
                    </p>
                    <pre className={styles.pre}>{`claude mcp add --transport http cortex \\
  https://<host>/api/mcp \\
  --header "Authorization: Bearer <MCP_TOKEN>"`}</pre>
                  </div>
                  <div className={styles.card}>
                    <div className={styles.statLabel}>Wire Cursor · read + write</div>
                    <p className={styles.guideText}>
                      Same bearer door. Drop into{" "}
                      <span className={styles.inlineMono}>~/.cursor/mcp.json</span>, refresh MCP —
                      all six tools, including write. Prefer{" "}
                      <span className={styles.inlineMono}>brain_corpus</span> for reads.
                    </p>
                    <pre className={styles.pre}>{`{
  "mcpServers": {
    "cortex": {
      "url": "https://<host>/api/mcp",
      "headers": {
        "Authorization": "Bearer <MCP_TOKEN>"
      }
    }
  }
}`}</pre>
                  </div>
                  <div className={styles.card}>
                    <div className={styles.statLabel}>Wire claude.ai / ChatGPT</div>
                    <p className={styles.guideText}>
                      Header-less clients use the secret-URL alias{" "}
                      <span className={styles.inlineMono}>{"/api/s/<secret>/mcp"}</span>. Gemini CLI
                      and Codex use the same bearer URL as Cursor.
                    </p>
                  </div>
                  <div className={`${styles.card} ${styles.flush}`}>
                    <Cap><span className={styles.capText}>The rituals</span></Cap>
                    {RITUALS.map((r) => (
                      <div key={r.tag} className={styles.ritualRow}>
                        <span className={styles.ritualTag}>{r.tag}</span>
                        <span className={styles.guideText}>{r.text}</span>
                      </div>
                    ))}
                  </div>
                </div>
                <div className={styles.colHalf}>
                  <div className={`${styles.card} ${styles.flush}`}>
                    <Cap><span className={styles.capText}>The six tools</span></Cap>
                    {TOOLS.map((tl) => (
                      <div key={tl.name} className={styles.toolRow}>
                        <span>
                          <span className={styles.toolName}>{tl.name}</span>
                          <span className={styles.toolRole}>{tl.role}</span>
                        </span>
                        <span className={styles.guideText}>{tl.what}</span>
                      </div>
                    ))}
                  </div>
                  <div className={`${styles.card} ${styles.flush}`}>
                    <Cap><span className={styles.capText}>What a stamp means</span></Cap>
                    {STAMPS.map((s) => (
                      <div key={s.tag} className={styles.stampRow}>
                        <span><Badge status={s.status}>{s.tag}</Badge></span>
                        <span className={styles.guideText}>{s.line}</span>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
