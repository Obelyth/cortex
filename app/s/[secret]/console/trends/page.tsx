import { requireSecret } from "@/lib/gate";
import { Fragment } from "react";
import { readCalls } from "@/lib/calls";
import { consoleHealth } from "../loaders";
import { MemoryChart, type ChartBucket } from "./memory-chart";
import { Band } from "../band";
import styles from "../console.module.css";

export const dynamic = "force-dynamic";
export const maxDuration = 60;
export const metadata = { title: "Trends · Cortex console" };

/**
 * Trends — the design file's five panels, fed by the call log and captioned with the window
 * the log really covers. The stat strip's token figure is the memory read FOR each ask,
 * server-side (derived from the per-row measurement recorded since 2026-08-05, est against
 * today's corpus size) — what a session would have hauled in by hand without the brain, not
 * the cost of never reading the whole corpus, which nobody pays; time saved is the one
 * derived number and says so. Patterns only render when their premise holds in the data —
 * a pattern the log cannot attest is not shown dimmed, it is not shown at all.
 */

// Field family + inert grey only — in the paper theme --accent/--warn/--ok all collapse onto
// ink-900, which had three of these five rendering as the same near-black.
const SHARE_COLORS = ["var(--field-live)", "var(--field-warn)", "var(--field-ok)", "var(--field-crit)", "var(--ink-400)"];

/** Memory answered = the brain had it: everything except an explicit miss or an error. */
const answeredFromMemory = (stamp: string) => stamp !== "NOT IN BRAIN" && stamp !== "ERROR";

function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 10_000) return `${Math.round(n / 1000)}k`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}

function fmtDuration(mins: number): string {
  if (mins < 1) return "under a min";
  if (mins < 60) return `${Math.round(mins)}m`;
  return `${Math.floor(mins / 60)}h ${String(Math.round(mins % 60)).padStart(2, "0")}m`;
}

