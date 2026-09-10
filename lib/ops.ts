// The ops ledger's store. Raw PostgREST over fetch with the service-role key, exactly like
// lib/bubble.ts: status-only errors, a per-request timeout, an injection seam for tests.
import type { Run, Unit, OpsState } from "./ops-state";
import type {Report,ReportResult} from "./ops-report";
import type {MailEnvelope,MailResult} from "./mail";

export interface OpsSnapshot {
  token:string; unit:Unit; run:Run|null;owed_run?:Run|null; ack:{at:string;until:string|null}|null;
  monitor:{failures:number;visual:string;accepted_alert:number;recovered_alert:number;owed?:{kind:"alert"|"recovery";run_id:number|null;from:string;to:OpsState;at:string;target:number}|null};
}
export interface AlertClaim {
  state:"sending"|"terminal"|"unavailable";unit_id:string;id?:number;claim_token?:string;
  subject?:string;body?:string;provider_key?:string;envelope?:MailEnvelope;first_claim_at?:string;lease_until?:string;
}

export interface OpsEvent {
  id?: number; unit_id: string; run_id: number | null; at?: string;
  actor: "unit" | "sweep" | "operator" | "guest" | "console";
  kind: "start" | "finish" | "heartbeat" | "transition" | "ack" | "snooze" | "pause" | "resume" | "run_now" | "alert_sent" | "alert_failed" | "read";
  from_state?: string | null; to_state?: string | null; body?: Record<string, unknown>;
}
export interface OpsStore {
  /** Required for mutation paths. Optional only for read-only/test adapters; never fallback. */
  reportAtomic?(report:Report,now:Date):Promise<ReportResult>;
  sweepSnapshot?(unitId:string):Promise<OpsSnapshot|null>;
  recordSweep?(unitId:string,token:string,state:string,alert:{kind:"alert"|"recovery";subject:string;text:string}|null,now:Date):Promise<{state:"recorded"|"conflict"|"capacity"|"missing";transition?:boolean}>;
  claimAlert?(now:Date,envelope:MailEnvelope|null):Promise<AlertClaim|null>;
  completeAlert?(id:number,token:string,result:MailResult,now:Date):Promise<string>;
  deliveryStatus?(unitId:string):Promise<string|null>;
  listUnits(): Promise<Unit[]>;
  /** One `limit=1` query per unit, never a global scan: a chatty unit (the 15-minute heartbeat)
   *  must not be able to push a quiet unit's newest run off the end of a shared window. */
  latestRuns(unitIds: string[]): Promise<Map<string, Run>>;
  findRun(unitId: string, runKey: string): Promise<Run | null>;
  insertRun(r: Omit<Run, "id">): Promise<Run>;
  patchRun(id: number, patch: Partial<Run>): Promise<Run>;
  patchUnit(id: string, patch: Partial<Unit>): Promise<Unit>;
  appendEvent(e: OpsEvent): Promise<OpsEvent>;
  /** Heartbeats are excluded by default — they are the loudest kind and the least worth reading;
   *  the timeline and the notices tray both want the events a person would act on. */
  listEvents(sinceIso: string, limit?: number, opts?: { includeHeartbeats?: boolean }): Promise<OpsEvent[]>;
  latestAck(unitId: string): Promise<{ until: string | null; at: string } | null>;
  consecutiveFailures(unitId: string): Promise<number>;
  /** The newest event of one kind, optionally filtered by state. Delivery coordination uses
   *  the atomic monitor/outbox RPCs, never a comparison with a visual transition. */
  latestEvent(unitId: string, kind: OpsEvent["kind"], toState?: string): Promise<{ at: string; to_state: string | null } | null>;
  latestTransition(unitId: string): Promise<{ to_state: string } | null>;
}
export class OpsHttpError extends Error {
  constructor(public readonly status: number, what: string) { super(`ops: ${what} ${status}`); }
}

const TIMEOUT_MS = 8_000;
let override: OpsStore | null | undefined;
export function __setOpsStore(s: OpsStore | null | undefined): void { override = s; }

