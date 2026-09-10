// The five controls. Every one writes its receipt row before it does anything else that could
// fail, so the timeline never lacks the row for a thing that happened.
import type { OpsStore } from "./ops";
import type { Unit } from "./ops-state";

export type Action =
  | { action: "ack"; unit: string; note?: string }
  | { action: "snooze"; unit: string; hours: number }
  | { action: "pause"; unit: string; until: string }
  | { action: "resume"; unit: string }
  | { action: "run-now"; unit: string };

export function parseAction(b: Record<string, unknown>): Action | string {
  const unit = typeof b.unit === "string" ? b.unit : "";
  if (!unit) return "unit is required";
  switch (b.action) {
    case "ack": return { action: "ack", unit, note: typeof b.note === "string" ? b.note.slice(0, 280) : undefined };
    case "snooze": { const h = Number(b.hours); if (!Number.isFinite(h) || h < 1 || h > 168) return "hours must be 1–168"; return { action: "snooze", unit, hours: h }; }
    case "pause": { const t = typeof b.until === "string" ? Date.parse(b.until) : NaN; if (!Number.isFinite(t)) return "until must be an ISO date"; return { action: "pause", unit, until: new Date(t).toISOString().replace(".000Z", "Z") }; }
    case "resume": return { action: "resume", unit };
    case "run-now": return { action: "run-now", unit };
    default: return `unknown action "${String(b.action)}"`;
  }
}

type Dispatch = (target: string) => Promise<{ ok: boolean; status: number }>;
type Result = { ok: true; receipt: number | null; opened?: string } | { ok: false; status: 404 | 409 | 502; error: string; receipt?: number | null };

export async function applyAction(store: OpsStore, units: Unit[], a: Action, now: Date, dispatch: Dispatch): Promise<Result> {
  const unit = units.find((u) => u.id === a.unit);
  if (!unit) return { ok: false, status: 404, error: `unknown unit "${a.unit}"` };
  const at = now.toISOString();
  const ev = (kind: "ack" | "snooze" | "pause" | "resume" | "run_now", body: Record<string, unknown>) => store.appendEvent({ unit_id: unit.id, run_id: null, at, actor: "console", kind, body });

  if (a.action === "ack") { const e = await ev("ack", { note: a.note ?? null, until: null }); return { ok: true, receipt: e.id ?? null }; }
  if (a.action === "snooze") { const until = new Date(now.getTime() + a.hours * 3_600_000).toISOString(); const e = await ev("snooze", { until, hours: a.hours }); return { ok: true, receipt: e.id ?? null }; }
  if (a.action === "pause") { const e = await ev("pause", { until: a.until }); await store.patchUnit(unit.id, { paused_until: a.until }); return { ok: true, receipt: e.id ?? null }; }
  if (a.action === "resume") { const e = await ev("resume", {}); await store.patchUnit(unit.id, { paused_until: null }); return { ok: true, receipt: e.id ?? null }; }
  // run-now
  if (!unit.run_now) return { ok: false, status: 409, error: `"${unit.name}" has no run target` };
  if (unit.run_now.kind === "link") { const e = await ev("run_now", { target: unit.run_now.target, opened: true }); return { ok: true, receipt: e.id ?? null, opened: unit.run_now.target }; }
  let res: { ok: boolean; status: number };
  try {
    res = await dispatch(unit.run_now.target);
  } catch {
    // A dispatcher that throws (a stalled fetch, a network error) is still an outcome — the
    // receipt must exist for it, so it's folded into the same "failed" shape rather than
    // reaching the caller as an exception with no ops_events row behind it.
    res = { ok: false, status: 0 };
  }
  const e = await ev("run_now", { target: unit.run_now.target, status: res.status });
  if (!res.ok) return { ok: false, status: 502, error: `dispatch ${unit.run_now.target} → ${res.status}`, receipt: e.id ?? null };
  return { ok: true, receipt: e.id ?? null };
}

/** repository_dispatch on the brain repo; a webhook trigger on the routine listens for event_type. */
export async function githubDispatch(target: string): Promise<{ ok: boolean; status: number }> {
  const repo = process.env.BRAIN_REPO; const token = process.env.GITHUB_TOKEN;
  if (!repo || !token) return { ok: false, status: 0 };
  try {
    const res = await fetch(`https://api.github.com/repos/${repo}/dispatches`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "Content-Type": "application/json", "User-Agent": "cortex-ops" },
      body: JSON.stringify({ event_type: target, client_payload: { source: "cortex-ops", at: new Date().toISOString() } }),
      signal: AbortSignal.timeout(8_000),
    });
    return { ok: res.status === 204, status: res.status };
  } catch {
    // The 8s AbortSignal timeout and any network failure surface as a thrown exception, not a
    // response — caller (applyAction) still needs an { ok, status } to receipt, never a throw.
    return { ok: false, status: 0 };
  }
}
