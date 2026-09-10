import type { CallRow } from "@/lib/calls";
import {
  DAY, HOUR, READING_PACE, answeredFromMemory, coverageOf, fmtDur, fmtTokens, hoursCovered, isAsk, liteOf, scoredAsk, sessionsOf,
  tokensSaved, type CallLite,
} from "@/lib/trends";
import { Spark } from "./charts";
import { BusyHours, MemoryVsTyping, Patterns, Pulse, TrendsProvider, WhoAnswered, type ReaderLite } from "./trends-client";

/**
 * The Trends screen's markup, with its data handed in. page.tsx reads the log, the corpus and
 * the reader settings and renders this; scripts/dev/render-trends.tsx renders it from fixtures
 * so the layout can be looked at on both grounds without a store, a token or a deploy.
 *
 * Two windows on one log, on purpose (PRODUCT.md, stated 2026-09-01): the hourly instruments
 * keep the 48 h window they caption, but the VALUE claim — tokens the brain saved — is a
 * lifetime number. The alternative it prices is re-dropping docs and code to bring each new
 * session up to speed, and nobody re-reflects on that in 48 h slices.
 */

export interface StripCell { label: string; figure: string; meta: string; spark: number[]; sparkNote: string }

export interface TrendsVM {
  nothingYet: boolean;
  /** "48 h of log" — what the charts really cover. */
  coverage: string;
  /** The strip's lede, or the empty state's. */
  lede: string;
  tokensSavedFig: string;
  cells: StripCell[];
  rows: CallLite[];
  now: number;
  hoursN: number;
  covers: number;
  readers: ReaderLite[];
  writable: boolean;
}

export interface TrendsInput {
  now: number;
  calls48: { rows: CallRow[]; covers: number; durable: boolean; source: "store" | "unconfigured" | "unreachable" };
  life: { rows: CallRow[]; covers: number };
  corpusTokens: number;
  readers: ReaderLite[];
  writable: boolean;
}

/** Every strip figure and every honesty line, from the rows and nothing else. */
export function buildTrendsVM(input: TrendsInput): TrendsVM {
  const { now, calls48, life, corpusTokens, readers, writable } = input;
  const rows = calls48.rows;
  const covers = calls48.covers;
  const asks = rows.filter(isAsk);
  const lifeAsks = life.rows.filter(isAsk);
  const lifeDays = Math.max(1, Math.round(life.covers / DAY));
  const coverage = coverageOf(covers);
  const sourceNote = calls48.durable
    ? null
    : calls48.source === "unconfigured"
      ? "no durable store — one instance's view"
      : "store unreachable — in-memory view";
  const hoursN = hoursCovered(covers);

  // ── The strip: lifetime, est. ──────────────────────────────────────────────
  const saved = tokensSaved(lifeAsks, corpusTokens);
  const minutesSaved = saved.tokens / READING_PACE;
  // Scored = could have answered: errors, platform cut-offs and in-budget timeouts all leave
  // the denominator.
  const scored = lifeAsks.filter(scoredAsk).length;
  const memoryAnswers = lifeAsks.filter((r) => answeredFromMemory(r.stamp)).length;
  const sessions = sessionsOf(life.rows);

  // Sparklines: the same four figures across the covered hours, in up to eight equal steps.
  const steps = Math.max(2, Math.min(8, hoursN));
  const stepMs = (hoursN * HOUR) / steps;
  const stepLabel = stepMs % HOUR === 0 ? `${stepMs / HOUR} h steps` : `${Math.round(stepMs / 60_000)} min steps`;
  const sparkOf = (fn: (inB: CallRow[], asksB: CallRow[]) => number) =>
    Array.from({ length: steps }, (_, i) => {
      const from = now - (steps - i) * stepMs;
      const inB = rows.filter((r) => r.ts >= from && r.ts < from + stepMs);
      return fn(inB, inB.filter(isAsk));
    });
  const sparks = [
    sparkOf((_, a) => tokensSaved(a, corpusTokens).tokens),
    sparkOf((_, a) => tokensSaved(a, corpusTokens).tokens / READING_PACE),
    sparkOf((inB) => sessionsOf(inB)),
    sparkOf((_, a) => {
      const sc = a.filter(scoredAsk);
      return sc.length ? Math.round((sc.filter((r) => answeredFromMemory(r.stamp)).length / sc.length) * 100) : 0;
    }),
  ];
  const sparkNote = `${hoursN} h · ${stepLabel}`;
  const cells: StripCell[] = [
    {
      label: "Tokens saved",
      figure: fmtTokens(saved.tokens),
      meta: saved.measured === 0
        ? "collecting — new asks record their savings"
        : saved.unmeasured > 0
          ? `est · lifetime · ${saved.measured} asks measured · ${saved.unmeasured} early asks unmeasured`
          : `est · lifetime · ${saved.measured} asks measured`,
      spark: sparks[0], sparkNote,
    },
    {
      label: "Time saved",
      figure: saved.measured ? fmtDur(minutesSaved) : "—",
      meta: saved.measured ? `est · at ${READING_PACE} tok/min reading pace · lifetime` : "measures with tokens saved",
      spark: sparks[1], sparkNote,
    },
    { label: "Sessions", figure: String(sessions), meta: "bursts of calls, 30 min apart · lifetime", spark: sparks[2], sparkNote },
    {
      label: "From memory",
      figure: scored ? `${Math.round((memoryAnswers / scored) * 100)}%` : "—",
      meta: scored ? `of ${scored} asks · lifetime` : "no asks measured yet",
      spark: sparks[3], sparkNote,
    },
  ];

  // Every empty state on this screen was written thoughtfully in isolation, and nobody composed
  // the case where all of them are true at once — which is the MODAL state for a new install.
  // When the log can back nothing, the screen says that once and names what will fill it,
  // instead of drawing the whole apparatus empty.
  const nothingYet = rows.length === 0 || (asks.length === 0 && saved.measured === 0 && sessions === 0);
  const lede = nothingYet
    ? `${coverage}${sourceNote ? ` · ${sourceNote}` : " — longer windows unlock as the log accrues"}.`
    : `Measured over ${lifeDays} d of log — lifetime figures, est. Every ask reads memory server-side and hands back the answer alone. Charts below cover ${coverage}${sourceNote ? ` · ${sourceNote}` : "; longer windows unlock as the log accrues"}.`;

  return {
    nothingYet, coverage, lede, tokensSavedFig: fmtTokens(saved.tokens), cells,
    rows: liteOf(rows), now, hoursN, covers, readers, writable,
  };
}

