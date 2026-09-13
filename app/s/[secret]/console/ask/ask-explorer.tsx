"use client";
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { historyPageName, isLogPath, monthKey } from "@/lib/digest";
import { buildExplorer, findAlso, isFinding, stampOf, type Explorer, type ExplorerGroup, type ExplorerRow, type ExplorerSort, type Mark, type Stamp } from "@/lib/explorer";
import { useLens, type LensContent } from "../lens";
import { consoleRoot } from "../use-reader-save";
import { consoleRoutePath } from "../route-path";
import { normaliseProject } from "@/lib/project";
import { NoteLensBody, ToolLensBody, type InAnswer, type PinVM } from "./ask-lens";
import { num, tok, type AskAnswer, type AskModel, type CutBy, type HeatFacts, type NoteFacts } from "./ask-model";

/**
 * The explorer, the ask and what it read — one client, three views (v2).
 *
 * The input governs both columns: from the second character it FINDS — a local filter over the
 * tree, the ops units and the tool roster, no server call — and on Enter it ASKS: one POST to
 * ask/run, one model call. The filter releases on Enter (a question sentence rarely matches a
 * path, and a blank tree under every answer would be no explorer at all); the READ / CITED / CUT
 * marks then take over as the tree's relation to the input, and Escape clears both.
 *
 * Nothing on the screen is a figure you cannot open: every count is a group, every path is a
 * lens, every note the reader touched is a row you can click. The stamp arrives decided by the
 * server — this component styles it and never re-derives it; a client that could talk itself
 * into VERIFIED would defeat the entire point.
 *
 * THE LENS SHOWS WHAT THE TREE SHOWS. The drawer holds a snapshot, so this component publishes
 * a fresh body whenever the answer, a pin, a handoff or an unfolded edge moves; the row it marks
 * is derived from the target it published, never from a second notion of "selected".
 */

const SORTS: ExplorerSort[] = ["name", "heat", "size", "stamp"];
const STALE_DAYS = 14;
type LensTarget = { kind: "note"; path: string } | { kind: "tool"; name: string };
type PinState = { temperature: "hot" | "warm" | "cold"; reason: string } | null;

/** The POST handler lives at ask/run because a segment cannot hold both a page and a route
 *  handler. Built from the address bar, like every console write: the browser supplies the
 *  secret, so it never appears in markup. */
function runUrl(): string {
  let p = window.location.pathname;
  while (p.endsWith("/")) p = p.slice(0, -1);
  if (!p.endsWith("/ask")) p = `${p}/ask`;
  return `${p}/run`;
}

/** The heat routes sit beside this page's segment, so a bare relative fetch does resolve to them
 *  from /…/console/ask — verified, not assumed. It stops resolving the moment a trailing slash
 *  appears, though, and that is one config flag away (Next's trailingSlash defaults to false).
 *  consoleRoot() is the derivation the reader controls already share; a third one here would be
 *  the drift the shared hook was written to end. */
function heatUrl(leaf: "pin" | "handoff"): string {
  return `${consoleRoot(window.location.pathname)}/heat/${leaf}`;
}

const rowId = (path: string) => `askRow:${path}`;

/** The group keys a note sits under, so opening it can unfold them: its directory, its month
 *  for a day-log, its source page for a history part. */
function ancestorsOf(path: string): string[] {
  const dir = path.includes("/") ? path.split("/")[0] : "root";
  const keys = [dir];
  const m = monthKey(path);
  if (dir === "log" && m) keys.push(m);
  const p = historyPageName(path);
  if (dir === "history" && p) keys.push(`history/${p}`);
  return keys;
}

/** The stamp's field colour. VERIFIED and NOT IN BRAIN are both successes on their own terms —
 *  abstaining correctly is the behaviour this product is proudest of, so it is not painted as a
 *  failure. UNVERIFIED is the only one that means "do not trust this". */
function verdictTone(stamp: string): string {
  const s = stamp.toUpperCase();
  if (s.startsWith("VERIFIED") || s.startsWith("CORRECTED")) return "askVerdictOk";
  if (s.startsWith("NOT IN BRAIN")) return "askVerdictAbstain";
  if (s.startsWith("UNVERIFIED")) return "askVerdictBad";
  return "askVerdictWarn";
}

/** Why a scored candidate did not make the pack, in the cap's own words. */
function cutWord(by: CutBy, n: AskAnswer["narrowing"]): string {
  switch (by) {
    case "log-cap":
      return n.maxLogs === 1 ? "a second day-log — the pack takes 1" : `one day-log too many — the pack takes ${n.maxLogs}`;
    case "parts-cap":
      return `a further part of one source page — the pack takes ${n.maxPartsPerPage}`;
    case "budget":
      return `over the ${Math.round(n.budgetBytes / 1000)} KB budget — the pack was full`;
    case "k":
      return `ranked below k=${n.k}`;
  }
}

/** The cap a packed note rode in under, when one applied to it. */
function partNote(path: string, index: number, shortlist: AskAnswer["shortlist"], n: AskAnswer["narrowing"]): string | null {
  if (isLogPath(path) && n.maxLogs != null) return n.maxLogs === 1 ? "the one day-log a pack may carry" : `one of the ${n.maxLogs} day-logs a pack may carry`;
  const page = historyPageName(path);
  if (page && n.maxPartsPerPage != null) {
    const i = shortlist.slice(0, index + 1).filter((s) => historyPageName(s.path) === page).length;
    return `part ${i} of ${n.maxPartsPerPage} allowed for this page`;
  }
  return null;
}

/** The narrowing named, for the WHAT IT READ header and the busy steps. */
function narrowingLine(n: { mode?: string; k: number; maxLogs: number | null; maxPartsPerPage: number | null; budgetBytes: number }): string {
  if (n.mode === "full") return `the whole corpus · ${Math.round(n.budgetBytes / 1000)} KB budget · no ranking`;
  const caps = [`k=${n.k}`, n.maxLogs != null ? `${n.maxLogs} day-log` : null, n.maxPartsPerPage != null ? `${n.maxPartsPerPage} parts per page` : null, `${Math.round(n.budgetBytes / 1000)} KB budget`].filter(Boolean);
  return `${n.mode === "fallback" ? "nothing scored — the largest notes went to the caps" : "bm25 over full text"} · ${caps.join(" · ")}`;
}

