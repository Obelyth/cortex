import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { runSweep } from "../lib/sweep";
import { __setOpsStore, type OpsStore, type OpsEvent } from "../lib/ops";
import type { Run, Unit } from "../lib/ops-state";
import { __setMailer, type Mailer } from "../lib/mail";
import { GET } from "../app/api/ops/sweep/route";
import {withAtomic,testEnvelope} from "./ops-test-store";

const T0 = new Date("2026-09-02T09:17:00Z");
const min = (n: number) => new Date(T0.getTime() + n * 60_000);
const gk: Unit = { id: "groundskeeper", kind: "routine", name: "Brain groundskeeper", owner: "manager", period_s: 86400, grace_s: 1800, max_run_s: 1200, pages: true, tolerance: 1, paused_until: null, run_now: null, notes: null };
const rog: Unit = { ...gk, id: "workstation-test", name: "Test workstation", kind: "machine", period_s: 900, pages: false };

/**
 * The double keeps the events array the sweep writes into and answers every "what happened
 * before" query off it — the same way the real store does. Nothing here reads `run.state`:
 * that column carries the state ingest derived from the unit's own report, and using it as the
 * sweep's baseline is exactly the defect this suite now guards against.
 *
 * `priors` seeds transitions that predate the test (a sweep that already ran) without putting
 * rows in `events`, so assertions counting newly appended events stay readable.
 */
function store(runs: Run[], events: OpsEvent[] = [], units: Unit[] = [gk, rog], priors: Record<string, string> = { "workstation-test": "quiet" }, fails = 0): OpsStore & { events: OpsEvent[] } {
  const seeded: OpsEvent[] = Object.entries(priors).map(([unit_id, to_state]) => ({ unit_id, run_id: null, at: new Date(T0.getTime() - 3_600_000).toISOString(), actor: "sweep", kind: "transition", to_state }));
  const all = () => [...seeded, ...events];
  const newest = (unitId: string, kind: OpsEvent["kind"], toState?: string) =>
    all().filter((e) => e.unit_id === unitId && e.kind === kind && (toState === undefined || e.to_state === toState))
      .sort((a, b) => Date.parse(b.at ?? "") - Date.parse(a.at ?? ""))[0] ?? null;
  return withAtomic({
    events,
    listUnits: async () => units,
    latestRuns: async (ids) => { const m = new Map<string, Run>(); for (const r of runs) if (ids.includes(r.unit_id)) m.set(r.unit_id, r); return m; },
    findRun: async () => null, insertRun: async (r) => ({ ...r, id: 1 }) as Run,
    patchRun: async (id, p) => { const r = runs.find((x) => x.id === id)!; Object.assign(r, p); return r; },
    patchUnit: async () => gk,
    appendEvent: async (e) => { events.push(e); return e; },
    listEvents: async () => events,
    latestAck: async () => null,
    consecutiveFailures: async () => fails,
    latestEvent: async (unitId, kind, toState) => { const e = newest(unitId, kind, toState); return e ? { at: e.at ?? "", to_state: e.to_state ?? null } : null; },
    latestTransition: async (unitId) => { const e = newest(unitId, "transition"); return e?.to_state ? { to_state: e.to_state } : null; },
  },units,runs,events);
}
const running = (): Run => ({ id: 1, unit_id: "groundskeeper", run_key: "k", trigger: "cron", scheduled_at: null, started_at: min(-30).toISOString(), ended_at: null, lease_until: min(-10).toISOString(), state: "running", exit_reason: null, attempt: 1, summary: null, error: null, evidence: [], cost: null, facts: null });
function recorder(fail = false): Mailer & { sent: string[]; bodies: string[] } {
  const sent: string[] = []; const bodies: string[] = [];
  return { sent, bodies,envelope:testEnvelope, send: async (s, b) => { sent.push(s); bodies.push(b); return fail ? { ok: false, status: 502, error: "resend 502" } : { ok: true, id: "m" }; } };
}
/** The baseline a previous sweep would have left behind, seeded without touching `events`. */
const after = (state: string, unit = "groundskeeper") => ({ "workstation-test": "quiet", [unit]: state });