export function TrendsScreen({ vm }: Readonly<{ vm: TrendsVM }>) {
  if (vm.nothingYet) {
    return (
      <div className="trRoot">
        <Strip title={<>Nothing to trend <b>yet.</b></>} lede={vm.lede} />
        <div className="trBody" data-cx="rise">
          <div className="trEmpty">
            <p className="trEmptyBody">
              This screen reads the call log, and the log is still empty in this environment. Serving is unaffected — the
              brain answers whether or not anything is being measured here.
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
            <p className="trEmptyBody">The fastest way to put something here is to ask the brain a question.</p>
            <a className="trEmptyGo" href="ask">go to ask</a>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="trRoot">
      <Strip title={<>{vm.tokensSavedFig} tokens <b>your context never paid.</b></>} lede={vm.lede} cells={vm.cells} />
      <div className="trBody">
        <TrendsProvider rows={vm.rows} now={vm.now} hoursN={vm.hoursN} covers={vm.covers} readers={vm.readers} writable={vm.writable}>
          {/* The entrances live on these static wrappers, never on the client instruments inside:
              a state change in the provider must not strip the reveal class the kinetic layer set. */}
          <div className="trSecWrap" data-cx="rise"><Pulse /></div>
          <div className="trGrid">
            <div className="trSecWrap" data-cx="rise"><MemoryVsTyping /></div>
            <div className="trSecWrap" data-cx="rise"><Patterns /></div>
            <div className="trSecWrap" data-cx="rise"><BusyHours /></div>
            <div className="trSecWrap" data-cx="rise"><WhoAnswered /></div>
          </div>
        </TrendsProvider>
      </div>
    </div>
  );
}

/** The inverted strip: the chip, the headline figure, the lede, and the four lifetime cells. */
function Strip({ title, lede, cells }: Readonly<{ title: React.ReactNode; lede: string; cells?: StripCell[] }>) {
  return (
    <div className="trInv" data-cx="rise">
      <div className="trInvInner">
        <div className="trHead">
          <div className="trHeadLeft">
            <span className="trTag" data-cx="print">
              <span className="trTagN">01</span>
              <span className="trTagLabel">Trends</span>
            </span>
            <h2 className="trTitle">{title}</h2>
          </div>
          <p className="trLede">{lede}</p>
        </div>
        {cells && (
          <div className="trStrip">
            {cells.map((c) => (
              <div key={c.label} className="trCell">
                <div className="trCellLabel">{c.label}</div>
                <div className="trCellFig">{c.figure}</div>
                <div className="trCellMeta">{c.meta}</div>
                <div className="trCellSpark">
                  <Spark vals={c.spark} />
                  <span className="trSparkNote">{c.sparkNote}</span>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