const utcHm = (ms: number) => `${new Date(ms).toISOString().slice(11, 16)} utc`;

/* ── The state, shared by the band, the tree and the readout ─────────────────────────────── */

interface AskState {
  m: AskModel;
  q: string;
  setQ: (v: string) => void;
  clear: () => void;
  finding: boolean;
  also: ReturnType<typeof findAlso>;
  submit: () => void;
  busy: boolean;
  error: string | null;
  answer: AskAnswer | null;
  /** The question the answer answered — the input may have moved on since. */
  asked: string;
  askedAt: number | null;
  sort: ExplorerSort;
  setSort: (s: ExplorerSort) => void;
  tree: Explorer;
  isOpen: (g: ExplorerGroup) => boolean;
  toggle: (g: ExplorerGroup) => void;
  target: LensTarget | null;
  /** A ?note= path the corpus does not hold, so the screen can name the mode. */
  missing: string | null;
  openNote: (path: string, block?: ScrollLogicalPosition) => void;
  openTool: (name: string) => void;
  lit: string | null;
  setLit: (path: string | null) => void;
  inputRef: React.RefObject<HTMLInputElement | null>;
  noteBy: Map<string, NoteFacts>;
  spent: number;
  openWorkingContext: (project?: string) => void;
}

const AskCtx = createContext<AskState | null>(null);
function useAsk(): AskState {
  const c = useContext(AskCtx);
  if (!c) throw new Error("useAsk must be used inside AskProvider");
  return c;
}

