import { Fragment, type ReactNode } from "react";
import type { NoteEdge } from "@/lib/edges";
import type { Stamp } from "@/lib/explorer";
import { num, type Connections, type HeatFacts, type NoteFacts, type RetractedLine, type ToolFacts } from "./ask-model";

/**
 * The Ask screen's lens bodies — a note, a handoff, a tool — as pure views. Everything they show
 * and every button they offer arrives as props; the client that opened the lens (ask-explorer.tsx)
 * owns the state (a pin in flight, a handoff being assembled, which edge's evidence is unfolded)
 * and publishes a fresh body whenever it moves. That is what lets scripts/dev/render-ask.tsx draw
 * a body from fixtures, and what keeps the drawer honest after router.refresh(): the body is
 * rebuilt from the heat view the tree was rebuilt from, never from the render before.
 *
 * Every string a note contributes (title, first sentence, headings, retracted text, edge
 * evidence) arrived pre-redacted from lib/health.ts and lib/edges.ts — this file displays, it
 * never scrubs, because two scrubbing opinions drift and the second one always misses.
 */

/** Strongest claim first: an explicit link outranks a correction chain outranks shared tags
 *  outranks co-reading outranks mere lexical similarity. */
export const KIND_ORDER: Array<NoteEdge["kind"]> = ["link", "correction", "tag", "coaccess", "lexical"];

