import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { parseReport, applyReport } from "../lib/ops-report";
import { __setOpsStore, type OpsStore, type OpsEvent } from "../lib/ops";
import type { Run, Unit } from "../lib/ops-state";
import { POST } from "../app/api/ops/report/route";
import {withAtomic} from "./ops-test-store";

const NOW = new Date("2026-09-02T09:19:00Z");
const gk: Unit = { id: "groundskeeper", kind: "routine", name: "gk", owner: "manager", period_s: 86400, grace_s: 1800, max_run_s: 1200, pages: true, tolerance: 1, paused_until: null, run_now: null, notes: null };
const rog: Unit = { ...gk, id: "workstation-test", kind: "machine", period_s: 900, pages: false };

function memStore(seed: Run[] = []): OpsStore & { runs: Run[]; events: OpsEvent[] } {
  const runs = [...seed]; const events: OpsEvent[] = []; let nextId = 100;
  return withAtomic({
    runs, events,
    listUnits: async () => [gk, rog],
    latestRuns: async (ids) => { const m = new Map<string, Run>(); for (const r of [...runs].reverse()) if (ids.includes(r.unit_id) && !m.has(r.unit_id)) m.set(r.unit_id, r); return m; },
    findRun: async (u, k) => runs.find((r) => r.unit_id === u && r.run_key === k) ?? null,
    insertRun: async (r) => { const row = { ...r, id: nextId++ } as Run; runs.push(row); return row; },
    patchRun: async (id, p) => { const i = runs.findIndex((r) => r.id === id); runs[i] = { ...runs[i], ...p }; return runs[i]; },
    patchUnit: async () => gk,
    appendEvent: async (e) => { events.push(e); return e; },
    listEvents: async () => events,
    latestAck: async () => null,
    consecutiveFailures: async () => 0,
    latestEvent: async () => null,
    latestTransition: async () => null,
  },[gk,rog],runs,events);
}

describe("parseReport", () => {
  it("rejects a missing unit or bad verb", () => {
    expect(parseReport({ verb: "start", run_key: "k" })).toMatch(/unit/);
    expect(parseReport({ unit: "gk", verb: "boom", run_key: "k" })).toMatch(/verb/);
    expect(parseReport({ unit: "gk", verb: "start" })).toMatch(/run_key/);
  });
  it("caps summary at 280 and coerces evidence to strings", () => {
    const r = parseReport({ unit: "gk", verb: "finish", run_key: "k", summary: "x".repeat(300), evidence: ["a", 1] });
    expect(typeof r).toBe("object");
    expect((r as { summary: string }).summary).toHaveLength(280);
    expect((r as { evidence: string[] }).evidence).toEqual(["a"]);
  });
});

describe("applyReport", () => {
  it("start opens a run with a lease of max_run_s and writes a start event", async () => {
    const s = memStore();
    const res = await applyReport(s, [gk, rog], { unit: "groundskeeper", verb: "start", run_key: "2026-09-02" }, NOW);
    expect(res.ok).toBe(true);
    const run = s.runs[0];
    expect(run.started_at).toBe(NOW.toISOString());
    expect(run.lease_until).toBe(new Date(NOW.getTime() + 1200_000).toISOString());
    expect(run.state).toBe("running");
    expect(s.events[0]).toMatchObject({ kind: "start", actor: "unit", unit_id: "groundskeeper" });
  });
  it("a second start for the same run_key is a replay, not a duplicate", async () => {
    const s = memStore();
    await applyReport(s, [gk, rog], { unit: "groundskeeper", verb: "start", run_key: "k" }, NOW);
    const again = await applyReport(s, [gk, rog], { unit: "groundskeeper", verb: "start", run_key: "k" }, NOW);
    expect(again).toMatchObject({ ok: true, replay: true });
    expect(s.runs).toHaveLength(1);
  });
  it("start while another run holds the lease is 409 with the live run", async () => {
    const s = memStore();
    await applyReport(s, [gk, rog], { unit: "groundskeeper", verb: "start", run_key: "a" }, NOW);
    const res = await applyReport(s, [gk, rog], { unit: "groundskeeper", verb: "start", run_key: "b" }, new Date(NOW.getTime() + 60_000));
    expect(res).toMatchObject({ ok: false, status: 409 });
    expect((res as { run: Run }).run.run_key).toBe("a");
  });
  it("finish closes the run, stores evidence, and marks unverified without it", async () => {
    const s = memStore();
    await applyReport(s, [gk, rog], { unit: "groundskeeper", verb: "start", run_key: "k" }, NOW);
    const later = new Date(NOW.getTime() + 372_000);
    const res = await applyReport(s, [gk, rog], { unit: "groundskeeper", verb: "finish", run_key: "k", ok: true, summary: "2 pages corrected", evidence: ["https://github.com/example-owner/brain/commit/abcdef12"] }, later);
    expect(res.ok).toBe(true);
    expect(s.runs[0]).toMatchObject({ ended_at: later.toISOString(), state: "succeeded", evidence: ["https://github.com/example-owner/brain/commit/abcdef12"] });
    const s2 = memStore();
    await applyReport(s2, [gk, rog], { unit: "groundskeeper", verb: "start", run_key: "k" }, NOW);
    await applyReport(s2, [gk, rog], { unit: "groundskeeper", verb: "finish", run_key: "k", ok: true }, later);
    expect(s2.runs[0].state).toBe("unverified");
  });
  it("finish with ok:false records exit_reason code by default, question when given", async () => {
    const s = memStore();
    await applyReport(s, [gk, rog], { unit: "groundskeeper", verb: "start", run_key: "k" }, NOW);
    await applyReport(s, [gk, rog], { unit: "groundskeeper", verb: "finish", run_key: "k", ok: false, error: "brain_write 409" }, NOW);
    expect(s.runs[0]).toMatchObject({ state: "failed", exit_reason: "code", error: "brain_write 409" });
  });
  it("finish ok:false with exit_reason question is needs_you", async () => {
    const s = memStore();
    await applyReport(s, [gk, rog], { unit: "groundskeeper", verb: "start", run_key: "k" }, NOW);
    await applyReport(s, [gk, rog], { unit: "groundskeeper", verb: "finish", run_key: "k", ok: false, exit_reason: "question", error: "which reader?" }, NOW);
    expect(s.runs[0]).toMatchObject({ state: "needs_you", exit_reason: "question", error: "which reader?" });
    expect(s.events.at(-1)).toMatchObject({ kind: "finish", to_state: "needs_you" });
  });
  it("finish without a start is 404 for that run", async () => {
    const res = await applyReport(memStore(), [gk, rog], { unit: "groundskeeper", verb: "finish", run_key: "nope", ok: true }, NOW);
    expect(res).toMatchObject({ ok: false, status: 404 });
  });
  it("heartbeat on a machine upserts a seen row with facts; on a running agent it renews the lease", async () => {
    const s = memStore();
    await applyReport(s, [gk, rog], { unit: "workstation-test", verb: "heartbeat", run_key: "hb", facts: { disk_pct: 61 } }, NOW);
    expect(s.runs[0]).toMatchObject({ unit_id: "workstation-test", state: "seen", facts: { disk_pct: 61 }, trigger: "heartbeat" });
    await applyReport(s, [gk, rog], { unit: "groundskeeper", verb: "start", run_key: "k" }, NOW);
    const t2 = new Date(NOW.getTime() + 600_000);
    await applyReport(s, [gk, rog], { unit: "groundskeeper", verb: "heartbeat", run_key: "k" }, t2);
    expect(s.runs[1].lease_until).toBe(new Date(t2.getTime() + 1200_000).toISOString());
  });
  it("unknown unit is 404", async () => {
    expect(await applyReport(memStore(), [gk, rog], { unit: "ghost", verb: "start", run_key: "k" }, NOW)).toMatchObject({ ok: false, status: 404 });
  });
});

