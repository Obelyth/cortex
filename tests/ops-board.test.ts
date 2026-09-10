import { describe, it, expect, afterEach } from "vitest";
import { buildBoard, degradeLine, eventGlyph, humanDuration, opsBoard, primaryControl, STATE_TONE, stripFigures } from "../lib/ops-board";
import { __setOpsStore } from "../lib/ops";
import type { Run, Unit } from "../lib/ops-state";

const T0 = new Date("2026-09-02T04:41:07Z");
const gk: Unit = { id: "groundskeeper", kind: "routine", name: "Brain groundskeeper", owner: "manager", period_s: 86400, grace_s: 1800, max_run_s: 1200, pages: true, tolerance: 1, paused_until: null, run_now: { kind: "dispatch", target: "run-groundskeeper" }, notes: null };
const secret: Unit = { ...gk, id: "console-secret", name: "Console secret", kind: "item", period_s: null, run_now: null };
const done: Run = { id: 9, unit_id: "groundskeeper", run_key: "2026-09-01", trigger: "cron", scheduled_at: null, started_at: "2026-09-01T09:19:00Z", ended_at: "2026-09-01T09:25:12Z", lease_until: null, state: "succeeded", exit_reason: null, attempt: 1, summary: "2 pages corrected", error: null, evidence: ["https://github.com/example-owner/brain/commit/abcdef12"], cost: null, facts: null };

describe("humanDuration", () => {
  it.each([[41, "41s"], [372, "6m 12s"], [16560, "4h 36m"], [266400, "3d 02h"]])("%d → %s", (s, out) => expect(humanDuration(s)).toBe(out));
});

describe("buildBoard", () => {
  it("labels a historical operator without an installation-specific identity", () => {
    const result = buildBoard([gk], new Map(), new Map(), new Map(), [{ unit_id: gk.id, run_id: null, actor: "operator", kind: "ack" }], T0);
    expect(result.timeline[0].line).toBe("Operator acknowledged Groundskeeper");
  });
  const board = buildBoard([gk, secret], new Map([["groundskeeper", done]]), new Map(), new Map(), [{ id: 1, unit_id: "groundskeeper", run_id: 9, at: "2026-09-01T09:25:12Z", actor: "unit", kind: "finish", to_state: "succeeded", body: { evidence: ["https://github.com/example-owner/brain/commit/abcdef12"] } }], T0);
  it("counts attention first and finds the next run", () => {
    expect(board.counts).toEqual({ needsYou: 1, running: 0, lateOrMissed: 0 });
    // 09:25:12 + 24h = 2026-09-02T09:25:12Z; T0 = 2026-09-02T04:41:07Z; diff = 4h44m05s = 17045s.
    expect(board.nextRun).toEqual({ unit: "groundskeeper", inSeconds: 17045 });
  });
  it("groups by owner with reserved stations for the unbuilt operators", () => {
    expect(board.groups.map((g) => g.owner)).toEqual(["manager", "indexer", "retrieval", "none"]);
    expect(board.groups[1].reserved).toMatch(/sub-project 2/);
  });
  it("sorts attention rows first and states the window on every figure", () => {
    const rows = board.groups[0].rows;
    expect(rows[0].id).toBe("console-secret"); expect(rows[0].state).toBe("needs_you");
    expect(rows[1].schedule).toBe("nightly · next 4h 44m");
    expect(rows[1].lastRun).toBe("09:19 → 09:25 · 6m 12s");
    expect(rows[1].evidence).toEqual(["abcdef12"]);
  });
  it("offers only the controls that make sense", () => {
    const [item, routine] = board.groups[0].rows;
    expect(item.selectedControls).toEqual(["ack", "snooze"]);
    expect(routine.selectedControls).toEqual(["ack", "snooze", "pause", "run-now"]);
  });
  it("renders the timeline line with the SHA as a field", () => {
    expect(board.timeline[0]).toMatchObject({ unit: "groundskeeper", kind: "finish", line: "Groundskeeper finished · 2 pages corrected", field: { text: "abcdef12", tone: "ok" } });
  });
  it("tones: succeeded ok, acknowledged warn, running live, unverified dashed", () => {
    expect(STATE_TONE.succeeded).toBe("ok"); expect(STATE_TONE.acknowledged).toBe("warn"); expect(STATE_TONE.running).toBe("live"); expect(STATE_TONE.unverified).toBe("dashed");
  });
});

describe("opsBoard degrade modes", () => {
  afterEach(() => __setOpsStore(undefined));
  it("unconfigured without a store", async () => { __setOpsStore(null); const b = await opsBoard(T0); expect(b.mode).toBe("unconfigured"); expect(b.groups).toHaveLength(4); });
  it("unreachable when the store throws", async () => {
    __setOpsStore({ listUnits: async () => { throw new Error("boom"); } } as never);
    const b = await opsBoard(T0); expect(b.mode).toBe("unreachable"); expect(b.stamp).toContain("2026-09-02");
  });
  it("shows durable mail capacity and provider acceptance without changing execution counts",async()=>{
    let status="outbox_capacity";
    __setOpsStore({listUnits:async()=>[gk],latestRuns:async()=>new Map([[gk.id,done]]),latestAck:async()=>null,consecutiveFailures:async()=>0,listEvents:async()=>[],deliveryStatus:async()=>status} as never);
    const capacity=await opsBoard(T0);
    expect(capacity.groups[0].rows[0].notes).toContain("Alert remains owed");
    expect(capacity.groups[0].rows[0].state).toBe("succeeded");
    status="provider_accepted";expect((await opsBoard(T0)).groups[0].rows[0].notes).toContain("not inbox delivery");
  });
});

