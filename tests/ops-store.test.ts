import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { opsStore, __setOpsStore, OpsHttpError } from "../lib/ops";

function fetchStub(routes: Array<[RegExp, (init?: RequestInit) => Response | Promise<Response>]>) {
  return vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
    const u = String(url);
    for (const [re, make] of routes) if (re.test(u)) return make(init);
    throw new Error(`unexpected fetch: ${u}`);
  });
}
const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status, headers: { "content-type": "application/json" } });

beforeEach(() => { vi.stubEnv("SUPABASE_URL", "https://x.supabase.co"); vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "k"); __setOpsStore(undefined); });
afterEach(() => { __setOpsStore(undefined); vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

describe("opsStore", () => {
  it("is null without env", () => { vi.stubEnv("SUPABASE_URL", ""); expect(opsStore()).toBeNull(); });

  it("listUnits GETs ops_units ordered by id", async () => {
    const f = fetchStub([[/ops_units\?select=\*&order=id\.asc$/, () => json([{ id: "gk", kind: "routine" }])]]);
    vi.stubGlobal("fetch", f);
    const units = await opsStore()!.listUnits();
    expect(units[0].id).toBe("gk");
    const [, init] = f.mock.calls[0];
    expect((init!.headers as Record<string, string>).apikey).toBe("k");
  });

  it("insertRun POSTs with return=representation and returns the row", async () => {
    vi.stubGlobal("fetch", fetchStub([[/ops_runs$/, (init) => { expect(init!.method).toBe("POST"); expect((init!.headers as Record<string, string>).Prefer).toBe("return=representation"); return json([{ id: 7, unit_id: "gk", run_key: "k" }]); }]]));
    const r = await opsStore()!.insertRun({ unit_id: "gk", run_key: "k", trigger: "cron", scheduled_at: null, started_at: null, ended_at: null, lease_until: null, state: "scheduled", exit_reason: null, attempt: 1, summary: null, error: null, evidence: [], cost: null, facts: null });
    expect(r.id).toBe(7);
  });

  it("latestRuns asks each unit for its own newest run, never one shared window", async () => {
    // One limit=1 query per unit: a 15-minute heartbeat writing all day can no longer push a
    // quiet unit's newest run out of a global scan and leave it reading as "never ran".
    const f = fetchStub([
      [/ops_runs\?select=\*&unit_id=eq\.gk&order=started_at\.desc\.nullslast&limit=1$/, () => json([{ id: 2, unit_id: "gk", started_at: "2026-09-02T09:19:00Z" }])],
      [/ops_runs\?select=\*&unit_id=eq\.canary&order=started_at\.desc\.nullslast&limit=1$/, () => json([{ id: 3, unit_id: "canary", started_at: null }])],
      [/ops_runs\?select=\*&unit_id=eq\.never&order=started_at\.desc\.nullslast&limit=1$/, () => json([])],
    ]);
    vi.stubGlobal("fetch", f);
    const m = await opsStore()!.latestRuns(["gk", "canary", "never"]);
    expect(m.get("gk")!.id).toBe(2); expect(m.get("canary")!.id).toBe(3);
    expect(m.has("never")).toBe(false);
    expect(f.mock.calls).toHaveLength(3);
  });

  it("latestRuns queries nothing for an empty unit list", async () => {
    vi.stubGlobal("fetch", fetchStub([]));
    expect((await opsStore()!.latestRuns([])).size).toBe(0);
  });

  it("latestEvent reads the newest event of a kind, optionally filtered by to_state", async () => {
    vi.stubGlobal("fetch", fetchStub([[/ops_events\?unit_id=eq\.gk&kind=eq\.alert_sent&order=at\.desc&limit=1$/, () => json([{ at: "2026-09-02T09:00:00Z", to_state: "crashed" }])]]));
    expect(await opsStore()!.latestEvent("gk", "alert_sent")).toEqual({ at: "2026-09-02T09:00:00Z", to_state: "crashed" });

    vi.stubGlobal("fetch", fetchStub([[/ops_events\?unit_id=eq\.gk&kind=eq\.transition&to_state=eq\.succeeded&order=at\.desc&limit=1$/, () => json([{ at: "2026-09-02T10:00:00Z", to_state: "succeeded" }])]]));
    expect(await opsStore()!.latestEvent("gk", "transition", "succeeded")).toEqual({ at: "2026-09-02T10:00:00Z", to_state: "succeeded" });

    vi.stubGlobal("fetch", fetchStub([[/ops_events\?unit_id=eq\.gk&kind=eq\.alert_sent&order=at\.desc&limit=1$/, () => json([])]]));
    expect(await opsStore()!.latestEvent("gk", "alert_sent")).toBeNull();
  });

  it("throws OpsHttpError with the status only, never the body", async () => {
    vi.stubGlobal("fetch", fetchStub([[/ops_events$/, () => new Response("secret body", { status: 500 })]]));
    await expect(opsStore()!.appendEvent({ unit_id: "gk", run_id: null, actor: "unit", kind: "start" })).rejects.toMatchObject({ status: 500 });
    await expect(opsStore()!.appendEvent({ unit_id: "gk", run_id: null, actor: "unit", kind: "start" })).rejects.not.toThrow(/secret body/);
  });

  it("consecutiveFailures reads the atomic terminal-outcome counter", async () => {
    vi.stubGlobal("fetch", fetchStub([[/ops_monitor\?unit_id=eq\.gk&select=failures&limit=1$/, () => json([{failures:2}])]]));
    expect(await opsStore()!.consecutiveFailures("gk")).toBe(2);
  });

  it("consecutiveFailures does not fall back to sweep transitions without the new counter", async () => {
    // failed ← running ← failed ← running: two failures on consecutive nights are two consecutive
    // failures. The `running` rows are the attempts starting, not outcomes that end the streak.
    vi.stubGlobal("fetch", fetchStub([[/ops_monitor\?unit_id=eq\.gk&select=failures&limit=1$/, () => json([])]]));
    await expect(opsStore()!.consecutiveFailures("gk")).rejects.toMatchObject({status:503});
  });

  it("consecutiveFailures stops at the last success", async () => {
    vi.stubGlobal("fetch", fetchStub([[/ops_monitor\?unit_id=eq\.gk&select=failures&limit=1$/, () => json([{failures:0}])]]));
    expect(await opsStore()!.consecutiveFailures("gk")).toBe(0);
  });
  it("fails closed when atomic report RPC is absent, never using table admission",async()=>{
    const f=fetchStub([[/rpc\/ops_report_atomic$/,()=>json({message:"private backend message"},404)]]);vi.stubGlobal("fetch",f);
    await expect(opsStore()!.reportAtomic!({unit:"gk",verb:"start",run_key:"same-key"},new Date())).rejects.toMatchObject({status:404});
    expect(f).toHaveBeenCalledTimes(1);
  });

  it("latestTransition reads the newest transition's to_state, or null when there is none", async () => {
    vi.stubGlobal("fetch", fetchStub([[/ops_events\?unit_id=eq\.gk&kind=eq\.transition&order=at\.desc&limit=1$/, () => json([{ to_state: "needs_you" }])]]));
    expect(await opsStore()!.latestTransition("gk")).toEqual({ to_state: "needs_you" });

    vi.stubGlobal("fetch", fetchStub([[/ops_events\?unit_id=eq\.gk&kind=eq\.transition&order=at\.desc&limit=1$/, () => json([])]]));
    expect(await opsStore()!.latestTransition("gk")).toBeNull();
  });

  it("latestAck reads the newest ack or snooze, with the time it was pressed", async () => {
    vi.stubGlobal("fetch", fetchStub([[/ops_events\?unit_id=eq\.gk&kind=in\.\(ack,snooze\)&order=at\.desc&limit=1$/, () => json([{ kind: "snooze", at: "2026-09-02T09:00:00Z", body: { until: "2026-09-03T00:00:00Z" } }])]]));
    expect(await opsStore()!.latestAck("gk")).toEqual({ until: "2026-09-03T00:00:00Z", at: "2026-09-02T09:00:00Z" });
  });

  it("findRun GETs ops_runs with encoded unit_id and run_key, returns first row or null", async () => {
    vi.stubGlobal("fetch", fetchStub([[/ops_runs\?unit_id=eq\.gk%2Fapp&run_key=eq\.key%20with%20space&limit=1$/, () => json([{ id: 5, unit_id: "gk/app", run_key: "key with space" }])]]));
    const r = await opsStore()!.findRun("gk/app", "key with space");
    expect(r?.id).toBe(5);

    vi.stubGlobal("fetch", fetchStub([[/ops_runs\?unit_id=eq\.unknown&run_key=eq\.nope&limit=1$/, () => json([])]]));
    const nothing = await opsStore()!.findRun("unknown", "nope");
    expect(nothing).toBeNull();
  });

  it("patchRun PATCHes ops_runs with return=representation and sets updated_at ISO string", async () => {
    vi.stubGlobal("fetch", fetchStub([[/ops_runs\?id=eq\.42$/, (init) => {
      expect(init!.method).toBe("PATCH");
      expect((init!.headers as Record<string, string>).Prefer).toBe("return=representation");
      const body = JSON.parse(init!.body as string);
      expect(typeof body.updated_at).toBe("string");
      expect(Number.isFinite(Date.parse(body.updated_at))).toBe(true);
      return json([{ id: 42, unit_id: "gk", state: "running", updated_at: body.updated_at }]);
    }]]));
    const r = await opsStore()!.patchRun(42, { state: "running" });
    expect(r.id).toBe(42);
  });

  it("patchUnit PATCHes ops_units with encoded id and returns representation", async () => {
    vi.stubGlobal("fetch", fetchStub([[/ops_units\?id=eq\.gk%2Fapp$/, (init) => {
      expect(init!.method).toBe("PATCH");
      expect((init!.headers as Record<string, string>).Prefer).toBe("return=representation");
      return json([{ id: "gk/app", kind: "routine", paused_until: "2026-09-03T00:00:00Z" }]);
    }]]));
    const u = await opsStore()!.patchUnit("gk/app", { paused_until: "2026-09-03T00:00:00Z" });
    expect(u.id).toBe("gk/app");
  });

  it("listEvents GETs ops_events with encoded since, default limit 200, and no heartbeats", async () => {
    vi.stubGlobal("fetch", fetchStub([[/ops_events\?at=gte\.2026-09-01T00%3A00%3A00Z&kind=neq\.heartbeat&order=at\.desc&limit=200$/, () => json([{ id: 1, unit_id: "gk", kind: "start" }])]]));
    const events = await opsStore()!.listEvents("2026-09-01T00:00:00Z");
    expect(events[0].id).toBe(1);

    vi.stubGlobal("fetch", fetchStub([[/ops_events\?at=gte\.2026-09-01T00%3A00%3A00Z&kind=neq\.heartbeat&order=at\.desc&limit=50$/, () => json([{ id: 2, unit_id: "gk", kind: "start" }])]]));
    const limited = await opsStore()!.listEvents("2026-09-01T00:00:00Z", 50);
    expect(limited[0].id).toBe(2);
  });

  it("listEvents includes heartbeats only when asked", async () => {
    vi.stubGlobal("fetch", fetchStub([[/ops_events\?at=gte\.2026-09-01T00%3A00%3A00Z&order=at\.desc&limit=200$/, () => json([{ id: 3, unit_id: "workstation-test", kind: "heartbeat" }])]]));
    const all = await opsStore()!.listEvents("2026-09-01T00:00:00Z", 200, { includeHeartbeats: true });
    expect(all[0].kind).toBe("heartbeat");
  });

  it("one() throws OpsHttpError(500) when mutating call returns empty representation", async () => {
    vi.stubGlobal("fetch", fetchStub([[/ops_runs$/, (init) => { expect(init!.method).toBe("POST"); return json([]); }]]));
    await expect(opsStore()!.insertRun({ unit_id: "gk", run_key: "k", trigger: "cron", scheduled_at: null, started_at: null, ended_at: null, lease_until: null, state: "scheduled", exit_reason: null, attempt: 1, summary: null, error: null, evidence: [], cost: null, facts: null })).rejects.toMatchObject({ status: 500 });
  });
});