describe("runSweep", () => {
  it("turns a lapsed lease into crashed, writes the transition, pages once", async () => {
    const s = store([running()], [], [gk, rog], after("running")); const m = recorder();
    const r = await runSweep(s, m, T0, "https://cortex.test/s/x/console/ops");
    expect(r.transitions).toEqual([{ unit: "groundskeeper", from: "running", to: "crashed" }]);
    expect(s.events.filter((e) => e.kind === "transition")).toHaveLength(1);
    expect(m.sent).toEqual(["CORTEX OPS: Brain groundskeeper running → crashed"]);
    expect(s.events.at(-1)).toMatchObject({ kind: "alert_sent", body: { id: "m" } });
    // second sweep: state unchanged → no new transition, no second mail
    const r2 = await runSweep(s, m, min(15), "https://cortex.test/s/x/console/ops");
    expect(r2.transitions).toEqual([]); expect(m.sent).toHaveLength(1);
  });
  it("records alert_failed when the mail bounces and still stores the transition", async () => {
    const s = store([running()], [], [gk, rog], after("running")); const m = recorder(true);
    const r = await runSweep(s, m, T0, "https://x");
    expect(r.mailFailed).toEqual(["groundskeeper"]);
    expect(s.events.at(-1)).toMatchObject({ kind: "alert_failed", body: { status: 502 } });
  });
  it("machines go quiet without a mail", async () => {
    const hb: Run = { ...running(), id: 2, unit_id: "workstation-test", trigger: "heartbeat", started_at: min(-40).toISOString(), ended_at: min(-40).toISOString(), lease_until: null, state: "seen" };
    const s = store([hb], [], [gk, rog], { "workstation-test": "seen" }); const m = recorder();
    const r = await runSweep(s, m, T0, "https://x");
    expect(r.transitions).toEqual([{ unit: "workstation-test", from: "seen", to: "quiet" }]);
    expect(m.sent).toEqual([]);
  });
  it("works with no mailer: transitions recorded, paged empty, nothing thrown", async () => {
    const s = store([running()], [], [gk, rog], after("running"));
    const r = await runSweep(s, null, T0, "https://x");
    expect(r.transitions).toHaveLength(1); expect(r.paged).toEqual([]);
  });
  it("sends one recovery mail when a paged unit succeeds again, and only one", async () => {
    const r1 = running(); const s = store([r1], [], [gk, rog], after("running")); const m = recorder();
    await runSweep(s, m, T0, "https://x");                       // running → crashed → paged
    // The finish ingest would write: ended, lease dropped, evidence, and state "succeeded" —
    // the state column carries what ingest derived, which is why the sweep must not read it.
    Object.assign(r1, { ended_at: min(20).toISOString(), lease_until: null, evidence: ["sha"], state: "succeeded", exit_reason: null });
    const r = await runSweep(s, m, min(21), "https://x");
    expect(r.transitions).toEqual([{ unit: "groundskeeper", from: "crashed", to: "succeeded" }]);
    expect(m.sent[1]).toBe("CORTEX OPS: Brain groundskeeper crashed → succeeded");
    // a later sweep has nothing new to say, and the recovery is already answered
    const r3 = await runSweep(s, m, min(40), "https://x");
    expect(r3.transitions).toEqual([]); expect(m.sent).toHaveLength(2);
  });
  it("transitions and pages a self-reported failure — the state column is never the baseline", async () => {
    // Ingest wrote state "failed" on the run itself. Reading that column as the prior state
    // would compare failed to failed, transition nothing and page no one: the Critical defect.
    const failed: Run = { ...running(), ended_at: min(-5).toISOString(), lease_until: null, state: "failed", exit_reason: "code", error: "exit 1" };
    // fails=1 is the ledger's own count of trailing failed transitions, i.e. gk's tolerance of 1
    // is already spent when this pass runs; the page is then owed on the transition.
    const s = store([failed], [], [gk, rog], after("running"), 1); const m = recorder();
    const r = await runSweep(s, m, T0, "https://x");
    expect(r.transitions).toEqual([{ unit: "groundskeeper", from: "running", to: "failed" }]);
    expect(m.sent).toEqual(["CORTEX OPS: Brain groundskeeper running → failed"]);
    expect(m.bodies[0]).toContain("Error: exit 1");
  });
  it("does not send a recovery mail when the last page was already answered by a success", async () => {
    // alert_sent at T-2h, a succeeded transition at T-1h: that page is spent. The unit dips to
    // late and comes back — a schedule wobble no one was paged about owes no recovery mail.
    const done: Run = { ...running(), started_at: min(-30).toISOString(), ended_at: min(-20).toISOString(), lease_until: null, state: "succeeded", evidence: ["sha"] };
    const history: OpsEvent[] = [
      { unit_id: "groundskeeper", run_id: null, at: min(-120).toISOString(), actor: "sweep", kind: "alert_sent", to_state: "missed" },
      { unit_id: "groundskeeper", run_id: null, at: min(-90).toISOString(), actor: "sweep", kind: "alert_sent", to_state: "succeeded" },
      { unit_id: "groundskeeper", run_id: null, at: min(-45).toISOString(), actor: "sweep", kind: "transition", to_state: "late" },
    ];
    const s = store([done], history, [gk, rog]); const m = recorder();
    const r = await runSweep(s, m, T0, "https://x");
    expect(r.transitions).toEqual([{ unit: "groundskeeper", from: "late", to: "succeeded" }]);
    expect(m.sent).toEqual([]);
  });
  it("pages a run-less item unit once, then uses the recorded transition as the baseline", async () => {
    const cs: Unit = { ...gk, id: "console-secret", kind: "item", name: "Console secret", pages: true };
    const s = store([], [], [cs]); const m = recorder();
    const r1 = await runSweep(s, m, T0, "https://x");
    expect(r1.transitions).toEqual([{ unit: "console-secret", from: "scheduled", to: "needs_you" }]);
    expect(m.sent).toEqual(["CORTEX OPS: Console secret scheduled → needs_you"]);
    // second sweep: still no run, but the transition event just written is now the baseline
    const r2 = await runSweep(s, m, min(15), "https://x");
    expect(r2.transitions).toEqual([]);
    expect(m.sent).toHaveLength(1);
  });
  it("never sends a recovery mail for a unit that doesn't page, even after a paged-style crash", async () => {
    const silent: Unit = { ...gk, id: "silent-routine", name: "Silent routine", pages: false };
    const r1 = running(); r1.unit_id = "silent-routine";
    const s = store([r1], [], [silent], { "silent-routine": "running" }); const m = recorder();
    await runSweep(s, m, T0, "https://x"); // running → crashed, but pages:false → no mail
    expect(m.sent).toEqual([]);
    Object.assign(r1, { ended_at: min(20).toISOString(), lease_until: null, evidence: ["sha"], state: "succeeded", exit_reason: null });
    const r = await runSweep(s, m, min(21), "https://x");
    expect(r.transitions).toEqual([{ unit: "silent-routine", from: "crashed", to: "succeeded" }]);
    expect(m.sent).toEqual([]); // recovery must not bypass unit.pages
  });
});