export function AskProvider({ model: m, fixtureAnswer = null, children }: Readonly<{ model: AskModel; fixtureAnswer?: AskAnswer | null; children: ReactNode }>) {
  const lens = useLens();
  const router = useRouter();
  const inputRef = useRef<HTMLInputElement>(null);
  const leavingAsk = useRef(false);
  // ?q= prefills a question and never auto-submits — a link that bills on arrival is a link
  // nobody can share. A prefilled question does not filter the tree either; ?find= does.
  const [q, setQState] = useState(m.initial.q ?? m.initial.find ?? "");
  const [released, setReleased] = useState(Boolean(m.initial.q));
  const [sort, setSort] = useState<ExplorerSort>(m.initial.sort ?? "name");
  const [folds, setFolds] = useState<Record<string, boolean>>({});
  const [answer, setAnswer] = useState<AskAnswer | null>(fixtureAnswer);
  const [asked, setAsked] = useState(fixtureAnswer ? m.initial.q ?? "" : "");
  const [askedAt, setAskedAt] = useState<number | null>(fixtureAnswer ? Date.UTC(2026, 8, 5, 14, 2) : null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [target, setTarget] = useState<LensTarget | null>(null);
  const [lit, setLit] = useState<string | null>(null);
  const [pinOverride, setPinOverride] = useState<Record<string, PinState>>({});
  const [pinBusy, setPinBusy] = useState<string | null>(null);
  const [pinErr, setPinErr] = useState<string | null>(null);
  const [missing, setMissing] = useState<string | null>(null);
  const [evidenceOpen, setEvidenceOpen] = useState<string | null>(null);
  const [now] = useState(() => new Date());

  const noteBy = useMemo(() => new Map(m.notes.map((n) => [n.path, n])), [m.notes]);
  // The heat view with the pins this session placed laid over it, until router.refresh() brings
  // the recomputed one — so a pin reads the same on the row and in the lens the moment it lands.
  const heat = useMemo<HeatFacts[]>(
    () => m.heat.map((h) => (h.path in pinOverride ? { ...h, pinned: pinOverride[h.path]?.temperature ?? null, pinReason: pinOverride[h.path]?.reason ?? "" } : h)),
    [m.heat, pinOverride]
  );
  const heatBy = useMemo(() => new Map(heat.map((h) => [h.path, h])), [heat]);
  const finding = !released && isFinding(q);

  // The last answer's marks: every note in the pack is READ (by rank), the one it quoted is
  // CITED, every scored candidate a cap refused is CUT. A citation from outside the pack marks
  // nothing — the readout says the absence out loud instead.
  const marks = useMemo(() => {
    const out: Record<string, Mark> = {};
    if (!answer) return out;
    const cited = answer.citation && !answer.citedOutsidePack ? answer.citation.path : null;
    for (const s of answer.shortlist) out[s.path] = s.path === cited ? { kind: "cited", rank: s.rank } : { kind: "read", rank: s.rank };
    for (const c of answer.cut) if (!out[c.path]) out[c.path] = { kind: "cut", by: cutWord(c.by, answer.narrowing) };
    return out;
  }, [answer]);

  const revealPath = target?.kind === "note" ? target.path : m.initial.note;
  const tree = useMemo(
    () => buildExplorer(m.notes, heat, m.skipped, { sort, find: finding ? q : "", marks, reveal: revealPath, now, staleDays: STALE_DAYS }),
    [m.notes, heat, m.skipped, sort, finding, q, marks, revealPath, now]
  );
  const also = useMemo(() => findAlso(finding ? q : "", m.units, m.tools), [finding, q, m.units, m.tools]);

  const setQ = (v: string) => { setQState(v); setReleased(false); };
  const clear = () => { setQState(""); setReleased(false); };
  const isOpen = (g: ExplorerGroup) => (finding ? g.open : folds[g.key] ?? g.open);
  const toggle = (g: ExplorerGroup) => setFolds((f) => ({ ...f, [g.key]: !(f[g.key] ?? g.open) }));

  const openNote = useCallback((path: string, block: ScrollLogicalPosition = "nearest") => {
    // A deep link the corpus cannot honour names the mode instead of doing nothing: the address
    // sync below would otherwise strip ?note= and leave the reader looking at an ordinary screen,
    // with no way to tell a bad link from a link that worked.
    if (!noteBy.has(path)) { setMissing(path); return; }
    setMissing(null);
    setEvidenceOpen(null);
    setPinErr(null);
    setTarget({ kind: "note", path });
    setFolds((f) => { const n = { ...f }; for (const k of ancestorsOf(path)) n[k] = true; return n; });
    requestAnimationFrame(() => document.getElementById(rowId(path))?.scrollIntoView({ block }));
  }, [noteBy]);

  const openWorkingContext = useCallback((project = "") => {
    const route = consoleRoutePath(window.location.pathname);
    if (!route) return;
    leavingAsk.current = true;
    setTarget(null);
    lens.close();
    const name = normaliseProject(project);
    router.push(route.root + "/overview#working-context" + (name ? "?project=" + encodeURIComponent(name) : ""));
  }, [lens.close, router]);

  const openTool = (name: string) => { if (m.tools.some((t) => t.name === name)) setTarget({ kind: "tool", name }); };

  const pin = async (path: string, temperature: "hot" | "cold" | null) => {
    setPinBusy(path);
    setPinErr(null);
    try {
      const res = await fetch(heatUrl("pin"), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ path, pin: temperature ? { temperature, reason: "" } : null }) });
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) throw new Error(data.error ?? `pin failed (HTTP ${res.status})`);
      setPinOverride((o) => ({ ...o, [path]: temperature ? { temperature, reason: "" } : null }));
      // The seat and the temperatures recompute server-side; refresh so the tree tells the truth
      // about what the pin just changed rather than only marking the row.
      router.refresh();
    } catch (e) {
      setPinErr(`pin not saved — ${e instanceof Error ? e.message : String(e)}. note_pins holds its previous state`);
    } finally {
      setPinBusy(null);
    }
  };

  // The run route spends a slot BEFORE it calls the reader, so a refused or failed ask consumed
  // one too. Deriving the figure from a successful answer alone let the count fall back to the
  // server-render number the moment an ask errored — the ceiling appearing to refund itself. The
  // floor only ever climbs, and both branches of submit() raise it.
  const [spentFloor, setSpentFloor] = useState(m.spent);

  const submit = async () => {
    const question = q.trim();
    if (!question || busy) return;
    setBusy(true);
    setError(null);
    setAnswer(null);
    setReleased(true);
    try {
      const res = await fetch(runUrl(), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ question }) });
      const body = (await res.json().catch(() => null)) as (AskAnswer & { error?: string }) | null;
      if (!res.ok) {
        setError(body?.error ?? `the ask was refused (${res.status})`);
        // A refused ask still spent its slot — the route charges before it calls the reader — and
        // says so in the failure body. Take the number, or the counter reads as a refund.
        if (typeof body?.spent === "number") setSpentFloor((f) => Math.max(f, body.spent as number));
        return;
      }
      setAnswer(body);
      setAsked(question);
      setAskedAt(Date.now());
    } catch {
      setError("the ask did not reach the server");
    } finally {
      setBusy(false);
    }
  };


  const askAbout = (title: string) => {
    setQState(`what does ${title} decide, and what was corrected?`);
    setReleased(true);
    lens.close();
    inputRef.current?.focus();
  };

  const pinOf = (path: string): PinState => {
    if (path in pinOverride) return pinOverride[path];
    const h = heatBy.get(path);
    return h?.pinned ? { temperature: h.pinned, reason: h.pinReason } : null;
  };

  const contentFor = useCallback((t: LensTarget): LensContent | null => {
    if (t.kind === "note") {
      const n = noteBy.get(t.path);
      if (!n) return null;
      const h = heatBy.get(t.path) ?? null;
      const stamp: Stamp = stampOf(n, STALE_DAYS);
      const packed = answer?.shortlist.find((s) => s.path === t.path);
      const citedHere = Boolean(answer?.citation && answer.citation.path === t.path && !answer.citedOutsidePack);
      const inAnswer: InAnswer | null = packed ? { rank: packed.rank, score: packed.score, terms: packed.terms, citedLine: citedHere ? answer!.citation!.line : null } : null;
      const pinVM: PinVM = { state: pinOf(t.path), available: m.pinsAvailable, busy: pinBusy === t.path, error: pinErr, onPin: (temp) => void pin(t.path, temp) };
      const project = n.dir === "projects" ? n.path.slice("projects/".length, -".md".length) : null;
      return {
        kind: `note · ${n.dir}`,
        title: n.title,
        body: (
          <NoteLensBody
            key={t.path}
            note={n}
            heat={h}
            sha={m.sha}
            stamp={stamp}
            scoring={m.scoring}
            retracted={m.retractedByPath[t.path] ?? []}
            connections={m.connections}
            evidenceOpen={evidenceOpen}
            onEvidence={setEvidenceOpen}
            onOpenNote={(p) => openNote(p)}
            inAnswer={inAnswer}
            citedHeading={citedHere ? answer!.citation!.heading : null}
            pin={pinVM}
            repoUrl={m.repoUrl}
            onAsk={() => askAbout(n.title)}
            onHandoff={project ? () => openWorkingContext(project) : null}
          />
        ),
      };
    }
    const tool = m.tools.find((x) => x.name === t.name);
    if (!tool) return null;
    return { kind: "tool", title: tool.name, body: <ToolLensBody key={tool.name} tool={tool} onAsk={() => askAbout(tool.name)} /> };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- every input is listed below; the callbacks it closes over are rebuilt with it
  }, [noteBy, heatBy, answer, pinOverride, pinBusy, pinErr, evidenceOpen, m, openNote, openWorkingContext]);

  // Publish the body for the target, and re-publish whenever anything it shows moves. The
  // close watcher runs first in the same commit: it only clears a target this component itself
  // published, so a target set and not yet published cannot be cleared by the empty drawer.
  const published = useRef<string | null>(null);
  useEffect(() => {
    if (!lens.lens && published.current) {
      published.current = null;
      setTarget(null);
    }
  }, [lens.lens]);
  useEffect(() => {
    if (!target) return;
    const content = contentFor(target);
    if (!content) { setTarget(null); return; }
    lens.open(content);
    published.current = `${target.kind}:${"path" in target ? target.path : target.name}`;
    // eslint-disable-next-line react-hooks/exhaustive-deps -- lens.open is stable; contentFor carries every input
  }, [target, contentFor]);

  // ?note= on arrival: open the lens and bring the row into view, once.
  const arrived = useRef(false);
  useEffect(() => {
    if (arrived.current) return;
    arrived.current = true;
    if (m.initial.note) openNote(m.initial.note, "center");
  }, [m.initial.note, openNote]);

  // The address follows the sort and the open note, so the screen you are looking at is the
  // one a pasted link reopens. replaceState, never a navigation: nothing re-reads the corpus.
  useEffect(() => {
    // Closing the note for a cross-screen shortcut must not overwrite a pending navigation.
    if (leavingAsk.current) return;
    const u = new URL(window.location.href);
    if (target?.kind === "note") u.searchParams.set("note", target.path);
    else u.searchParams.delete("note");
    if (sort !== "name") u.searchParams.set("sort", sort);
    else u.searchParams.delete("sort");
    const next = `${u.pathname}${u.search}${u.hash}`;
    if (next !== `${window.location.pathname}${window.location.search}${window.location.hash}`) window.history.replaceState(null, "", next);
  }, [target, sort]);

  const spent = Math.max(spentFloor, answer?.spent ?? 0, m.spent);

  const value: AskState = useMemo(() => ({
    m, q, setQ, clear, finding, also, submit, busy, error, answer, asked, askedAt, sort, setSort, tree, isOpen, toggle, target,
    openNote, openTool, lit, setLit, inputRef, noteBy, spent, missing, openWorkingContext,
  }), [missing, m, q, setQ, clear, finding, also, submit, busy, error, answer, asked, askedAt, sort, tree, isOpen, toggle, target, openNote, openTool, lit, noteBy, spent, openWorkingContext]);
  return <AskCtx.Provider value={value}>{children}</AskCtx.Provider>;
}