describe("the strip", () => {
  const live = buildBoard([gk, secret], new Map([["groundskeeper", done]]), new Map(), new Map(), [], T0);
  it("prints the counted figures on a live render", () => {
    expect(stripFigures(live).map((c) => [c.label, c.figure])).toEqual([["Needs you", "1"], ["Running", "0"], ["Late or missed", "0"], ["Next run", "4h 44m"]]);
    expect(stripFigures(live)[0]).toMatchObject({ meta: "open on the register below", crit: true });
    expect(stripFigures(live)[1].meta).toBe("idle");
    expect(degradeLine(live)).toBeNull();
  });
  it("prints an em dash for every figure when nothing was counted", () => {
    // A 0 here would read as "all clear" — the one thing a degraded render cannot know.
    for (const mode of ["unconfigured", "unreachable"] as const) {
      const cells = stripFigures({ ...live, mode });
      expect(cells.map((c) => c.figure)).toEqual(["—", "—", "—", "—"]);
      expect(cells.map((c) => c.meta)).toEqual(Array(4).fill("not available this render"));
      expect(cells.some((c) => c.crit)).toBe(false);
    }
  });
  it("says why, and never claims a last known state it does not hold", () => {
    expect(degradeLine({ ...live, mode: "unconfigured" })).toBe("ops ledger not configured · env");
    expect(degradeLine({ ...live, mode: "unreachable" })).toBe("unreachable this render · nothing shown · stamped 04:41:07 utc");
    expect(degradeLine({ ...live, mode: "unreachable" })).not.toContain("last known");
  });
});

describe("the strip is honest before anything has reported", () => {
  const nothingYet = buildBoard([gk, secret], new Map(), new Map(), new Map(), [], T0);
  it("says no run has reported rather than that every unit is on schedule", () => {
    expect(nothingYet.reported).toBe(false);
    const cells = stripFigures(nothingYet);
    expect(cells[2].meta).toBe("no run reported yet");
    expect(cells[3]).toMatchObject({ figure: "—", meta: "known after the first run reports" });
  });
  it("keeps the schedule claim once a run anchors it", () => {
    const live = buildBoard([gk, secret], new Map([["groundskeeper", done]]), new Map(), new Map(), [], T0);
    expect(live.reported).toBe(true);
    expect(stripFigures(live)[2].meta).toBe("every unit on schedule");
  });
});

describe("rows carry what the fold discloses", () => {
  const board = buildBoard([{ ...gk, notes: "a closed lid is normal" }], new Map([["groundskeeper", done]]), new Map(), new Map(), [], T0);
  it("exposes the unit's notes and the last run's summary", () => {
    expect(board.groups[0].rows[0]).toMatchObject({ notes: "a closed lid is normal", summary: "2 pages corrected" });
  });
});

describe("the timeline speaks in state words, not column values", () => {
  it("renders a transition with the register's labels", () => {
    const ev = { id: 2, unit_id: "console-secret", run_id: null, at: "2026-09-02T10:31:00Z", actor: "sweep" as const, kind: "transition" as const, from_state: "scheduled", to_state: "needs_you", body: {} };
    const board = buildBoard([secret], new Map(), new Map(), new Map(), [ev], T0);
    expect(board.timeline[0].line).toBe("Console secret: Scheduled → Needs you");
  });
});

describe("primaryControl — state chooses the ink button", () => {
  it("invites Acknowledge on a unit that needs you", () => {
    expect(primaryControl({ state: "needs_you", selectedControls: ["ack", "snooze"] })).toBe("ack");
  });
  it("invites Run now on a healthy unit with a target", () => {
    expect(primaryControl({ state: "scheduled", selectedControls: ["ack", "snooze", "pause", "run-now"] })).toBe("run-now");
  });
  it("invites Resume on a paused unit", () => {
    expect(primaryControl({ state: "paused", selectedControls: ["resume"] })).toBe("resume");
  });
  it("invites nothing on a healthy unit with no target — every button is secondary", () => {
    expect(primaryControl({ state: "quiet", selectedControls: ["ack", "snooze"] })).toBeNull();
  });
});

describe("eventGlyph — the same meaning, the same glyph", () => {
  it.each([["finish", "done"], ["start", "run"], ["alert_failed", "needs-you"], ["snooze", "snooze"], ["nonsense", "point"]])("%s → %s", (kind, glyph) => {
    expect(eventGlyph(kind)).toBe(glyph);
  });
});

describe("next run is a routine's, never a machine's heartbeat", () => {
  it("skips the heartbeat that would otherwise always be next", () => {
    const machine: Unit = { ...gk, id: "workstation-test", name: "Test workstation", kind: "machine", period_s: 900, run_now: null, pages: false };
    const beat: Run = { ...done, id: 10, unit_id: "workstation-test", started_at: "2026-09-02T04:30:00Z", ended_at: "2026-09-02T04:30:02Z", evidence: [] };
    const board = buildBoard([gk, machine], new Map([["groundskeeper", done], ["workstation-test", beat]]), new Map(), new Map(), [], T0);
    expect(board.nextRun?.unit).toBe("groundskeeper");
  });
});
