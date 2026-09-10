// The screen's data, computed server-side. Every string here already states its window so the
// page never has to invent one.
import { opsStore, type OpsEvent } from "./ops";
import { deriveState, nextDue, type Ack, type OpsState, type Owner, type Run, type Unit, type UnitKind } from "./ops-state";
import type { GlyphName } from "./glyphs";

export const STATE_LABEL: Record<OpsState, string> = { scheduled: "Scheduled", late: "Late", missed: "Missed", running: "Running", succeeded: "Succeeded", unverified: "Unverified", failed: "Failed", crashed: "Crashed", needs_you: "Needs you", acknowledged: "Acknowledged", paused: "Paused", seen: "Seen", quiet: "Quiet" };
export const STATE_TONE: Record<OpsState, "ok" | "warn" | "crit" | "live" | "paper" | "dashed"> = { scheduled: "paper", late: "warn", missed: "crit", running: "live", succeeded: "ok", unverified: "dashed", failed: "crit", crashed: "crit", needs_you: "crit", acknowledged: "warn", paused: "paper", seen: "paper", quiet: "paper" };
const ATTENTION = new Set<OpsState>(["needs_you", "crashed", "missed", "failed", "late", "unverified"]);
const OWNER_LABEL: Record<Owner, string> = { manager: "Manager · coordinator", indexer: "Indexer · file indexer", retrieval: "Retrieval · file retrieval", none: "Unassigned" };

export interface BoardRow { id: string; name: string; kind: UnitKind; owner: Owner; state: OpsState; stateLabel: string; schedule: string; lastRun: string; evidence: string[]; error: string | null; nextDue: string | null; notes: string | null; summary: string | null; selectedControls: Array<"ack" | "snooze" | "pause" | "resume" | "run-now">; runNowKind: "dispatch" | "link" | null; runNowTarget: string | null }
export interface Board { mode: "live" | "unconfigured" | "unreachable"; stamp: string; /** Has any unit ever reported a run? Until one has, "on schedule" is a claim the ledger cannot make. */ reported: boolean; counts: { needsYou: number; running: number; lateOrMissed: number }; nextRun: { unit: string; inSeconds: number } | null; groups: Array<{ owner: Owner; label: string; rows: BoardRow[]; reserved?: string }>; timeline: Array<{ id: number; at: string; unit: string; kind: string; line: string; field: { text: string; tone: "ok" | "warn" | "crit" | "live" | "paper" } | null }> }