/* ── 01 · the band: the input, the hints, the ALSO strip ───────────────────────────────── */

export function AskBand() {
  const { m, q, setQ, clear, finding, also, submit, busy, tree, inputRef, openTool, spent } = useAsk();
  const sha8 = m.sha.slice(0, 8);
  const noMatch = finding && tree.shown === 0 && also.total === 0;
  return (
    <>
      <span className="askChipNo" aria-hidden><b>01</b><span>Ask the brain · find a note</span></span>
      <h1 id="askBandTitle" className="askSr">Ask the brain, or find a note</h1>
      <form className="askForm" onSubmit={(e) => { e.preventDefault(); void submit(); }}>
        <label className="askSr" htmlFor="askQ">Find a note, a unit or a tool — Enter asks the brain</label>
        <input
          id="askQ"
          ref={inputRef}
          className="askQ"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Escape" && q) { e.preventDefault(); clear(); } }}
          placeholder="find a note, a unit or a tool — enter asks the brain"
          maxLength={500}
          autoComplete="off"
          spellCheck={false}
          aria-busy={busy}
        />
        <button type="submit" className="askSubmit" disabled={busy || !q.trim() || !m.reader}>{busy ? "Reading" : "Ask"}</button>
      </form>
      <div className="askHints">
        <span>typing finds · enter asks · reader <b>{m.reader ?? "none"}</b> · trusted door · unscoped · {tree.total} notes at {sha8}</span>
        <span>{busy ? "one model call · " : "finding is free · asking spends one model call · "}<b>{spent} of {m.ceiling}</b> on this instance</span>
      </div>
      {m.readerError && <div className="askHints"><span className="askHintCrit">no reader can answer — {m.readerError}</span></div>}
      {finding && also.total > 0 && (
        <div className="askAlso" aria-label="Also matching">
          <div className="askAlsoHead"><span>Also · units and tools · no directory, no model call</span><span>{also.total} match{also.total === 1 ? "" : "es"}</span></div>
          {also.rows.map((r) =>
            r.kind === "unit" ? (
              <a key={`u:${r.id}`} className="askAlsoRow" href={`ops#${encodeURIComponent(r.id)}`}>
                <span className="askAlsoKind">unit</span>
                <span className="askAlsoName">{r.title}</span>
                <span className="askAlsoMeta">{r.meta} · on Ops</span>
              </a>
            ) : (
              <button key={`t:${r.id}`} type="button" className="askAlsoRow" onClick={() => openTool(r.id)}>
                <span className="askAlsoKind">tool</span>
                <span className="askAlsoName">{r.title}</span>
                <span className="askAlsoMeta">{r.meta}</span>
              </button>
            )
          )}
          {also.total > also.rows.length && <div className="askAlsoMore">+{also.total - also.rows.length} more — narrow the find</div>}
        </div>
      )}
      {noMatch && <div className="askAlsoNone" role="status">nothing matches “{q.trim()}” — {tree.total} notes, {m.units.length} units, {m.tools.length} tools</div>}
    </>
  );
}

/* ── The explorer: header, columns, the tree, the legend ───────────────────────────────── */

function TempCells({ temp, off }: Readonly<{ temp: ExplorerRow["temp"]; off: boolean }>) {
  const temperature = off ? "unscored" : temp ?? "unscored";
  const lit = temperature === "hot" ? 3 : temperature === "warm" ? 2 : temperature === "cold" ? 1 : 0;
  const word = off ? "outside the reader tier — no temperature" : temp ?? "unscored";
  return (
    <span className={`askTemp askTemp-${temperature}`} title={word} aria-label={`temperature ${word}`}>
      {[0, 1, 2].map((i) => <i key={i} className={i < lit ? "on" : undefined} />)}
    </span>
  );
}

const SEAT_TIP: Record<"profile" | "recent" | "router", string> = {
  profile: "in the seat · profile — served in full",
  recent: "in the seat · recent day — served verbatim",
  router: "in the seat · router row — path and description",
};