export function opsStore(): OpsStore | null {
  if (override !== undefined) return override;
  const base = process.env.SUPABASE_URL?.replace(/\/$/, "");
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!base || !key) return null;

  async function call<T>(path: string, init: RequestInit = {}): Promise<T> {
    const res = await fetch(`${base}/rest/v1/${path}`, {
      ...init,
      headers: { apikey: key!, Authorization: `Bearer ${key}`, "Content-Type": "application/json", ...(init.headers ?? {}) },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) throw new OpsHttpError(res.status, `${init.method ?? "GET"} ${path.split("?")[0]}`);
    if (res.status === 204) return undefined as T;
    return (await res.json()) as T;
  }
  const one = <T,>(rows: T[]): T => { if (!rows[0]) throw new OpsHttpError(500, "empty representation"); return rows[0]; };
  const latestEvent = async (unitId: string, kind: OpsEvent["kind"], toState?: string) => {
    const filter = toState ? `&to_state=eq.${encodeURIComponent(toState)}` : "";
    const rows = await call<OpsEvent[]>(`ops_events?unit_id=eq.${encodeURIComponent(unitId)}&kind=eq.${encodeURIComponent(kind)}${filter}&order=at.desc&limit=1`);
    const e = rows[0]; if (!e) return null;
    return { at: e.at ?? "", to_state: e.to_state ?? null };
  };

  return {
    reportAtomic:(report,now)=>call("rpc/ops_report_atomic",{method:"POST",body:JSON.stringify({report,observed_at:now.toISOString()})}),
    sweepSnapshot:(unitId)=>call("rpc/ops_sweep_snapshot",{method:"POST",body:JSON.stringify({unit_id:unitId})}),
    recordSweep:(unitId,token,state,alert,now)=>call("rpc/ops_sweep_record",{method:"POST",body:JSON.stringify({unit_id:unitId,expected_token:token,visual_state:state,alert,observed_at:now.toISOString()})}),
    claimAlert:(now,envelope)=>call("rpc/ops_alert_claim",{method:"POST",body:JSON.stringify({observed_at:now.toISOString(),envelope})}),
    completeAlert:(id,token,result,now)=>call("rpc/ops_alert_complete",{method:"POST",body:JSON.stringify({alert_id:id,token,result,observed_at:now.toISOString()})}),
    deliveryStatus:(unitId)=>call("rpc/ops_delivery_status",{method:"POST",body:JSON.stringify({unit_id:unitId})}),
    listUnits: () => call<Unit[]>("ops_units?select=*&order=id.asc"),
    async latestRuns(unitIds) {
      const m = new Map<string, Run>();
      await Promise.all(unitIds.map(async (id) => {
        const rows = await call<Run[]>(`ops_runs?select=*&unit_id=eq.${encodeURIComponent(id)}&order=started_at.desc.nullslast&limit=1`);
        if (rows[0]) m.set(id, rows[0]);
      }));
      return m;
    },
    async findRun(unitId, runKey) {
      const rows = await call<Run[]>(`ops_runs?unit_id=eq.${encodeURIComponent(unitId)}&run_key=eq.${encodeURIComponent(runKey)}&limit=1`);
      return rows[0] ?? null;
    },
    insertRun: (r) => call<Run[]>("ops_runs", { method: "POST", headers: { Prefer: "return=representation" }, body: JSON.stringify([r]) }).then(one),
    patchRun: (id, patch) => call<Run[]>(`ops_runs?id=eq.${id}`, { method: "PATCH", headers: { Prefer: "return=representation" }, body: JSON.stringify({ ...patch, updated_at: new Date().toISOString() }) }).then(one),
    patchUnit: (id, patch) => call<Unit[]>(`ops_units?id=eq.${encodeURIComponent(id)}`, { method: "PATCH", headers: { Prefer: "return=representation" }, body: JSON.stringify(patch) }).then(one),
    appendEvent: (e) => call<OpsEvent[]>("ops_events", { method: "POST", headers: { Prefer: "return=representation" }, body: JSON.stringify([e]) }).then(one),
    listEvents: (sinceIso, limit = 200, opts) => call<OpsEvent[]>(`ops_events?at=gte.${encodeURIComponent(sinceIso)}${opts?.includeHeartbeats ? "" : "&kind=neq.heartbeat"}&order=at.desc&limit=${limit}`),
    async latestAck(unitId) {
      const rows = await call<OpsEvent[]>(`ops_events?unit_id=eq.${encodeURIComponent(unitId)}&kind=in.(ack,snooze)&order=at.desc&limit=1`);
      const e = rows[0]; if (!e) return null;
      const until = typeof e.body?.until === "string" ? e.body.until : null;
      // `at` is what scopes the ack to the run it was pressed against (lib/ops-state.ts): an ack
      // older than the current run's start is history, not a standing silence.
      return { until, at: e.at ?? "" };
    },
    async consecutiveFailures(unitId) {
      const rows=await call<{failures:number}[]>(`ops_monitor?unit_id=eq.${encodeURIComponent(unitId)}&select=failures&limit=1`);
      if(!rows[0])throw new OpsHttpError(503,"outcome counter unavailable");
      return rows[0].failures;
    },
    latestEvent,
    async latestTransition(unitId) {
      const e = await latestEvent(unitId, "transition");
      return e?.to_state ? { to_state: e.to_state } : null;
    },
  };
}
