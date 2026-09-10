import { describe, it, expect } from "vitest";
import { applyReport } from "../lib/ops-report";
import { runSweep } from "../lib/sweep";
import type { OpsStore, OpsEvent } from "../lib/ops";
import type { Run, Unit } from "../lib/ops-state";
import type { Mailer } from "../lib/mail";
import {withAtomic,testEnvelope} from "./ops-test-store";

/**
 * Ingest and the sweep against ONE store, the way production has them: `applyReport` writes the
 * run and its derived state, then `runSweep` reads the ledger back and decides what moved and
 * who gets mail. The two were only ever tested apart, which is how the sweep came to read
 * `run.state` — the column ingest had just written — as "the state before this pass". Nothing
 * below stubs a baseline: every `from` here is a transition event an earlier sweep wrote.
 */

const T0 = new Date("2026-09-02T09:00:00Z");
const min = (n: number) => new Date(T0.getTime() + n * 60_000);
// tolerance 1, the value both routines are seeded with: page on the first failure.
const gk: Unit = { id: "groundskeeper", kind: "routine", name: "Brain groundskeeper", owner: "manager", period_s: 86400, grace_s: 1800, max_run_s: 1200, pages: true, tolerance: 1, paused_until: null, run_now: null, notes: null };
const flaky: Unit = { ...gk, id: "flaky", name: "Flaky routine", tolerance: 2 };

function ledger(units: Unit[] = [gk]): OpsStore & { runs: Run[]; events: OpsEvent[] } {
  const runs: Run[] = []; const events: OpsEvent[] = []; let nextId = 100;
  const newest = (unitId: string, kind: OpsEvent["kind"], toState?: string) =>
    events.filter((e) => e.unit_id === unitId && e.kind === kind && (toState === undefined || e.to_state === toState))
      .sort((a, b) => Date.parse(b.at ?? "") - Date.parse(a.at ?? ""))[0] ?? null;
  return withAtomic({
    runs, events,
    listUnits: async () => units,
    latestRuns: async (ids) => { const m = new Map<string, Run>(); for (const r of [...runs].reverse()) if (ids.includes(r.unit_id) && !m.has(r.unit_id)) m.set(r.unit_id, r); return m; },
    findRun: async (u, k) => runs.find((r) => r.unit_id === u && r.run_key === k) ?? null,
    insertRun: async (r) => { const row = { ...r, id: nextId++ } as Run; runs.push(row); return row; },
    patchRun: async (id, p) => { const i = runs.findIndex((r) => r.id === id); runs[i] = { ...runs[i], ...p }; return runs[i]; },
    patchUnit: async () => units[0],
    appendEvent: async (e) => { const row = { ...e, id: nextId++ }; events.push(row); return row; },
    listEvents: async () => events,
    latestAck: async () => null,
    // The real query: trailing `failed` transitions, newest first, skipping the `running` ones
    // (the next attempt starting is not an outcome).
    consecutiveFailures: async (unitId) => {
      let n = 0;
      for (const e of events.filter((x) => x.unit_id === unitId && x.kind === "transition").sort((a, b) => Date.parse(b.at ?? "") - Date.parse(a.at ?? ""))) {
        if (e.to_state === "failed") n++; else if (e.to_state === "running") continue; else break;
      }
      return n;
    },
    latestEvent: async (unitId, kind, toState) => { const e = newest(unitId, kind, toState); return e ? { at: e.at ?? "", to_state: e.to_state ?? null } : null; },
    latestTransition: async (unitId) => { const e = newest(unitId, "transition"); return e?.to_state ? { to_state: e.to_state } : null; },
  },units,runs,events);
}
function recorder(): Mailer & { sent: string[] } {
  const sent: string[] = [];
  return { sent,envelope:testEnvelope, send: async (s) => { sent.push(s); return { ok: true, id: `m${sent.length}` }; } };
}
const report = (store: OpsStore, r: Parameters<typeof applyReport>[2], at: Date, units: Unit[] = [gk]) => applyReport(store, units, r, at);