describe("POST /api/ops/report", () => {
  const url = "https://cortex.test/api/ops/report";
  const req = (body: unknown, auth?: string) => new Request(url, { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json", ...(auth ? { authorization: auth } : {}) } });
  beforeEach(() => { vi.stubEnv("OPS_TOKEN", "t".repeat(40)); __setOpsStore(memStore()); });
  afterEach(() => { __setOpsStore(undefined); vi.unstubAllEnvs(); });

  it("is an empty 404 without the bearer, with a wrong bearer, and when OPS_TOKEN is unset", async () => {
    expect((await POST(req({ unit: "groundskeeper", verb: "start", run_key: "k" }))).status).toBe(404);
    expect((await POST(req({}, "Bearer wrong"))).status).toBe(404);
    vi.stubEnv("OPS_TOKEN", "");
    const r = await POST(req({}, `Bearer ${"t".repeat(40)}`)); expect(r.status).toBe(404); expect(await r.text()).toBe("");
  });
  it("is 400 on invalid JSON or a bad report", async () => {
    const r = await POST(new Request(url, { method: "POST", body: "{", headers: { authorization: `Bearer ${"t".repeat(40)}` } }));
    expect(r.status).toBe(400);
    expect((await POST(req({ verb: "start" }, `Bearer ${"t".repeat(40)}`))).status).toBe(400);
  });
  it("rejects an oversized streamed report before reading the complete body",async()=>{
    let pulls=0,cancelled=false;
    const body=new ReadableStream<Uint8Array>({pull(c){pulls++;c.enqueue(new TextEncoder().encode(" ".repeat(40000)));if(pulls===10)c.close();},cancel(){cancelled=true;}});
    const r=await POST(new Request(url,{method:"POST",body,duplex:"half",headers:{authorization:`Bearer ${"t".repeat(40)}`}} as RequestInit));
    expect(r.status).toBe(413);expect(pulls).toBeLessThan(10);expect(cancelled).toBe(true);
  });
  it("times out a stalled authorized body and leaves the ledger untouched",async()=>{
    vi.useFakeTimers();let cancelled=false;
    try {
      const body=new ReadableStream<Uint8Array>({cancel(){cancelled=true;}});
      const response=POST(new Request(url,{method:"POST",body,duplex:"half",headers:{authorization:`Bearer ${"t".repeat(40)}`}} as RequestInit));
      await vi.advanceTimersByTimeAsync(5001);expect((await response).status).toBe(408);expect(cancelled).toBe(true);
    }finally{vi.useRealTimers();}
  });
  it("is 503 when the ledger is not configured", async () => {
    __setOpsStore(null);
    const r = await POST(req({ unit: "groundskeeper", verb: "start", run_key: "k" }, `Bearer ${"t".repeat(40)}`));
    expect(r.status).toBe(503); expect(await r.json()).toMatchObject({ error: expect.stringMatching(/not configured/) });
  });
  it("returns the run on success and 409 with the live run on a lease clash", async () => {
    const ok = await POST(req({ unit: "groundskeeper", verb: "start", run_key: "a" }, `Bearer ${"t".repeat(40)}`));
    expect(ok.status).toBe(200); expect(await ok.json()).toMatchObject({ ok: true, run: { run_key: "a", state: "running" } });
    const clash = await POST(req({ unit: "groundskeeper", verb: "start", run_key: "b" }, `Bearer ${"t".repeat(40)}`));
    expect(clash.status).toBe(409);
  });
});
