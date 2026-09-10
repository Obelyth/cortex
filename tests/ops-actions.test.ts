import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { parseAction, applyAction } from "../lib/ops-actions";
import { __setOpsStore, type OpsStore, type OpsEvent } from "../lib/ops";
import type { Unit } from "../lib/ops-state";
import { POST } from "../app/s/[secret]/console/ops/actions/route";
import { STAMP_COOKIE, stampValue } from "../lib/stamp";

const NOW = new Date("2026-09-02T10:00:00Z");
const gk: Unit = { id: "groundskeeper", kind: "routine", name: "gk", owner: "manager", period_s: 86400, grace_s: 1800, max_run_s: 1200, pages: true, tolerance: 1, paused_until: null, run_now: { kind: "dispatch", target: "run-groundskeeper" }, notes: null };
const item: Unit = { ...gk, id: "console-secret", kind: "item", period_s: null, run_now: null };
function store(): OpsStore & { events: OpsEvent[]; patched: Array<[string, Partial<Unit>]> } {
  const events: OpsEvent[] = []; const patched: Array<[string, Partial<Unit>]> = [];
  return { events, patched, listUnits: async () => [gk, item], latestRuns: async () => new Map(), findRun: async () => null, insertRun: async (r) => ({ ...r, id: 1 }) as never, patchRun: async () => ({}) as never, latestEvent: async () => null,
    patchUnit: async (id, p) => { patched.push([id, p]); return { ...gk, ...p }; }, appendEvent: async (e) => { events.push({ ...e, id: events.length + 1 }); return events.at(-1)!; }, listEvents: async () => events, latestAck: async () => null, consecutiveFailures: async () => 0, latestTransition: async () => null };
}

describe("parseAction", () => {
  it("rejects unknown actions and bad hours", () => {
    expect(parseAction({ action: "nuke", unit: "gk" })).toMatch(/unknown action/);
    expect(parseAction({ action: "snooze", unit: "gk", hours: 0 })).toMatch(/hours/);
    expect(parseAction({ action: "snooze", unit: "gk", hours: 200 })).toMatch(/hours/);
    expect(parseAction({ action: "pause", unit: "gk", until: "yesterday" })).toMatch(/until/);
  });
  it("accepts the five verbs", () => { for (const b of [{ action: "ack", unit: "g" }, { action: "snooze", unit: "g", hours: 24 }, { action: "pause", unit: "g", until: "2026-09-05T00:00:00Z" }, { action: "resume", unit: "g" }, { action: "run-now", unit: "g" }]) expect(typeof parseAction(b)).toBe("object"); });
});