/** Each weight with its unit and scope — a bare number on this console is a QC failure. */
export function weightLabel(e: NoteEdge): string {
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

/** Coarse on purpose: the exact instant rides in the title attribute. Client-only — the lens
 *  opens on a click, so it can never mismatch the server render. */
export function ago(iso: string, now = Date.now()): string {
  const s = Math.max(0, (now - Date.parse(iso)) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} d ago`;
}

export const SEAT_WORD: Record<"profile" | "recent" | "router", string> = {
  profile: "profile — served in full",
  recent: "recent day — served verbatim",
  router: "router row — path and description",
};

/** The stamp cell's long form — the same five states the explorer's legend names. */
export function stampSentence(s: Stamp, staleDays = 14): string {
  switch (s.kind) {
    case "fresh":
      return `_Facts last verified_ · ${s.days} d ago · fresh`;
    case "stale":
      return `_Facts last verified_ · ${s.days} d ago · stale — past ${staleDays} d`;
    case "settled":
      return `settled history · decays: false · verified ${s.days} d ago, and cannot go stale`;
    case "rec":
      return "a dated record — its stamp cannot go stale";
    case "none":
      return "none — the note makes no claim";
  }
}

/** The key–value ledger every body carries. A null row is simply not printed. */
export function LensKv({ rows }: Readonly<{ rows: Array<[string, ReactNode] | null> }>) {
  return (
    <dl className="askKv">
      {rows.filter((r): r is [string, ReactNode] => r !== null).map(([k, v]) => (
        <Fragment key={k}>
          <dt>{k}</dt>
          <dd>{v}</dd>
        </Fragment>
      ))}
    </dl>
  );
}

export interface PinVM {
  state: { temperature: "hot" | "warm" | "cold"; reason: string } | null;
  /** False when note_pins cannot be read or written — the trough then says why instead of
   *  rendering buttons over a store that is not there. */
  available: boolean;
  busy: boolean;
  error: string | null;
  onPin: (temperature: "hot" | "cold" | null) => void;
}

/**
 * The pin trough — the heat view's one mutation. Two moves in, one move out: pin HOT ("keep this
 * in the seat") and pin COLD ("this looks busy, it is noise") are the two judgements the
 * temperature migration names; unpinning restores the computed temperature exactly.
 */
function PinTrough({ pin }: Readonly<{ pin: PinVM }>) {
  return (
    <div className="askPinRow" aria-busy={pin.busy}>
      <span className="askLbl askLblSm">Pin</span>
      {!pin.available ? (
        <span className="askPinState">unavailable — note_pins could not be reached, so nothing can be pinned or unpinned from here</span>
      ) : pin.state ? (
        <>
          <span className={`askPinState askPin-${pin.state.temperature}`}>
            pinned {pin.state.temperature}
            {pin.state.reason ? ` — “${pin.state.reason}”` : ""}
          </span>
          <button type="button" className="askBtn askBtnSm" disabled={pin.busy} onClick={() => pin.onPin(null)}>Unpin</button>
          <span className="askLensNote">unpinning restores the computed temperature exactly</span>
        </>
      ) : (
        <>
          <button type="button" className="askBtn askBtnSm" disabled={pin.busy} onClick={() => pin.onPin("hot")}>Pin hot</button>
          <button type="button" className="askBtn askBtnSm" disabled={pin.busy} onClick={() => pin.onPin("cold")}>Pin cold</button>
          <span className="askLensNote">a pin outranks the computed score until removed — hot keeps it in the seat and rides handoff bundles cited “pinned”; cold keeps it out</span>
        </>
      )}
      {pin.error && <span className="askLensNote askErr">{pin.error}</span>}
    </div>
  );
}

export interface InAnswer {
  rank: number;
  score: number | null;
  terms: string[];
  /** The cited line when this note is the one the answer quoted. */
  citedLine: number | null;
}

/** L1 — a note: its facts, the pin trough, its place in the last answer, outline, retracted passages, connections. */
export function NoteLensBody({ note, heat, sha, stamp, scoring, retracted, connections, evidenceOpen, onEvidence, onOpenNote, inAnswer, citedHeading, pin, repoUrl, onAsk, onHandoff, now }: Readonly<{
  note: NoteFacts;
  heat: HeatFacts | null;
  sha: string;
  stamp: Stamp;
  scoring: "scored" | "off" | "unavailable" | "empty";
  retracted: RetractedLine[];
  connections: Connections | null;
  /** Which edge's evidence is unfolded, keyed kind|other. One at a time: evidence is a glance. */
  evidenceOpen: string | null;
  onEvidence: (key: string | null) => void;
  onOpenNote: (path: string) => void;
  inAnswer: InAnswer | null;
  /** The heading the last answer's quote sat under, lit in the outline. */
  citedHeading: string | null;
  pin: PinVM;
  repoUrl: string | null;
  onAsk: () => void;
  /** projects/ only — staging is a lens kind of its own. */
  onHandoff: (() => void) | null;
  now?: number;
}>) {
  const sha8 = sha.slice(0, 8);
  const temperature = (() => {
    if (scoring === "off") return "unscored — scoring off on this deploy (no SUPABASE_URL)";
    if (scoring === "unavailable") return "unknown this render — note_scores did not answer";
    if (scoring === "empty") return "unscored — no scored rows yet; the first sync fills it";
    if (!heat || !heat.temperature) return "unscored";
    const reads = `${heat.reads} read${heat.reads === 1 ? "" : "s"} all-time`;
    const last = heat.lastRead ? `read ${ago(heat.lastRead, now)}` : "never read";
    return `${heat.temperature}${heat.score != null ? ` · score ${heat.score.toFixed(2)}` : ""} · ${reads} · ${last}`;
  })();
  const seat = heat?.seat ? SEAT_WORD[heat.seat] : "not loaded at boot — one call away";
  const edges = connections?.state === "built" ? connections.byNote[note.path] ?? [] : [];
  const github = repoUrl ? `${repoUrl}/blob/${sha}/${note.path}` : null;
  return (
    <>
      <div className="askLensId">{note.path}</div>
      {note.desc && <p className="askLensDesc">{note.desc}</p>}
      <LensKv rows={[
        ["size", `~${num(note.tokens)} estimated body tokens · ${note.blocks} block${note.blocks === 1 ? "" : "s"}`],
        ["retracted", note.retracted ? `${note.retracted} passage${note.retracted === 1 ? "" : "s"} crossed out, kept on the page` : "none"],
        ["stamp", stampSentence(stamp)],
        ["temperature", temperature],
        ["seat", seat],
        ["head", sha],
      ]} />

      <PinTrough pin={pin} />

      {inAnswer && (
        <div className="askLensBlock">
          <div className="askLensLabel">In the last answer</div>
          <div className="askLensLine">
            rank {inAnswer.rank}
            {inAnswer.score != null && ` · bm25 ${inAnswer.score.toFixed(1)}`}
            {inAnswer.terms.length > 0 && ` · matched ${inAnswer.terms.join(" · ")}`}
            {inAnswer.citedLine != null && <> · <b className="askAccentFg">cited at :{inAnswer.citedLine}</b></>}
          </div>
        </div>
      )}

      {note.headings.length > 0 && (
        <div className="askLensBlock">
          <div className="askLensLabel">Outline · {note.headings.length} heading{note.headings.length === 1 ? "" : "s"}</div>
          {note.headings.map((h) => (
            <div key={`${h.line}`} className={`askOutlineRow${citedHeading && h.h === citedHeading ? " askOutlineHit" : ""}`}>
              <span className="askFig">{h.line}</span>
              <span>{h.h}</span>
            </div>
          ))}
        </div>
      )}

      {retracted.length > 0 && (
        <div className="askLensBlock">
          <div className="askLensLabel">Retracted · {note.retracted} passage{note.retracted === 1 ? "" : "s"} · kept on the page</div>
          {retracted.map((r) => (
            <div key={r.line} className="askDeadRow">
              <span className="askFig">{r.line}</span>
              <span>{r.text}</span>
            </div>
          ))}
          {note.retracted > retracted.length && <div className="askLensNote">{retracted.length} of {note.retracted} shown — the rest are on the page</div>}
          <div className="askLensNote">a quote from here is stamped SUPERSEDED, never silently trusted</div>
        </div>
      )}

      {connections && (
        <div className="askLensBlock">
          <div className="askLensLabel" title={connections.state === "built" ? connections.builtAt : undefined}>
            Connections
            {connections.state === "built" && ` · edges at ${connections.head} · rebuilt ${ago(connections.builtAt, now)} · top 5 per kind by weight`}
          </div>
          {connections.state === "missing" && <div className="askLensNote">no connections built — migration pending, run scripts/migrate.ts --apply</div>}
          {connections.state === "empty" && <div className="askLensNote">no connections built yet — the next brain write triggers the first build, or run scripts/build-edges.ts</div>}
          {connections.state === "unavailable" && <div className="askLensNote">connections unavailable — the graph store did not answer, so this panel is dark; the graph itself is untouched. Reload to retry.</div>}
          {connections.state === "built" && edges.length === 0 && (
            <div className="askLensNote">no edges reach this note at {connections.head} — it shares no links, tags, markers, co-reads or top-5 lexical neighbours</div>
          )}
          {connections.state === "built" &&
            KIND_ORDER.filter((k) => edges.some((e) => e.kind === k)).map((kind) =>
              edges.filter((e) => e.kind === kind).map((e) => {
                const key = `${e.kind}|${e.other}`;
                const open = evidenceOpen === key;
                return (
                  <Fragment key={key}>
                    <button type="button" className="askEdgeRow" aria-expanded={open} onClick={() => onEvidence(open ? null : key)}>
                      <span className="askEdgeKind">{e.kind}</span>
                      <span className="askEdgeDir" aria-hidden>{e.dir === "out" ? "→" : e.dir === "in" ? "←" : "↔"}</span>
                      <span className="askEdgeOther">{e.other}</span>
                      <span className="askEdgeW">{weightLabel(e)}</span>
                    </button>
                    {open && (
                      <div className="askEdgeEvi">
                        <span>{e.evidence}</span>
                        <div className="askActions">
                          <button type="button" className="askBtn askBtnSm" onClick={() => onOpenNote(e.other)}>Open {e.other}</button>
                        </div>
                      </div>
                    )}
                  </Fragment>
                );
              })
            )}
        </div>
      )}

      <div className="askActions">
        <button type="button" className="askBtn askBtnPrimary" onClick={onAsk}>Ask about it</button>
        {onHandoff && <button type="button" className="askBtn" onClick={onHandoff}>Open working context</button>}
        {github && <a className="askBtn" href={github} target="_blank" rel="noopener">Open on GitHub at {sha8}</a>}
      </div>
      <div className="askLensNote">the lens is the glance; the answer is the proof · opening a note here reads nothing into the access log</div>
    </>
  );
}

/** L3 — a tool from the roster, reached from the ALSO strip. */
export function ToolLensBody({ tool, onAsk }: Readonly<{ tool: ToolFacts; onAsk: () => void }>) {
  return (
    <>
      <div className="askLensId">{tool.name} · {tool.doors}</div>
      <p className="askLensDesc">{tool.what}</p>
      <LensKv rows={[
        ["trusted door", tool.trusted ? "registered" : "not registered — not in its tools/list"],
        ["guest door", tool.guest ? "registered" : "not registered — not in its tools/list"],
        ["calls · 30 d", tool.calls === null ? "this instance's count only — no durable call store" : tool.calls === 0 ? "none here — never called from this environment, not unavailable" : num(tool.calls)],
      ]} />
      <div className="askActions">
        <button type="button" className="askBtn askBtnPrimary" onClick={onAsk}>Ask about it</button>
        <a className="askBtn" href="settings">Open settings</a>
      </div>
      <div className="askLensNote">a guest sees a smaller toolset, not a refused one — nothing else is registered on that handler, so nothing else appears in its tools/list</div>
    </>
  );
}