export default async function Trends({
  params,
}: {
  params: Promise<{ secret: string }>;
}) {
  await requireSecret(params);

  const now = Date.now();
  // Two windows on one log, on purpose (PRODUCT.md, stated 2026-09-01): the hourly charts keep
  // the 48 h window they caption, but the VALUE claim — tokens the brain saved — is a lifetime
  // number. The alternative it prices is re-dropping docs and code to bring each new session up
  // to speed, and nobody re-reflects on that in 48 h slices; they look back after six months.
  const [{ rows, covers, durable, source }, life, h] = await Promise.all([
    readCalls(172_800_000, now),
    readCalls(157_680_000_000, now),
    consoleHealth(),
  ]);
  const asks = rows.filter((r) => r.tool === "brain_ask");
  const lifeAsks = life.rows.filter((r) => r.tool === "brain_ask");
  const lifeDays = Math.max(1, Math.round(life.covers / 86_400_000));
  const coverage =
    covers < 60_000
      ? "log just started"
      : covers < 3_600_000
        ? `${Math.round(covers / 60_000)} min of log`
        : `${Math.round(covers / 3_600_000)} hr of log`;
  const windowNote = durable
    ? `${coverage} — longer windows unlock as the log accrues`
    : source === "unconfigured"
      ? "no durable store — one instance's view"
      : "store unreachable — in-memory view";

  // ── Stat strip ──────────────────────────────────────────────────────────────
  const withSaved = lifeAsks.filter((r) => typeof r.saved === "number");
  // The row records corpus-at-ask minus what narrowing sent — a savings against reading the
  // whole brain, which is a counterfactual nobody pays (design review, 2026-09-01: not a saving
  // typical usage would feel). The figure a person can feel is the other side of the subtraction: the
  // memory that was read FOR the session, server-side, so only the answer entered their
  // context. Without the brain, that material is what they would have hauled in by hand.
  // Estimated against today's corpus size (the row carries no historical size) and labeled est.
  const corpusTokens = h.totals.tokens;
  const tokensServed = withSaved.reduce(
    (a, r) => a + Math.max(0, Math.min(corpusTokens, corpusTokens - (r.saved ?? 0))),
    0
  );
  const unmeasured = lifeAsks.length - withSaved.length;
  // Reading pace ~330 tokens/min — the one derived figure on the strip, labeled est.
  const minutesSaved = tokensServed / 330;
  const memoryAnswers = lifeAsks.filter((r) => answeredFromMemory(r.stamp)).length;
  const scored = lifeAsks.filter((r) => r.stamp !== "ERROR").length;
  const memoryPct = scored ? Math.round((memoryAnswers / scored) * 100) : null;
  // A session = a burst of calls with under 30 quiet minutes inside it.
  const sessions = [...life.rows]
    .sort((a, b) => a.ts - b.ts)
    .reduce((n, r, i, all) => (i === 0 || r.ts - all[i - 1].ts > 1_800_000 ? n + 1 : n), 0);

  // ── Memory vs typing, bucketed across the window ────────────────────────────
  const hoursN = Math.max(1, Math.min(48, Math.ceil(covers / 3_600_000)));
  const bucketCount = Math.max(2, Math.min(8, hoursN));
  const bucketMs = (hoursN * 3_600_000) / bucketCount;
  const buckets: ChartBucket[] = Array.from({ length: bucketCount }, (_, i) => {
    const from = now - (bucketCount - i) * bucketMs;
    const inB = asks.filter((r) => r.ts >= from && r.ts < from + bucketMs);
    const hoursAgo = Math.round(((bucketCount - i) * bucketMs) / 3_600_000);
    return {
      label: i === bucketCount - 1 ? "now" : `-${hoursAgo}h`,
      memory: inB.filter((r) => answeredFromMemory(r.stamp)).length,
      fresh: inB.filter((r) => r.stamp === "NOT IN BRAIN").length,
    };
  });

  // ── Patterns — only claims the window can back ──────────────────────────────
  const patterns: Array<{ up: boolean; pop: boolean; title: string; sub: string; chip: string }> = [];
  const heat: number[][] = Array.from({ length: 6 }, () => Array(7).fill(0));
  for (const r of rows) {
    const d = new Date(r.ts);
    heat[Math.floor(d.getHours() / 4)][(d.getDay() + 6) % 7]++;
  }
  const heatMax = Math.max(...heat.flat());
  if (heatMax >= 3) {
    let hb = 0, hd = 0;
    heat.forEach((band, b) => band.forEach((v, d2) => { if (v > heat[hb][hd]) { hb = b; hd = d2; } }));
    const DAYS_FULL = ["Mondays", "Tuesdays", "Wednesdays", "Thursdays", "Fridays", "Saturdays", "Sundays"];
    patterns.push({
      up: true, pop: false,
      title: `${DAYS_FULL[hd]} run hot`,
      sub: `${heat[hb][hd]} calls between ${hb * 4}:00 and ${hb * 4 + 4}:00`,
      chip: "peak",
    });
  }
  if (asks.length >= 8 && covers >= 7_200_000) {
    const half = now - covers / 2;
    const early = asks.filter((r) => r.ts < half);
    const late = asks.filter((r) => r.ts >= half);
    const rate = (xs: typeof asks) => {
      const s = xs.filter((r) => r.stamp !== "ERROR");
      return s.length ? s.filter((r) => r.stamp === "NOT IN BRAIN").length / s.length : null;
    };
    const re = rate(early), rl = rate(late);
    if (re !== null && rl !== null && re > 0) {
      const delta = Math.round(((rl - re) / re) * 100);
      if (Math.abs(delta) >= 15) {
        patterns.push({
          up: delta < 0, pop: true,
          title: delta < 0 ? "Re-explaining is fading" : "More questions the brain lacks",
          sub: `not-in-memory rate ${delta < 0 ? "fell" : "rose"} across the window`,
          chip: `${delta > 0 ? "+" : ""}${delta}%`,
        });
      }
    }
  }
  const verified = asks.filter((r) => r.stamp === "VERIFIED" || r.stamp === "CORRECTED").length;
  if (verified > 0) {
    patterns.push({
      up: true, pop: false,
      title: "Answers proving right",
      sub: `${verified} of ${asks.length} asks came back proven against the notes`,
      chip: `${Math.round((verified / asks.length) * 100)}%`,
    });
  }
  const guestCalls = rows.filter((r) => r.surface === "guest").length;
  if (guestCalls > 0) {
    patterns.push({
      up: true, pop: true,
      title: "Guests are using the door",
      sub: `${guestCalls} guest calls in the window`,
      chip: `${guestCalls}×`,
    });
  }

  // ── Who answered ────────────────────────────────────────────────────────────
  const attributed = asks.filter((r) => r.model);
  const byModel = [...new Set(attributed.map((r) => r.model as string))]
    .map((m) => ({ model: m, n: attributed.filter((r) => r.model === m).length }))
    .sort((a, b) => b.n - a.n)
    .map((b, i) => ({ ...b, color: SHARE_COLORS[i % SHARE_COLORS.length] }));
  const totalAttr = Math.max(1, attributed.length);

  const DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
  const BANDS = ["12am", "4am", "8am", "12pm", "4pm", "8pm"];

  // Every empty state on this screen was written thoughtfully in isolation, and nobody composed
  // the case where all of them are true at once — which is the MODAL state for a new install and
  // was true on the author's own populated deployment. Six empty instruments plus an 84-cell heat
  // grid drawn in full, with a less/more legend teaching a scale for values that do not exist,
  // does not read as "collecting"; it reads as broken. When the log can back nothing, the screen
  // says that once and names what will fill it, instead of drawing the whole apparatus empty.
  const nothingYet = rows.length === 0 || (asks.length === 0 && withSaved.length === 0 && sessions === 0);

  if (nothingYet) {
    return (
      <div className="ovSheet">
        <Band
          n="01"
          label="Trends"
          tone="grey"
          title={<>{coverage[0].toUpperCase() + coverage.slice(1)}<b>.</b></>}
          lede={windowNote}
        >
          <div className="trEmpty">
            <p className="trEmptyLead">Nothing to trend yet.</p>
            <p className="trEmptyBody">
              This screen reads the call log, and the log is still empty in this environment.
              Serving is unaffected — the brain answers whether or not anything is being measured
              here.
            </p>
            <div className="trEmptyList">
              <div className="trEmptyRow">
                <span className="trEmptyWhat">tokens &amp; time saved</span>
                <span className="trEmptyWhen">after the first ask — every ask records what narrowing avoided hauling</span>
              </div>
              <div className="trEmptyRow">
                <span className="trEmptyWhat">memory vs typing</span>
                <span className="trEmptyWhen">after the first ask carries a stamp</span>
              </div>
              <div className="trEmptyRow">
                <span className="trEmptyWhat">sessions &amp; busy hours</span>
                <span className="trEmptyWhen">once the log covers a few days — bursts need a shape to be bursts</span>
              </div>
              <div className="trEmptyRow">
                <span className="trEmptyWhat">patterns</span>
                <span className="trEmptyWhen">once there is enough log to back a claim, and not before</span>
              </div>
            </div>
            <p className="trEmptyBody">
              The fastest way to put something here is to ask the brain a question.
            </p>
            <a className="ovInboxLink trEmptyGo" href="ask">
              go to ask
            </a>
          </div>
        </Band>
      </div>
    );
  }

  return (
    <div className="ovSheet">
      <Band
        n="01"
        label="Trends"
        tone="ink"
        grid
        title={<>{fmtTokens(tokensServed)} tokens <b>your context never paid.</b></>}
        lede={`Measured over ${lifeDays} day${lifeDays === 1 ? "" : "s"} of log — the lifetime figure, est. Every ask reads memory server-side and hands back the answer alone; without the brain, that material rides into each new session by hand. Charts below cover the ${windowNote}.`}
      >
      <section className="statStrip">
        <div className="statCell">
          <div className="heroLabel">Tokens saved</div>
          <div className="statFig">
            <span className="heroN heroNstat">{fmtTokens(tokensServed)}</span>
            {withSaved.length > 0 && <span className="statDelta">{withSaved.length} asks</span>}
          </div>
          <div className="heroCap">
            {withSaved.length === 0
              ? "collecting — new asks record their savings"
              : unmeasured > 0
                ? `est · lifetime · ${unmeasured} early asks unmeasured`
                : "est · lifetime · memory read for you, server-side"}
          </div>
        </div>
        <div className="statCell">
          <div className="heroLabel">Time saved</div>
          <div className="statFig">
            <span className="heroN heroNstat">{withSaved.length === 0 ? "—" : fmtDuration(minutesSaved)}</span>
          </div>
          <div className="heroCap">
            {withSaved.length === 0 ? "measures with tokens saved" : "est · at reading pace · lifetime"}
          </div>
        </div>
        <div className="statCell">
          <div className="heroLabel">Sessions</div>
          <div className="statFig"><span className="heroN heroNstat">{sessions}</span></div>
          <div className="heroCap">bursts of calls, 30 min apart · lifetime</div>
        </div>
        <div className="statCell">
          <div className="heroLabel">From memory</div>
          <div className="statFig"><span className="heroN heroNstat">{memoryPct === null ? "—" : `${memoryPct}%`}</span></div>
          <div className="heroCap">{scored ? `of ${scored} asks · lifetime` : "no asks measured yet"}</div>
        </div>
      </section>

      </Band>

      <div className="ovGrid trGrid">
        <div className="ovCol">
          <section className="card">
            <div className={styles.sectionHead}>
              <span className={styles.label}>
                Answers · memory vs typing <span className="labelNote">{coverage}</span>
              </span>
              <span className="swatches">
                <span className="swatch"><i style={{ background: "var(--accent)" }} />from memory</span>
                <span className="swatch"><i className="swatchDash" />not in memory</span>
              </span>
            </div>
            {asks.length === 0
              ? <div className={styles.empty}>No asks in the window yet.</div>
              : <MemoryChart buckets={buckets} />}
          </section>

          <section className="card">
            <div className={styles.sectionHead}>
              <span className={styles.label}>Patterns</span>
              <span className={styles.note}>read from {coverage}</span>
            </div>
            {patterns.map((p) => (
              <div key={p.title} className="patRow">
                <svg width="14" height="14" viewBox="0 0 14 14" className="patArrow"
                  style={{ transform: p.up ? "none" : "rotate(90deg)", color: p.pop ? "var(--field-warn)" : "var(--accent)" }}>
                  <path d="M2 12 L12 2 M5 2 H12 V9" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
                <span className="patBody">
                  <span className="patTitle">{p.title}</span>
                  <span className="patSub">{p.sub}</span>
                </span>
                <span className={`patChip${p.pop ? " patChipPop" : ""}`}>{p.chip}</span>
              </div>
            ))}
            {patterns.length === 0 && (
              <div className={styles.empty}>No patterns the log can back yet — they appear as calls accrue.</div>
            )}
          </section>
        </div>

        <div className="ovCol">
          <section className="card">
            <div className={styles.sectionHead}>
              <span className={styles.label}>Busy hours</span>
              <span className={styles.note}>{covers < 604_800_000 ? "a sketch until a week accrues" : "full week"}</span>
            </div>
            <div className="heatWrap">
              <span />
              {DAYS.map((d) => <span key={d} className="heatDay">{d}</span>)}
              {heat.map((band, b) => (
                <Fragment key={BANDS[b]}>
                  <span className="heatBand">{BANDS[b]}</span>
                  {band.map((v, d2) => (
                    <span
                      key={`${b}-${DAYS[d2]}`}
                      className="heatCell2"
                      title={`${DAYS[d2]} ${BANDS[b]} · ${v} calls`}
                      style={{
                        background: v === 0
                          ? "var(--sunk)"
                          : v === heatMax
                            ? "var(--field-warn)"
                            : `color-mix(in oklab, var(--accent) ${Math.round(24 + (v / heatMax) * 56)}%, var(--sunk))`,
                      }}
                    />
                  ))}
                </Fragment>
              ))}
            </div>
            <div className="heatKey">
              <span>less</span>
              <i style={{ background: "var(--sunk)" }} />
              <i style={{ background: "color-mix(in oklab, var(--accent) 24%, var(--sunk))" }} />
              <i style={{ background: "color-mix(in oklab, var(--accent) 55%, var(--sunk))" }} />
              <i style={{ background: "var(--accent)" }} />
              <i style={{ background: "var(--field-warn)" }} />
              <span>more</span>
            </div>
          </section>

          <section className="card">
            <div className={styles.sectionHead}>
              <span className={styles.label}>Who answered</span>
              <a className="softLink" href="settings">models</a>
            </div>
            {byModel.length === 0 && <div className={styles.empty}>no attributed asks in the window</div>}
            {byModel.length > 0 && (
              <div className="shareBar">
                {byModel.map((b) => (
                  <i key={b.model} style={{ flexBasis: `${(b.n / totalAttr) * 100}%`, background: b.color }} />
                ))}
              </div>
            )}
            {byModel.map((b) => (
              <a key={b.model} className="shareRow" href="settings">
                <i style={{ background: b.color }} />
                <span className="shareName">{b.model}</span>
                <span className={styles.note}>{b.n} asks</span>
                <span className="sharePct">{Math.round((b.n / totalAttr) * 100)}%</span>
              </a>
            ))}
          </section>
        </div>
      </div>
    </div>
  );
}