function SeatCell({ seat, off }: Readonly<{ seat: ExplorerRow["seat"]; off: boolean }>) {
  const tip = off ? "never in the seat" : seat ? SEAT_TIP[seat] : "not loaded at boot — one call away";
  return <span className={`askSeat${seat ? " on" : ""}`} title={tip} aria-label={seat ? "in the seat" : "not in the seat"}><i /></span>;
}

function StampCell({ stamp, off }: Readonly<{ stamp: Stamp; off: boolean }>) {
  if (off) return <span className="askStampAge askStampNone" title="outside the reader tier — no stamp is read">—</span>;
  switch (stamp.kind) {
    case "rec":
      return <span className="askStampAge askStampRec" title="a dated record — its stamp cannot go stale">rec</span>;
    case "none":
      return <span className="askStampAge askStampNone" title="no _Facts last verified_ stamp — the note makes no claim">—</span>;
    case "settled":
      return <span className="askStampAge askStampSet" title={`decays: false — settled history, verified ${stamp.days} d ago`}>{stamp.days} d</span>;
    case "stale":
      return <span className="askStampAge askStampStale" title={`_Facts last verified_ ${stamp.days} d ago — stale, past ${STALE_DAYS} d`}>{stamp.days} d</span>;
    default:
      return <span className="askStampAge" title={`_Facts last verified_ ${stamp.days} d ago`}>{stamp.days} d</span>;
  }
}

function Row({ r }: Readonly<{ r: ExplorerRow }>) {
  const { target, openNote, lit } = useAsk();
  const sel = target?.kind === "note" && target.path === r.path;
  const cls = [
    "askRow",
    r.depth > 0 ? `askD${r.depth}` : "",
    sel ? "askRowSel" : "",
    lit === r.path ? "askRowLit" : "",
    r.mark && r.mark.kind !== "cut" ? "askRowRead" : "",
    r.off ? "askRowOff" : "",
  ].filter(Boolean).join(" ");
  const cells = (
    <>
      <span className="askRowName">
        <span className="askLeaf">{r.leaf}</span>
        {r.pin && <span className={`askPinTag askPin-${r.pin.temperature}`} title={`pinned ${r.pin.temperature}${r.pin.reason ? ` — ${r.pin.reason}` : ""}`}>pin</span>}
        {r.mark?.kind === "cited" && <span className="askMark askMarkCited" title={`cited by the last answer · rank ${r.mark.rank}`}>cited</span>}
        {r.mark?.kind === "read" && <span className="askMark" title={`read by the last answer · rank ${r.mark.rank}`}>read {r.mark.rank}</span>}
        {r.mark?.kind === "cut" && <span className="askMark askMarkCut" title={`ranked, not packed — ${r.mark.by}`}>cut</span>}
        <span className="askTitle">{r.title}</span>
      </span>
      <TempCells temp={r.temp} off={r.off} />
      <SeatCell seat={r.seat} off={r.off} />
      <StampCell stamp={r.stamp} off={r.off} />
      <span className={`askRet${r.retracted ? " on" : ""}`} title={r.off ? "not read" : r.retracted ? `${r.retracted} retracted passage${r.retracted > 1 ? "s" : ""}, kept on the page` : "no retracted passages"}>{r.retracted || "·"}</span>
      <span className="askTok" title="estimated note-body tokens (characters / 4) at this commit">~{num(r.tokens)}</span>
    </>
  );
  // An archive/ row is a fact, not a control: nothing opens, because nothing was read.
  if (r.off) return <div className={cls} id={rowId(r.path)}>{cells}</div>;
  return (
    <button type="button" id={rowId(r.path)} className={cls} aria-haspopup="dialog" aria-expanded={sel} title={`${r.path} · open in the lens`} onClick={() => openNote(r.path)}>
      {cells}
    </button>
  );
}

function groupMeta(g: ExplorerGroup, skippedNull: boolean): ReactNode {
  if (g.kind === "archive") {
    return skippedNull ? g.extra : `${g.count} file${g.count === 1 ? "" : "s"} · ${g.extra}`;
  }
  const bits: ReactNode[] = [`${g.count} ${g.unit}`, `~${tok(g.tokens)} body tok`];
  if (g.read) bits.push(<b key="r" className="askAccentFg">{g.read} read</b>);
  if (g.stale) bits.push(<b key="s" className="askWarnFg">{g.stale} stale</b>);
  if (g.retracted) bits.push(<b key="x" className="askWarnFg">{g.retracted} ret</b>);
  if (g.hot || g.warm || g.cold) bits.push(`${g.hot} hot ${g.warm} warm ${g.cold} cold`);
  if (g.extra) bits.push(g.extra);
  return bits.map((b, i) => <span key={i}>{i > 0 && " · "}{b}</span>);
}

function Group({ g }: Readonly<{ g: ExplorerGroup }>) {
  const { isOpen, toggle, m } = useAsk();
  const open = isOpen(g);
  const id = `askKids-${g.key.replace(/[^A-Za-z0-9]/g, "-")}`;
  return (
    <div className={`askDir${g.off ? " askDirOff" : ""}`}>
      <button type="button" className={`askGroup${g.depth > 0 ? ` askD${g.depth}` : ""}`} aria-expanded={open} aria-controls={id} onClick={() => toggle(g)}>
        <span className="askCaret" aria-hidden>{open ? "▾" : "▸"}</span>
        <span className="askGroupName">{g.label}</span>
        <span className="askGroupMeta">{groupMeta(g, m.skipped === null)}</span>
      </button>
      <div id={id} className="askKids" hidden={!open}>
        {g.groups.map((s) => <Group key={s.key} g={s} />)}
        {g.rows.map((r) => <Row key={r.path} r={r} />)}
        {g.kind === "archive" && (
          <div className="askOffNote">
            archive/ holds superseded material; lib/corpus.ts skips it before anything runs, and the mirror never holds it. Listed here so “the brain does not know” can be told apart from “the brain filed it away”. Rows come from git, not from health.notes, and carry no temperature.
          </div>
        )}
      </div>
    </div>
  );
}