export function humanDuration(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, "0")}s`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ${String(Math.floor((s % 3600) / 60)).padStart(2, "0")}m`;
  return `${Math.floor(s / 86400)}d ${String(Math.floor((s % 86400) / 3600)).padStart(2, "0")}h`;
}
const hhmm = (iso: string) => iso.slice(11, 16);
const sha = (url: string) => { const m = /\/commit\/([0-9a-f]{7,40})/.exec(url); return m ? m[1].slice(0, 8) : url.length <= 12 ? url : url.replace(/^https?:\/\//, "").slice(0, 24); };
const period = (p: number | null) => p == null ? "no schedule" : p === 86400 ? "nightly" : p === 900 ? "heartbeat 15m" : p % 3600 === 0 ? `every ${p / 3600}h` : `every ${Math.round(p / 60)}m`;

function row(unit: Unit, run: Run | null, ack: Ack | null, fails: number, now: Date): BoardRow {
  const state = deriveState(unit, run, ack, now, fails);
  const due = nextDue(unit, run);
  const inS = due ? Math.round((due.getTime() - now.getTime()) / 1000) : null;
  const schedule = unit.kind === "machine" ? `${period(unit.period_s)} · grace ${humanDuration(unit.grace_s)}` : due ? `${period(unit.period_s)} · ${inS! >= 0 ? `next ${humanDuration(inS!)}` : `due ${humanDuration(-inS!)} ago`}` : period(unit.period_s);
  let lastRun = "never ran";
  if (run?.started_at && run.ended_at) { const d = (Date.parse(run.ended_at) - Date.parse(run.started_at)) / 1000; lastRun = unit.kind === "machine" ? `seen ${humanDuration((now.getTime() - Date.parse(run.ended_at)) / 1000)} ago` : `${hhmm(run.started_at)} → ${hhmm(run.ended_at)} · ${humanDuration(d)}`; }
  else if (run?.started_at) lastRun = `running ${humanDuration((now.getTime() - Date.parse(run.started_at)) / 1000)}`;
  const controls: BoardRow["selectedControls"] = state === "paused" ? ["resume"] : ["ack", "snooze", ...(unit.kind === "routine" || unit.kind === "agent" ? ["pause" as const] : []), ...(unit.run_now ? ["run-now" as const] : [])];
  return { id: unit.id, name: unit.name, kind: unit.kind, owner: unit.owner, state, stateLabel: STATE_LABEL[state], schedule, lastRun, evidence: (run?.evidence ?? []).map(sha), error: run?.error ?? null, nextDue: due?.toISOString() ?? null, notes: unit.notes, summary: run?.summary ?? null, selectedControls: controls, runNowKind: unit.run_now?.kind ?? null, runNowTarget: unit.run_now?.target ?? null };
}

const actorLabel=(event:OpsEvent)=>event.actor==="operator"?"Operator":event.actor==="console"?"Console operator":event.actor;
const KIND_LINE: Record<string, (n: string, e: OpsEvent) => string> = {
  start: (n) => `${n} started · lock taken`, finish: (n, e) => `${n} finished${typeof e.body?.summary === "string" ? ` · ${e.body.summary}` : ""}`, heartbeat: (n) => `${n} heartbeat`,
  transition: (n, e) => `${n}: ${stateWord(e.from_state)} → ${stateWord(e.to_state)}`, ack: (n,e) => `${actorLabel(e)} acknowledged ${n}`, snooze: (n, e) => `${actorLabel(e)} snoozed ${n} · ${String(e.body?.hours ?? "")}h`,
  pause: (n,e) => `${actorLabel(e)} paused ${n}`, resume: (n,e) => `${actorLabel(e)} resumed ${n}`, run_now: (n,e) => `${actorLabel(e)} ran ${n} now`, alert_sent: (n) => `Mail accepted by provider · ${n}`, alert_failed: (n, e) => `Mail failed · ${n} · ${String(e.body?.error ?? "")}`, read: (n) => `read · ${n}`,
};
/** A state token as the word the register prints for it — the timeline is read by a person,
 *  and `needs_you` is a column value, not a sentence. */
const stateWord = (s: string | null | undefined): string => (s && s in STATE_LABEL ? STATE_LABEL[s as OpsState] : s ?? "");
const short = (name: string) => { const s = name.replace(/^Brain /, "").replace(/^Site /, ""); return s.charAt(0).toUpperCase() + s.slice(1); };

export function buildBoard(units: Unit[], latest: Map<string, Run>, acks: Map<string, Ack | null>, fails: Map<string, number>, events: OpsEvent[], now: Date): Board {
  const rows = units.map((u) => row(u, latest.get(u.id) ?? null, acks.get(u.id) ?? null, fails.get(u.id) ?? 0, now));
  const byOwner = (o: Owner) => rows.filter((r) => r.owner === o).sort((a, b) => Number(ATTENTION.has(b.state)) - Number(ATTENTION.has(a.state)) || a.id.localeCompare(b.id));
  const groups: Board["groups"] = [
    { owner: "manager", label: OWNER_LABEL.manager, rows: byOwner("manager") },
    { owner: "indexer", label: OWNER_LABEL.indexer, rows: byOwner("indexer"), reserved: "station reserved · sub-project 2" },
    { owner: "retrieval", label: OWNER_LABEL.retrieval, rows: byOwner("retrieval"), reserved: "station reserved · sub-project 2" },
    { owner: "none", label: "Training grounds", rows: byOwner("none"), reserved: "reserved · sub-project 3 · eval runs land here" },
  ];
  // A machine's heartbeat is due every fifteen minutes forever; it is not a run and would sit in
  // "Next run" permanently, hiding the nightly routines the figure exists to announce.
  const next = rows.filter((r) => r.kind !== "machine" && r.nextDue && Date.parse(r.nextDue) >= now.getTime()).sort((a, b) => Date.parse(a.nextDue!) - Date.parse(b.nextDue!))[0];
  const names = new Map(units.map((u) => [u.id, short(u.name)]));
  const timeline = events.slice(0, 40).map((e) => {
    const n = names.get(e.unit_id) ?? e.unit_id;
    const ev = (Array.isArray(e.body?.evidence) ? (e.body!.evidence as string[]) : [])[0];
    const field = ev ? { text: sha(ev), tone: "ok" as const } : e.kind === "alert_failed" ? { text: "mail failed", tone: "crit" as const } : e.kind === "snooze" || e.kind === "ack" ? { text: "until recovery", tone: "warn" as const } : e.kind === "start" ? { text: "running", tone: "live" as const } : null;
    // A finish event's body doesn't always carry the summary (real writers may omit it); when the
    // event's run_id still matches the unit's latest known run, borrow that run's summary.
    const withSummary: OpsEvent = e.kind === "finish" && typeof e.body?.summary !== "string" && latest.get(e.unit_id)?.id === e.run_id && latest.get(e.unit_id)?.summary
      ? { ...e, body: { ...e.body, summary: latest.get(e.unit_id)!.summary } }
      : e;
    return { id: e.id ?? 0, at: e.at ?? "", unit: e.unit_id, kind: e.kind, line: (KIND_LINE[e.kind] ?? ((x: string) => x))(n, withSummary), field };
  });
  return {
    mode: "live", stamp: now.toISOString(),
    reported: [...latest.values()].some((r) => !!r.started_at),
    counts: { needsYou: rows.filter((r) => r.state === "needs_you").length, running: rows.filter((r) => r.state === "running").length, lateOrMissed: rows.filter((r) => r.state === "late" || r.state === "missed").length },
    nextRun: next ? { unit: next.id, inSeconds: Math.round((Date.parse(next.nextDue!) - now.getTime()) / 1000) } : null,
    groups, timeline,
  };
}

export interface StripCell { label: string; figure: string; meta: string; crit: boolean }

/** The four figures at the top of the screen. A degraded render has counted nothing, so it says
 *  so: an em dash and "not available this render", never a fabricated 0 that reads as "all clear".
 */
export function stripFigures(board: Board): StripCell[] {
  const c = board.counts;
  if (board.mode !== "live") {
    const dash = (label: string): StripCell => ({ label, figure: "—", meta: "not available this render", crit: false });
    return [dash("Needs you"), dash("Running"), dash("Late or missed"), dash("Next run")];
  }
  return [
    { label: "Needs you", figure: String(c.needsYou), meta: c.needsYou ? "open on the register below" : "nothing waiting", crit: c.needsYou > 0 },
    { label: "Running", figure: String(c.running), meta: c.running ? "lease live" : "idle", crit: false },
    // "every unit on schedule" is only true once the schedule has an anchor: a routine's next due
    // time is measured from its last run, so until one run has reported, nothing can be late and
    // the honest reading is that nothing has reported — not that everything is fine.
    { label: "Late or missed", figure: String(c.lateOrMissed), meta: c.lateOrMissed ? "grace running or spent" : board.reported ? "every unit on schedule" : "no run reported yet", crit: false },
    { label: "Next run", figure: board.nextRun ? humanDuration(board.nextRun.inSeconds) : "—", meta: board.nextRun ? `${board.nextRun.unit} · utc` : board.reported ? "no schedule" : "known after the first run reports", crit: false },
  ];
}

/**
 * Which control a row invites. The spec's fixed order (Acknowledge primary, always) made the ink
 * button a no-op write on a healthy row and buried Run now — the one thing a nightly unit that is
 * fine actually asks for — fourth and quiet. State chooses: a paused unit invites Resume, a unit
 * in an attention state invites Acknowledge, a healthy unit with a target invites Run now, and a
 * healthy unit with no target invites nothing — every button is secondary, which is the truth.
 */
export function primaryControl(r: Pick<BoardRow, "state" | "selectedControls">): BoardRow["selectedControls"][number] | null {
  if (r.selectedControls.includes("resume")) return "resume";
  if (ATTENTION.has(r.state) && r.selectedControls.includes("ack")) return "ack";
  if (r.selectedControls.includes("run-now")) return "run-now";
  return null;
}

/** The glyph a timeline row leads with: the same meaning uses the same glyph on every page
 *  (spec §12.1), and a receipt's meaning is its kind. */
export function eventGlyph(kind: string): GlyphName {
  switch (kind) {
    case "start": case "run_now": return "run";
    case "finish": return "done";
    case "heartbeat": return "live";
    case "transition": return "trend";
    case "ack": return "verified";
    case "snooze": return "snooze";
    case "pause": return "pause";
    case "resume": return "run-again";
    case "alert_sent": return "notices";
    case "alert_failed": return "needs-you";
    case "read": return "note";
    default: return "point";
  }
}

/** The line under the strip on a degraded render, or null on a live one. "nothing shown" because
 *  nothing is: this board holds no cache, so an unreachable ledger renders an empty register. */
export function degradeLine(board: Board): string | null {
  if (board.mode === "live") return null;
  if (board.mode === "unconfigured") return "ops ledger not configured · env";
  return `unreachable this render · nothing shown · stamped ${board.stamp.slice(11, 19)} utc`;
}

export async function opsBoard(now = new Date()): Promise<Board> {
  const empty = buildBoard([], new Map(), new Map(), new Map(), [], now);
  const store = opsStore();
  if (!store) return { ...empty, mode: "unconfigured" };
  try {
    // Sequential, not Promise.all: if listUnits() throws, latestRuns() must never even be
    // invoked — calling it eagerly alongside a rejecting promise leaves an unhandled rejection
    // behind on a store double that only stubs the first method.
    const units = await store.listUnits();
    const latest = await store.latestRuns(units.map((u) => u.id));
    const acks = new Map<string, Ack | null>(); const fails = new Map<string, number>();const delivery=new Map<string,string>();
    await Promise.all(units.map(async (u) => {
      acks.set(u.id, await store.latestAck(u.id)); fails.set(u.id, await store.consecutiveFailures(u.id));
      const status=await store.deliveryStatus?.(u.id);
      if(status)delivery.set(u.id,status==="outbox_capacity"?"Alert remains owed; delivery capacity reached.":status==="provider_accepted"?"Mail accepted by provider; not inbox delivery.":status.startsWith("terminal:")?"Automatic mail attempts stopped; acceptance may be uncertain. Reconciliation required.":status==="mail_unavailable"?"Alert queued; mail configuration unavailable.":status==="mail_credentials_changed"?"Alert retry paused: mail credentials changed.":"Alert queued or awaiting provider confirmation.");
    }));
    const events = await store.listEvents(new Date(now.getTime() - 30 * 86400_000).toISOString(), 200);
    return buildBoard(units.map(u=>delivery.has(u.id)?{...u,notes:[u.notes,delivery.get(u.id)].filter(Boolean).join("\n")}:u), latest, acks, fails, events, now);
  } catch {
    return { ...empty, mode: "unreachable" };
  }
}