describe("ingest → sweep, one ledger", () => {
  it("admits only one overlapping start for different keys",async()=>{
    const s=ledger();
    const results=await Promise.all(["a","b"].map(run_key=>report(s,{unit:gk.id,verb:"start",run_key},min(0))));
    expect(results.filter(r=>r.ok)).toHaveLength(1);
    expect(results.find(r=>!r.ok)).toMatchObject({status:409});
    expect(s.events.filter(e=>e.kind==="start")).toHaveLength(1);
  });
  it("fences a worker after its expired lease has been replaced",async()=>{
    const s=ledger();
    await report(s,{unit:gk.id,verb:"start",run_key:"old"},min(0));
    await report(s,{unit:gk.id,verb:"start",run_key:"new"},min(30));
    expect(await report(s,{unit:gk.id,verb:"heartbeat",run_key:"old"},min(31))).toMatchObject({ok:false,status:409});
    expect(await report(s,{unit:gk.id,verb:"finish",run_key:"old",ok:true,evidence:["synthetic"]},min(32))).toMatchObject({ok:false,status:409});
    expect(s.runs.find(r=>r.run_key==="new")?.ended_at).toBeNull();
  });
  it("counts distinct failures even when the sweep never sees a running transition",async()=>{
    const s=ledger([flaky]),m=recorder();
    for(const [i,key] of ["first","second"].entries()) {
      await report(s,{unit:flaky.id,verb:"start",run_key:key},min(i*30),[flaky]);
      await report(s,{unit:flaky.id,verb:"finish",run_key:key,ok:false},min(i*30+1),[flaky]);
      await runSweep(s,m,min(i*30+2),"https://synthetic.invalid/");
    }
    expect(await s.consecutiveFailures(flaky.id)).toBe(2);
    expect(m.sent).toHaveLength(1);
    await runSweep(s,m,min(35),"https://synthetic.invalid/");
    expect(m.sent).toHaveLength(1);
  });
  it("retries failed transport on an unchanged state and stops after acceptance",async()=>{
    const s=ledger();let attempts=0;
    const m:Mailer={envelope:testEnvelope,send:async()=>++attempts===1?{ok:false,status:502,error:"resend 502"}:{ok:true,id:"accepted"}};
    await report(s,{unit:gk.id,verb:"start",run_key:"failure"},min(0));
    await report(s,{unit:gk.id,verb:"finish",run_key:"failure",ok:false},min(1));
    await runSweep(s,m,min(2),"https://synthetic.invalid/");
    await runSweep(s,m,min(17),"https://synthetic.invalid/");
    await runSweep(s,m,min(32),"https://synthetic.invalid/");
    expect(attempts).toBe(2);
    expect(s.events.filter(e=>e.kind==="alert_sent")).toHaveLength(1);
  });
  it("a failing run transitions and pages exactly once, then the recovery pages exactly once", async () => {
    const s = ledger(); const m = recorder();

    // (a) start → sweep: the unit is running, and running is not news anyone gets mailed about.
    await report(s, { unit: "groundskeeper", verb: "start", run_key: "d1" }, min(0));
    const a = await runSweep(s, m, min(1), "https://cortex.test/");
    expect(a.transitions).toEqual([{ unit: "groundskeeper", from: "scheduled", to: "running" }]);
    expect(m.sent).toEqual([]);

    // finish ok:false → the run's state column now reads "failed" (ingest derived it). The sweep
    // must still see running → failed, because its baseline is the transition it wrote above.
    await report(s, { unit: "groundskeeper", verb: "finish", run_key: "d1", ok: false, error: "exit 1" }, min(5));
    expect(s.runs[0].state).toBe("failed");
    const b = await runSweep(s, m, min(6), "https://cortex.test/");
    expect(b.transitions).toEqual([{ unit: "groundskeeper", from: "running", to: "failed" }]);
    // tolerance 1: the failure being written IS the first consecutive failure, so it pages now.
    expect(m.sent).toEqual(["CORTEX OPS: Brain groundskeeper running → failed"]);

    // a third pass has nothing new: the state has not moved, so nobody is paged twice
    const c = await runSweep(s, m, min(20), "https://cortex.test/");
    expect(c.transitions).toEqual([]);
    expect(m.sent).toHaveLength(1);

    // (b) the next night's run starts and succeeds with evidence
    await report(s, { unit: "groundskeeper", verb: "start", run_key: "d2" }, min(30));
    const d = await runSweep(s, m, min(31), "https://cortex.test/");
    expect(d.transitions).toEqual([{ unit: "groundskeeper", from: "failed", to: "running" }]);
    expect(m.sent).toHaveLength(1); // a start is not a recovery

    await report(s, { unit: "groundskeeper", verb: "finish", run_key: "d2", ok: true, summary: "ok", evidence: ["https://github.com/example-owner/brain/commit/abcdef12"] }, min(36));
    const e = await runSweep(s, m, min(37), "https://cortex.test/");
    expect(e.transitions).toEqual([{ unit: "groundskeeper", from: "running", to: "succeeded" }]);
    expect(m.sent).toEqual(["CORTEX OPS: Brain groundskeeper running → failed", "CORTEX OPS: Brain groundskeeper running → succeeded"]);

    // and the recovery is answered: sweeping again says nothing and mails nothing
    const f = await runSweep(s, m, min(50), "https://cortex.test/");
    expect(f.transitions).toEqual([]);
    expect(m.sent).toHaveLength(2);
  });

  it("a tolerance-2 unit swallows the first failure and pages on the second consecutive one", async () => {
    const s = ledger([flaky]); const m = recorder();
    const say = (r: Parameters<typeof applyReport>[2], at: Date) => report(s, r, at, [flaky]);

    // night one: fails. One consecutive failure against a tolerance of 2 — recorded, not mailed.
    await say({ unit: "flaky", verb: "start", run_key: "n1" }, min(0));
    await runSweep(s, m, min(1), "https://cortex.test/");
    await say({ unit: "flaky", verb: "finish", run_key: "n1", ok: false, error: "exit 1" }, min(5));
    const one = await runSweep(s, m, min(6), "https://cortex.test/");
    expect(one.transitions).toEqual([{ unit: "flaky", from: "running", to: "failed" }]);
    expect(one.paged).toEqual([]);
    expect(m.sent).toEqual([]);

    // night two: fails again. Two in a row, tolerance spent, one mail.
    await say({ unit: "flaky", verb: "start", run_key: "n2" }, min(30));
    await runSweep(s, m, min(31), "https://cortex.test/");
    await say({ unit: "flaky", verb: "finish", run_key: "n2", ok: false, error: "exit 1 again" }, min(35));
    const two = await runSweep(s, m, min(36), "https://cortex.test/");
    expect(two.transitions).toEqual([{ unit: "flaky", from: "running", to: "failed" }]);
    expect(two.paged).toEqual(["flaky"]);
    expect(m.sent).toEqual(["CORTEX OPS: Flaky routine running → failed"]);
    expect(s.events.filter((e) => e.kind === "alert_sent")).toHaveLength(1);
  });

  it("a finish with exit_reason question pages needs_you once", async () => {
    const s = ledger(); const m = recorder();
    await report(s, { unit: "groundskeeper", verb: "start", run_key: "q1" }, min(0));
    await runSweep(s, m, min(1), "https://cortex.test/");
    await report(s, { unit: "groundskeeper", verb: "finish", run_key: "q1", ok: false, exit_reason: "question", summary: "which branch?" }, min(5));

    const r = await runSweep(s, m, min(6), "https://cortex.test/");
    expect(r.transitions).toEqual([{ unit: "groundskeeper", from: "running", to: "needs_you" }]);
    expect(r.paged).toEqual(["groundskeeper"]);
    expect(m.sent).toEqual(["CORTEX OPS: Brain groundskeeper running → needs_you"]);

    const again = await runSweep(s, m, min(21), "https://cortex.test/");
    expect(again.transitions).toEqual([]);
    expect(m.sent).toHaveLength(1);
  });

  it("the ledger keeps one alert_sent per page and one transition per move", async () => {
    const s = ledger(); const m = recorder();
    await report(s, { unit: "groundskeeper", verb: "start", run_key: "d1" }, min(0));
    await runSweep(s, m, min(1), "https://cortex.test/");
    await report(s, { unit: "groundskeeper", verb: "finish", run_key: "d1", ok: false, error: "exit 1" }, min(5));
    await runSweep(s, m, min(6), "https://cortex.test/");
    await runSweep(s, m, min(7), "https://cortex.test/");
    expect(s.events.filter((e) => e.kind === "transition").map((e) => `${e.from_state}→${e.to_state}`)).toEqual(["scheduled→running", "running→failed"]);
    expect(s.events.filter((e) => e.kind === "alert_sent")).toHaveLength(1);
    expect(s.events.filter((e) => e.kind === "alert_failed")).toHaveLength(0);
  });
});