function degradeLine(m: AskModel): string | null {
  if (m.scoring === "off") return "temperatures · scoring off — no SUPABASE_URL on this deploy; the corpus and the seat are real";
  if (m.scoring === "unavailable") return "temperatures unknown this render — note_scores did not answer; unknown, not cool";
  if (m.scoring === "empty") return "no scored rows yet — the first sync fills it";
  if (m.coldStart) return "scores are live but no note has ever been read — every temperature is carried by write-recency and the directory prior: the designed cold start, not usage";
  return null;
}

export function AskTree() {
  const { m, tree, sort, setSort, finding } = useAsk();
  const sha8 = m.sha.slice(0, 8);
  const degraded = degradeLine(m);
  return (
    <>
      <div className="askExHead">
        <div className="askExTitle">
          <h2 className="askLbl">The corpus · {tree.total} notes</h2>
          <span className="askLblMeta">~{num(m.corpusTokens)} estimated body tokens · live at {sha8}</span>
        </div>
        <div className="askSeatStrip">
          <span><i aria-hidden /><b>the seat</b> ~{num(m.seat.tokens)} estimated boot tok</span>
          {m.seat.parts.map((p) => <span key={p}>{p}</span>)}
        </div>
        <div className="askExSum">
          <span>{tree.hot} hot · {tree.warm} warm · {tree.cold} cold{tree.total - tree.hot - tree.warm - tree.cold > 0 ? ` · ${tree.total - tree.hot - tree.warm - tree.cold} unscored` : ""}</span>
          <span>{tree.seat} in the seat</span>
          <span className={tree.stale ? "askWarnFg" : undefined}>{tree.stale} stale</span>
          <span className={tree.retracted ? "askWarnFg" : undefined}>{tree.retracted} retracted in {tree.retractedNotes} note{tree.retractedNotes === 1 ? "" : "s"}</span>
          {tree.read > 0 && <span className="askAccentFg">{tree.read} read by the last answer</span>}
        </div>
        {degraded && <div className="askDegrade">{degraded}</div>}
        <div className="askExTools">
          <span id="askSortLabel">sort</span>
          <span className="askSort" role="group" aria-labelledby="askSortLabel">
            {SORTS.map((s) => <button key={s} type="button" aria-pressed={sort === s} onClick={() => setSort(s)}>{s}</button>)}
          </span>
          <span className="askLblMeta askExShown" role="status">{finding ? `${tree.shown} of ${tree.total} match` : `all ${tree.total} shown`}</span>
        </div>
      </div>
      <div className="askCols" aria-hidden><span>note</span><span>temp</span><span className="askC">seat</span><span>stamp</span><span className="askR">ret</span><span className="askR">tok</span></div>
      <div className="askTree" aria-label="Notes by directory">
        {tree.groups.map((g) => <Group key={g.key} g={g} />)}
        {tree.groups.length === 0 && <div className="askNone">no note matches — units and tools, if any matched, are under the input</div>}
      </div>
      <div className="askLegend">
        <span><b>temp</b> <span className="askLegendTemp askLegendTemp-hot"><i aria-hidden>■■■</i> hot</span> · <span className="askLegendTemp askLegendTemp-warm"><i aria-hidden>■■□</i> warm</span> · <span className="askLegendTemp askLegendTemp-cold"><i aria-hidden>■□□</i> cold</span> · <span className="askLegendTemp askLegendTemp-unscored"><i aria-hidden>□□□</i> unscored</span> — from note_scores</span>
        <span><b>seat</b> ■ loaded by every boot call</span>
        <span><b>stamp</b> days since <i>_Facts last verified_</i> · amber past {STALE_DAYS} d · dim when decays: false · rec = a dated record · — none</span>
        <span><b>ret</b> retracted passages, kept on the page</span>
        <span><b>read</b> in the last answer&apos;s pack · <b>cited</b> the passage it quoted · <b>cut</b> ranked, refused by a cap</span>
      </div>
    </>
  );
}

/* ── The readout: the answer, or the busy, error and empty states ──────────────────────── */

function Busy() {
  const { m, q } = useAsk();
  // The clock lives here, not in the shared context: it ticks ten times a second and Busy is its
  // only reader, so in the provider it reconciled all ~200 explorer rows per tick for a number
  // none of them show. Real elapsed time, not a staged progression — the server does not report
  // which of its three steps it is on, so the screen does not pretend to know.
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    const t0 = Date.now();
    const id = setInterval(() => setElapsed(Date.now() - t0), 100);
    return () => clearInterval(id);
  }, []);
  const sha8 = m.sha.slice(0, 8);
  return (
    <div className="askAnswerCard askBusy" aria-live="polite" aria-busy="true">
      <span className="askBusyBar" aria-hidden />
      <div className="askAnswerHead">
        <span className="askEyebrow">Asking · one model call</span>
        <p className="askAnswerQ">{q.trim()}</p>
      </div>
      <ol className="askSteps">
        <li className="askStep"><i aria-hidden /><span><b>narrowing</b> · {narrowingLine(m.narrowing)}</span></li>
        <li className="askStep"><i aria-hidden /><span><b>reading</b> · {m.reader} · the pack, not an index</span></li>
        <li className="askStep"><i aria-hidden /><span><b>verifying</b> · the quote against the file at {sha8} · no model in this step</span></li>
      </ol>
      <div className="askElapsed">{(elapsed / 1000).toFixed(1)} s · the three steps run in order on the server; the answer lands when the third completes</div>
    </div>
  );
}