describe("applyAction", () => {
  const noDispatch = async () => ({ ok: true, status: 204 });
  it("ack writes a neutral console actor and returns its id as the receipt", async () => {
    const s = store();
    const r = await applyAction(s, [gk, item], { action: "ack", unit: "console-secret", note: "rotating tomorrow" }, NOW, noDispatch);
    expect(r).toEqual({ ok: true, receipt: 1 });
    expect(s.events[0]).toMatchObject({ kind: "ack", actor: "console", unit_id: "console-secret", body: { note: "rotating tomorrow", until: null } });
  });
  it("snooze stores until = now + hours", async () => {
    const s = store();
    await applyAction(s, [gk, item], { action: "snooze", unit: "groundskeeper", hours: 24 }, NOW, noDispatch);
    expect(s.events[0]).toMatchObject({ kind: "snooze", body: { until: "2026-09-03T10:00:00.000Z" } });
  });
  it("pause patches the unit and writes the event; resume clears it", async () => {
    const s = store();
    await applyAction(s, [gk, item], { action: "pause", unit: "groundskeeper", until: "2026-09-05T00:00:00Z" }, NOW, noDispatch);
    expect(s.patched[0]).toEqual(["groundskeeper", { paused_until: "2026-09-05T00:00:00Z" }]);
    await applyAction(s, [gk, item], { action: "resume", unit: "groundskeeper" }, NOW, noDispatch);
    expect(s.patched[1]).toEqual(["groundskeeper", { paused_until: null }]);
    expect(s.events.map((e) => e.kind)).toEqual(["pause", "resume"]);
  });
  it("run-now dispatches the target and records the response; 409 when the unit has no target", async () => {
    const s = store(); const dispatch = vi.fn(async () => ({ ok: true, status: 204 }));
    const r = await applyAction(s, [gk, item], { action: "run-now", unit: "groundskeeper" }, NOW, dispatch);
    expect(dispatch).toHaveBeenCalledWith("run-groundskeeper");
    expect(r).toEqual({ ok: true, receipt: 1 });
    expect(s.events[0]).toMatchObject({ kind: "run_now", body: { target: "run-groundskeeper", status: 204 } });
    expect(await applyAction(s, [gk, item], { action: "run-now", unit: "console-secret" }, NOW, dispatch)).toMatchObject({ ok: false, status: 409 });
  });
  it("run-now on a failed dispatch is 502 and still receipted", async () => {
    const s = store();
    const r = await applyAction(s, [gk, item], { action: "run-now", unit: "groundskeeper" }, NOW, async () => ({ ok: false, status: 401 }));
    expect(r).toMatchObject({ ok: false, status: 502 });
    expect(s.events[0]).toMatchObject({ kind: "run_now", body: { status: 401 } });
  });
  it("run-now with a dispatcher that throws is 502 and still receipted with status 0", async () => {
    const s = store();
    const r = await applyAction(s, [gk, item], { action: "run-now", unit: "groundskeeper" }, NOW, async () => { throw new Error("boom"); });
    expect(r).toMatchObject({ ok: false, status: 502 });
    expect(s.events[0]).toMatchObject({ kind: "run_now", body: { status: 0 } });
  });
  it("run-now on a link target returns opened and receipts { opened: true }", async () => {
    const s = store();
    const link: Unit = { ...gk, id: "canary", run_now: { kind: "link", target: "https://claude.ai/code/routines/x" } };
    const r = await applyAction(s, [gk, item, link], { action: "run-now", unit: "canary" }, NOW, noDispatch);
    expect(r).toEqual({ ok: true, receipt: 1, opened: "https://claude.ai/code/routines/x" });
    expect(s.events[0]).toMatchObject({ kind: "run_now", body: { target: "https://claude.ai/code/routines/x", opened: true } });
  });
  it("unknown unit is 404", async () => expect(await applyAction(store(), [gk], { action: "ack", unit: "ghost" }, NOW, noDispatch)).toMatchObject({ ok: false, status: 404 }));
});

describe("POST /s/[secret]/console/ops/actions", () => {
  const SECRET = "ops-route-secret";
  const post = (body: unknown, cookie = `${STAMP_COOKIE}=${stampValue()}`) => POST(new Request("https://cortex.test/s/x/console/ops/actions", { method: "POST", body: JSON.stringify(body), headers: { "Content-Type": "application/json", origin: "https://cortex.test", cookie } }), { params: Promise.resolve({ secret: SECRET }) });
  beforeEach(() => { vi.stubEnv("CONNECTOR_PATH_SECRET", SECRET); vi.stubEnv("CONSOLE_PASSCODE", "ops-suite passcode"); __setOpsStore(store()); });
  afterEach(() => { __setOpsStore(undefined); vi.unstubAllEnvs(); });
  it("is an empty 404 without the device stamp", async () => { const r = await post({ action: "ack", unit: "groundskeeper" }, ""); expect(r.status).toBe(404); });
  it("acks and returns the receipt", async () => { const r = await post({ action: "ack", unit: "groundskeeper" }); expect(r.status).toBe(200); expect(await r.json()).toMatchObject({ ok: true, receipt: 1 }); });
  it("is 400 on an unknown action", async () => expect((await post({ action: "nuke", unit: "groundskeeper" })).status).toBe(400));
});
