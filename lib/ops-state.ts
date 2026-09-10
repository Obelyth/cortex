// The one place a state comes from. Pure: unit + latest run + latest ack + the clock in, a state
// out. Nothing here reads the network, and nothing else in the codebase may decide a state.
export type UnitKind = "routine" | "machine" | "agent" | "operator" | "item";
export type Owner = "manager" | "indexer" | "retrieval" | "none";
export type OpsState =
  | "scheduled" | "late" | "missed" | "running" | "succeeded" | "unverified" | "failed"
  | "crashed" | "needs_you" | "acknowledged" | "paused" | "seen" | "quiet";

export interface Unit {
  id: string; kind: UnitKind; name: string; owner: Owner;
  period_s: number | null; grace_s: number; max_run_s: number; pages: boolean; tolerance: number;
  paused_until: string | null; run_now: { kind: "dispatch" | "link"; target: string } | null; notes: string | null;
}
export interface Run {
  terminal_outcome?: "succeeded"|"unverified"|"failed"|"crashed"|"needs_you"|null;
  id: number; unit_id: string; run_key: string; trigger: string;
  scheduled_at: string | null; started_at: string | null; ended_at: string | null; lease_until: string | null;
  state: string; exit_reason: string | null; attempt: number; summary: string | null; error: string | null;
  evidence: string[]; cost: unknown; facts: Record<string, unknown> | null;
}
/** `at` is when the ack or snooze was pressed; it scopes the silence to the run it was pressed
 *  against, so a bare ack cannot mute a unit forever across every future run. */
export interface Ack { until: string | null; at: string }

const ms = (s: string | null | undefined): number | null => (s ? Date.parse(s) : null);

export function nextDue(unit: Unit, latest: Run | null): Date | null {
  if (unit.period_s == null) return null;
  const anchor = ms(latest?.ended_at) ?? ms(latest?.started_at);
  if (anchor == null) return null;
  return new Date(anchor + unit.period_s * 1000);
}

function finished(unit: Unit, r: Run): OpsState {
  if(r.terminal_outcome)return r.terminal_outcome;
  if (r.exit_reason === "question") return "needs_you";
  if (r.exit_reason === "code" || r.exit_reason === "timeout" || r.state === "failed") return "failed";
  if (r.exit_reason === "infra") return "crashed";
  return r.evidence.length > 0 ? "succeeded" : "unverified";
}

export function deriveState(unit: Unit, latest: Run | null, ack: Ack | null, now: Date, consecutiveFailures = 0): OpsState {
  const t = now.getTime();
  const pausedUntil = ms(unit.paused_until);
  if (pausedUntil != null && pausedUntil > t) return "paused";

  let raw: OpsState;
  if (unit.kind === "machine") {
    const seenAt = ms(latest?.ended_at) ?? ms(latest?.started_at);
    raw = seenAt != null && t - seenAt <= unit.grace_s * 1000 ? "seen" : "quiet";
  } else if (unit.kind === "item") {
    raw = latest && latest.ended_at ? finished(unit, latest) : "needs_you";
  } else if (!latest) {
    raw = "scheduled";
  } else if (latest.started_at && !latest.ended_at) {
    const lease = ms(latest.lease_until);
    raw = lease != null && lease >= t ? "running" : "crashed";
  } else if (latest.ended_at) {
    const bad = finished(unit, latest);
    const due = nextDue(unit, latest);
    if (bad === "succeeded" || bad === "unverified") {
      if (due && t >= due.getTime()) raw = t - due.getTime() <= unit.grace_s * 1000 ? "late" : "missed";
      else raw = bad;
    } else raw = bad;
  } else {
    raw = "scheduled";
  }

  const attention = raw === "failed" || raw === "crashed" || raw === "missed" || raw === "needs_you" || raw === "unverified";
  // An ack answers the run that was on screen when it was pressed. A run that started after it
  // has never been acknowledged, so the ack is spent — otherwise one bare ack silences a unit
  // for good. A unit with no run at all (an `item` like the console secret) keeps its ack.
  const started = ms(latest?.started_at);
  const ackAt = ms(ack?.at);
  const spent = started != null && ackAt != null && started > ackAt;
  if (attention && ack && !spent) {
    const until = ms(ack.until);
    if (until == null || until > t) return "acknowledged";
  }
  void consecutiveFailures;
  return raw;
}

export function isPageable(unit: Unit, state: OpsState, consecutiveFailures: number): boolean {
  if (!unit.pages || unit.kind === "machine") return false;
  if (state === "missed" || state === "crashed" || state === "needs_you") return true;
  if (state === "failed") return consecutiveFailures >= unit.tolerance;
  return false;
}