function Empty() {
  const { m, tree, spent } = useAsk();
  const g = m.glance;
  // readCalls returns covers = min(window, now - start), so on a fresh deploy or either fallback
  // the "24 h" figure is over less than a day and must say so rather than imply a full one.
  const partialLog = g.covers < 86_400_000;
  const window24 = partialLog ? `${Math.max(1, Math.round(g.covers / 3_600_000))} h` : "24 h";
  const checked = g.asks === 0
    ? `${window24}: no asks yet${partialLog ? " · partial log" : ""}`
    : `${window24}: ${g.asks} ask${g.asks === 1 ? "" : "s"} · ${g.verified} verified${g.superseded ? ` · ${g.superseded} superseded` : ""}${g.partial ? ` · ${g.partial} partially verified` : ""}${g.unverified ? ` · ${g.unverified} unverified` : ""}${g.notInBrain ? ` · ${g.notInBrain} not in brain` : ""}${g.errors ? ` · ${g.errors} errors` : ""}${g.cutOff ? ` · ${g.cutOff} cut off by the platform` : ""}${g.timedOut ? ` · ${g.timedOut} timed out in budget` : ""}${partialLog ? " · partial log" : ""}`;
  const store = g.source === "store" ? "" : g.source === "unconfigured" ? " · this instance's count only — no durable call store" : " · call store unreachable — in-memory view";
  const unscored = tree.total - tree.hot - tree.warm - tree.cold;
  const tempDegraded = degradeLine(m);
  return (
    <div className="askAnswerCard askEmpty">
      <div className="askAnswerHead"><span className="askEyebrow">The corpus at a glance</span></div>
      <dl className="askGlance">
        <div className="askGlanceRow"><dt>the seat</dt><dd>~{num(m.seat.tokens)} estimated boot tokens · measured from what every boot call serves before you type</dd></div>
        {/* A degraded scorer must not print three zeros: "0 hot · 0 warm · 0 cold" reads as a
            measured result. The mode this panel is in gets said here, as it is one column over. */}
        <div className="askGlanceRow"><dt>temperature</dt><dd>{tempDegraded ? <>— {tempDegraded}</> : <>{tree.hot} hot · {tree.warm} warm · {tree.cold} cold{unscored ? ` · ${unscored} unscored` : ""}</>} · {tree.seat} in the seat</dd></div>
        <div className="askGlanceRow"><dt>how answers checked out</dt><dd>{checked}{store}</dd></div>
        <div className="askGlanceRow"><dt>this instance</dt><dd>ask {spent} of {m.ceiling} · the ceiling exists so a stuck tab cannot bill the key in a loop · resets on cold start</dd></div>
      </dl>
      <div className="askEmptyLine">nothing asked yet · enter asks · the answer and what it read land here</div>
    </div>
  );
}