describe("GET /api/ops/sweep", () => {
  beforeEach(() => { vi.stubEnv("CRON_SECRET", "c".repeat(32)); __setOpsStore(store([])); __setMailer(null); });
  afterEach(() => { __setOpsStore(undefined); __setMailer(undefined); vi.unstubAllEnvs(); });
  const req = (auth?: string) => new Request("https://cortex.test/api/ops/sweep", { headers: auth ? { authorization: auth } : {} });
  it("is an empty 404 without the cron bearer", async () => { const r = await GET(req()); expect(r.status).toBe(404); expect(await r.text()).toBe(""); });
  it("runs and reports", async () => { const r = await GET(req(`Bearer ${"c".repeat(32)}`)); expect(r.status).toBe(200); expect(await r.json()).toMatchObject({ checked: 2, transitions: [] }); });
  it("is 503 without a store", async () => { __setOpsStore(null); expect((await GET(req(`Bearer ${"c".repeat(32)}`))).status).toBe(503); });
  it("links the mail to the bare origin — the console secret never rides in an alert", async () => {
    vi.stubEnv("CONNECTOR_PATH_SECRET", "s".repeat(64));
    const m = recorder();
    __setOpsStore(store([running()], [], [gk, rog], after("running")));
    __setMailer(m);
    expect((await GET(req(`Bearer ${"c".repeat(32)}`))).status).toBe(200);
    expect(m.bodies).toHaveLength(1);
    expect(m.bodies[0]).toContain("https://cortex.test/#groundskeeper");
    expect(m.bodies[0]).not.toContain("s".repeat(64));
    expect(m.bodies[0]).not.toContain("/console/ops");
  });
});
