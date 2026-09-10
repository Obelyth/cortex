import { describe, it, expect } from "vitest";
import { deriveState, nextDue, isPageable, type Unit, type Run } from "../lib/ops-state";

const T0 = new Date("2026-09-02T09:17:00Z");
const min = (n: number) => new Date(T0.getTime() + n * 60_000);
const iso = (d: Date) => d.toISOString();
const unit = (o: Partial<Unit> = {}): Unit => ({ id: "gk", kind: "routine", name: "gk", owner: "manager", period_s: 86400, grace_s: 1800, max_run_s: 1200, pages: true, tolerance: 1, paused_until: null, run_now: null, notes: null, ...o });
const run = (o: Partial<Run> = {}): Run => ({ id: 1, unit_id: "gk", run_key: "k", trigger: "cron", scheduled_at: iso(T0), started_at: null, ended_at: null, lease_until: null, state: "scheduled", exit_reason: null, attempt: 1, summary: null, error: null, evidence: [], cost: null, facts: null, ...o });
// a finished run one day ago, so the next due is T0
const yesterday = run({ started_at: iso(min(-1440)), ended_at: iso(min(-1434)), state: "succeeded", evidence: ["sha"] });

describe("deriveState", () => {
  it("succeeded stays until due", () => expect(deriveState(unit(), yesterday, null, min(-10))).toBe("succeeded"));
  it("late inside grace", () => expect(deriveState(unit(), yesterday, null, min(12))).toBe("late"));
  it("missed once grace elapses", () => expect(deriveState(unit(), yesterday, null, min(40))).toBe("missed"));
  it("running while the lease holds", () => expect(deriveState(unit(), run({ started_at: iso(min(2)), lease_until: iso(min(17)) }), null, min(6))).toBe("running"));
  it("crashed when the lease lapses with no finish", () => expect(deriveState(unit(), run({ started_at: iso(min(2)), lease_until: iso(min(17)) }), null, min(18))).toBe("crashed"));
  it("succeeded needs evidence", () => expect(deriveState(unit(), run({ started_at: iso(min(2)), ended_at: iso(min(8)), state: "succeeded", evidence: ["https://github.com/x/y/commit/abc"] }), null, min(9))).toBe("succeeded"));
  it("unverified without evidence", () => expect(deriveState(unit(), run({ started_at: iso(min(2)), ended_at: iso(min(8)), state: "succeeded", evidence: [] }), null, min(9))).toBe("unverified"));
  it("failed on exit_reason code", () => expect(deriveState(unit(), run({ started_at: iso(min(2)), ended_at: iso(min(8)), state: "failed", exit_reason: "code" }), null, min(9))).toBe("failed"));
  it("needs_you on a question", () => expect(deriveState(unit(), run({ started_at: iso(min(2)), ended_at: iso(min(8)), state: "failed", exit_reason: "question" }), null, min(9))).toBe("needs_you"));
  it("acknowledged overrides a bad state until the ack expires", () => {
    const r = run({ started_at: iso(min(2)), ended_at: iso(min(8)), state: "failed", exit_reason: "code" });
    expect(deriveState(unit(), r, { until: null, at: iso(min(9)) }, min(9))).toBe("acknowledged");
    expect(deriveState(unit(), r, { until: iso(min(30)), at: iso(min(9)) }, min(9))).toBe("acknowledged");
    expect(deriveState(unit(), r, { until: iso(min(30)), at: iso(min(9)) }, min(31))).toBe("failed");
  });
  it("an ack older than the run it would silence is spent, not standing", () => {
    // The operator acknowledged yesterday's failure. Tonight's run failed too — that is news,
    // and a bare ack must not mute the unit for every run that follows it.
    const r = run({ started_at: iso(min(2)), ended_at: iso(min(8)), state: "failed", exit_reason: "code" });
    expect(deriveState(unit(), r, { until: null, at: iso(min(-1440)) }, min(9))).toBe("failed");
    expect(deriveState(unit(), r, { until: null, at: iso(min(3)) }, min(9))).toBe("acknowledged");
  });
  it("an item with no run keeps its acknowledgement — there is no newer run to un-answer it", () => {
    const i = unit({ id: "secret", kind: "item", period_s: null });
    expect(deriveState(i, null, { until: null, at: iso(min(-100000)) }, T0)).toBe("acknowledged");
  });
  it("paused wins over everything while paused_until is ahead", () => expect(deriveState(unit({ paused_until: iso(min(60)) }), yesterday, null, min(40))).toBe("paused"));
  it("machines are seen or quiet, never late", () => {
    const m = unit({ id: "rog", kind: "machine", period_s: 900, grace_s: 1800, pages: false });
    const hb = run({ trigger: "heartbeat", started_at: iso(min(-4)), ended_at: iso(min(-4)), state: "seen" });
    expect(deriveState(m, hb, null, T0)).toBe("seen");
    expect(deriveState(m, hb, null, min(40))).toBe("quiet");
  });
  it("an item with no run is needs_you until acknowledged", () => {
    const i = unit({ id: "secret", kind: "item", period_s: null });
    expect(deriveState(i, null, null, T0)).toBe("needs_you");
    expect(deriveState(i, null, { until: null, at: iso(T0) }, T0)).toBe("acknowledged");
  });
  it("a routine that has never run is scheduled, never missed", () => expect(deriveState(unit(), null, null, T0)).toBe("scheduled"));
});

describe("nextDue", () => {
  it("is last end + period", () => expect(nextDue(unit(), yesterday)?.toISOString()).toBe(iso(min(-1434 + 1440))));
  it("is null without a period", () => expect(nextDue(unit({ period_s: null }), yesterday)).toBeNull());
});

describe("isPageable", () => {
  it("never for machines", () => expect(isPageable(unit({ kind: "machine", pages: false }), "quiet", 0)).toBe(false));
  it("missed, crashed, needs_you page", () => { for (const s of ["missed", "crashed", "needs_you"] as const) expect(isPageable(unit(), s, 0)).toBe(true); });
  it("failed pages only once tolerance is spent", () => { expect(isPageable(unit({ tolerance: 2 }), "failed", 1)).toBe(false); expect(isPageable(unit({ tolerance: 2 }), "failed", 2)).toBe(true); });
  it("nothing pages when pages=false", () => expect(isPageable(unit({ pages: false }), "missed", 0)).toBe(false));
});