function Answer({ a }: Readonly<{ a: AskAnswer }>) {
  const { m, asked, askedAt, noteBy, openNote, setLit } = useAsk();
  const c = a.citation;
  const citedPath = c && !a.citedOutsidePack ? c.path : null;
  const tokensOf = (path: string, bytes: number) => noteBy.get(path)?.tokens ?? Math.round(bytes / 4);
  const pct = a.corpusTokens > 0 ? Math.round((a.packTokens / a.corpusTokens) * 100) : 0;
  const capCuts = a.cut.filter((x) => x.by !== "k");
  const kCuts = a.cut.filter((x) => x.by === "k");
  const K_SHOWN = 5;
  const github = c && m.repoUrl ? `${m.repoUrl}/blob/${c.commit}/${c.path}${c.line != null ? `#L${c.line}` : ""}` : null;
  const rowProps = (path: string) => ({
    onClick: () => openNote(path),
    onMouseEnter: () => setLit(path),
    onMouseLeave: () => setLit(null),
    onFocus: () => setLit(path),
    onBlur: () => setLit(null),
  });
  const zero = a.narrowing.mode === "full"
    ? `every live note was handed to the reader up to the budget — no ranking, nothing scored zero.`
    : a.narrowing.mode === "fallback"
      ? `${a.zeroCount} notes scored zero — no lexical signal anywhere for this question, so the largest notes went to the caps instead.`
      : `${a.zeroCount} notes scored zero — no lexical signal for this question, never shown to the reader.`;
  const archive = m.skipped === null
    ? " archive/ was not searched: it sits outside the reader tier."
    : ` archive/ (${m.skipped.length} file${m.skipped.length === 1 ? "" : "s"}) was not searched: it sits outside the reader tier.`;
  return (
    <article className="askAnswerCard" aria-live="polite">
      <div className="askAnswerHead">
        <span className="askEyebrow">Answer{askedAt != null ? ` · ${utcHm(askedAt)}` : ""} · asked from this screen</span>
        <p className="askAnswerQ">{asked}</p>
      </div>
      <div className="askVerdictRow">
        <span className={`askVerdict ${verdictTone(a.stamp)}`}>{a.stamp}</span>
        <span className="askVerdictLine">{a.stampLine}</span>
      </div>
      <p className="askAnswerText">{a.answer}</p>

      {c ? (
        <section className="askCitation" aria-label="Citation">
          <div className="askSectionHead">
            <span className="askLbl">Citation · the file&apos;s own text</span>
            <span className="askLblMeta">{c.verified ? "verified with no model in the step" : "not verified — the quote was checked against the file and failed"}</span>
          </div>
          <div className="askCitationLine">
            {noteBy.has(c.path) ? (
              <button type="button" className="askLink" onClick={() => openNote(c.path)}>{c.path}{c.line != null ? `:${c.line}` : ""}</button>
            ) : (
              <span>{c.path}{c.line != null ? `:${c.line}` : ""}</span>
            )}
            {c.heading && <span>under “{c.heading}”</span>}
            <span>@{c.commit}</span>
            {a.citedOutsidePack && <span className="askWarnFg">not in the pack — the reader cannot have read it there</span>}
          </div>
          {c.evidence && <blockquote className={`askQuote${c.superseded ? " askQuoteWarn" : c.verified ? "" : " askQuoteBad"}`}>{c.evidence}</blockquote>}
          {c.superseded && <div className="askReason">this passage is retracted — the quote is real and the claim is not current</div>}
          {!c.verified && <div className="askReason">{c.reason}</div>}
          <div className="askActions">
            {noteBy.has(c.path) && <button type="button" className="inkControl askBtn askBtnPrimary" onClick={() => openNote(c.path)}><span className="inkSweep" aria-hidden="true" />Open the note</button>}
            {github && <a className="inkControl askBtn" href={github} target="_blank" rel="noopener"><span className="inkSweep" aria-hidden="true" />Open on GitHub at {c.commit.slice(0, 8)}</a>}
          </div>
        </section>
      ) : (
        <div className="askNoCite">
          {a.notInBrain
            ? "nothing was cited — the reader found no supporting text in the notes it was shown, and said so rather than composing an answer from outside the brain. What it read, below, is the proof of the abstention."
            : a.unresolvedTag
              ? "the reader gave a quote but no file tag this request issued — it ignored the contract, or a note talked it into naming a file by path. Nothing here is proven."
              : "nothing was cited, so nothing could be checked against a file."}
        </div>
      )}

      <section className="askRead" aria-label="What it read">
        <div className="askSectionHead">
          <span className="askLbl">What it read · {a.shortlist.length} of {m.notes.length} notes</span>
          <span className="askLblMeta">{narrowingLine(a.narrowing)}</span>
        </div>
        {a.citedOutsidePack && c && <div className="askReadNote">the reader cited {c.path}, which is not in this pack — it cannot have read it there; the stamp says so</div>}
        <div className="askReadCols" aria-hidden><span>#</span><span>note · why it ranked</span><span className="askR">tok</span><span /></div>
        {a.shortlist.map((s, i) => {
          const cut = s.path.lastIndexOf("/");
          const part = partNote(s.path, i, a.shortlist, a.narrowing);
          const cited = s.path === citedPath;
          const known = noteBy.has(s.path);
          const why = s.score == null ? "in the pack · no ranking on a full read" : `bm25 ${s.score.toFixed(1)}${s.terms.length ? ` · matched ${s.terms.join(" · ")}` : " · no matched terms — the largest notes went to the caps"}`;
          return (
            <button key={s.path} type="button" className={`askReadRow${cited ? " askReadRowCited" : ""}`} disabled={!known} {...rowProps(s.path)}>
              <span className="askReadRank">{s.rank}</span>
              <span className="askReadPath"><span className="askReadDir">{cut >= 0 ? s.path.slice(0, cut + 1) : ""}</span><b>{cut >= 0 ? s.path.slice(cut + 1) : s.path}</b></span>
              <span className="askReadWhy">{why}{part && <span className="askReadPart">{part}</span>}</span>
              <span className="askReadTok">{num(tokensOf(s.path, s.bytes))}</span>
              <span className="askReadMark">{cited ? <span className="askMark askMarkCited">cited</span> : <span className="askMark">read</span>}</span>
            </button>
          );
        })}
        {a.cut.length > 0 && (
          <>
            <div className="askReadSub">
              <span className="askLbl askLblSm">Ranked, not packed · {a.cut.length}</span>
              <span className="askLblMeta">scored, then refused by a cap — the reader never saw these</span>
            </div>
            {[...capCuts, ...kCuts.slice(0, K_SHOWN)].map((x) => {
              const cut = x.path.lastIndexOf("/");
              return (
                <button key={x.path} type="button" className="askReadRow askReadRowCut" disabled={!noteBy.has(x.path)} {...rowProps(x.path)}>
                  <span className="askReadRank">·</span>
                  <span className="askReadPath"><span className="askReadDir">{cut >= 0 ? x.path.slice(0, cut + 1) : ""}</span><b>{cut >= 0 ? x.path.slice(cut + 1) : x.path}</b></span>
                  <span className="askReadWhy">bm25 {x.score.toFixed(1)} · {cutWord(x.by, a.narrowing)}</span>
                  <span className="askReadTok">{noteBy.has(x.path) ? num(noteBy.get(x.path)!.tokens) : "—"}</span>
                  <span className="askReadMark"><span className="askMark askMarkCut">cut</span></span>
                </button>
              );
            })}
            {kCuts.length > K_SHOWN && <div className="askReadNote">+{kCuts.length - K_SHOWN} more ranked below k={a.narrowing.k}, not listed — every one carries a CUT mark in the explorer</div>}
          </>
        )}
        <div className="askReadZero">{zero}{archive}</div>
      </section>

      <div className="askCost" role="group" aria-label="Cost">
        <span><b>one model call</b> · {a.model}</span>
        <span>{num(a.packTokens)} of {num(a.corpusTokens)} tokens hauled · <b>{pct}%</b></span>
        <span>{(a.ms / 1000).toFixed(1)} s</span>
        <span>@{a.commit.slice(0, 8)}</span>
        <span>ask {a.spent} of {a.ceiling} on this instance</span>
      </div>
    </article>
  );
}

export function AskReadout() {
  const { busy, error, answer, asked, missing, m, openWorkingContext } = useAsk();
  const sha8 = m.sha.slice(0, 8);
  // A live region inserted in the same commit as its content is not reliably announced, and the
  // answer is the whole point of this screen. So one region is in the readout from first paint
  // and only its text changes — the pattern ops-client.tsx already uses for its receipts.
  const announce = error
    ? `the ask failed: ${error}`
    : busy
      ? "asking the brain, one model call"
      : answer
        ? `answer ready for ${asked || "your question"} — ${answer.stamp ?? "unstamped"}, ${answer.shortlist?.length ?? 0} of ${answer.candidates ?? 0} notes read`
        : "";
  return (
    <>
      <span className="askSr" role="status" aria-live="polite">{announce}</span>
      {missing && (
        <div className="askFail" role="status">
          {missing} is not in the corpus at {sha8} — the link may predate a rename, or the note may have been archived.
        </div>
      )}
      {error && <div className="askFail" role="alert">{error}</div>}
      {busy ? <Busy /> : answer ? <Answer a={answer} /> : <Empty />}
      <div className="askContextLink">
        <span>Preparing the next session? Saved notes and project handoffs live together in Overview.</span>
        <button type="button" className="inkControl askBtn" onClick={() => openWorkingContext()}><span className="inkSweep" aria-hidden="true" />Manage working context</button>
      </div>
    </>
  );
}
