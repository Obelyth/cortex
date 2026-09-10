import { describe, expect, it } from "vitest";
import type { CallRow } from "../lib/calls";
import {
  HOUR, answeredFromMemory, byModel, coverageOf, cutOff, elapsedLabel, fmtWin, heatGrid, hourBins, hoursCovered, memoryBuckets, patternsOf, scoredAsk, sessionsOf, stoppedByClock, timedOut, tokensSaved,
} from "../lib/trends";
import { CUT_STAMP, TIMED_OUT_STAMP } from "../lib/deadline";
import { buildTrendsVM } from "../app/s/[secret]/console/trends/trends-screen";

/**
 * The Trends derivations never claim more than the rows can back: a session is a burst, a
 * saving is measured or counted out loud, a pattern needs its premise, a window is what the
 * log covers.
 */
const NOW = Date.UTC(2026, 8, 5, 12, 0, 0);
const row = (ts: number, tool: string, stamp = "READ", extra: Partial<CallRow> = {}): CallRow => ({ ts, surface: "terminal", tool, stamp, ms: 900, ...extra });
const ask = (ts: number, stamp: string, extra: Partial<CallRow> = {}) => row(ts, "brain_ask", stamp, { model: "claude-sonnet-5", saved: 90_000, ...extra });

describe("a call the platform cut off", () => {
  it("is not an answer from memory, and its duration says who stopped it", () => {
    // A started row with no final row past the wall collapses to CUT OFF with the wall as its
    // ms. It answered nothing, so it must not count as memory; and 60.0 s is not a measured
    // latency, so the label names the platform rather than printing a number that looks read.
    const cut = ask(NOW - HOUR, CUT_STAMP, { ms: 60_000, model: undefined });
    expect(answeredFromMemory(CUT_STAMP)).toBe(false);
    expect(cutOff(cut)).toBe(true);
    expect(elapsedLabel(cut)).toBe("cut off by the platform after 60 s");
    expect(elapsedLabel(ask(NOW, "VERIFIED", { ms: 1234 }))).toBe("1.2 s");
    const b = memoryBuckets([cut, ask(NOW - HOUR, "VERIFIED"), ask(NOW - HOUR, "NOT IN BRAIN")], NOW, 2);
    expect(b[1]).toMatchObject({ memory: 1, fresh: 1, all: 3 });
  });
});

describe("a call the request deadline stopped inside the budget", () => {
  it("is not an answer from memory, not scored, and its duration says the clock ran out", () => {
    // brain_ask stamps TIMED OUT when the corpus did not load in budget (lib/tools.ts timedOut()).
    // It answered nothing: it must not count as a memory answer, must leave every rate's
    // denominator with the cut-offs, and its ms — real, but spent not answering — must not read
    // as a latency.
    const late = ask(NOW - HOUR, TIMED_OUT_STAMP, { ms: 49_000, model: undefined });
    expect(answeredFromMemory(TIMED_OUT_STAMP)).toBe(false);
    expect(timedOut(late)).toBe(true);
    expect(cutOff(late)).toBe(false);
    expect(stoppedByClock(TIMED_OUT_STAMP)).toBe(true);
    expect(scoredAsk(late)).toBe(false);
    expect(scoredAsk(ask(NOW, "ERROR"))).toBe(false);
    expect(scoredAsk(ask(NOW, "NOT IN BRAIN"))).toBe(true);
    expect(elapsedLabel(late)).toBe("timed out in budget after 49.0 s");
    const b = memoryBuckets([late, ask(NOW - HOUR, "VERIFIED")], NOW, 2);
    expect(b[1]).toMatchObject({ memory: 1, fresh: 0, all: 2 });
    // The strip's memory-hit rate scores against asks that could have answered: 1 of 1, not 1 of 2.
    const rows = [late, ask(NOW - HOUR, "VERIFIED")];
    const vm = buildTrendsVM({ now: NOW, calls48: { rows, covers: 48 * HOUR, durable: true, source: "store" }, life: { rows, covers: 48 * HOUR }, corpusTokens: 100_000, readers: [], writable: false });
    expect(vm.cells.find((c) => c.label === "From memory")).toMatchObject({ figure: "100%", meta: "of 1 asks · lifetime" });
  });
});

describe("the strip", () => {
  it("counts sessions as bursts thirty quiet minutes apart", () => {
    const rows = [row(NOW - 3 * HOUR, "brain_read"), row(NOW - 3 * HOUR + 60_000, "brain_read"), row(NOW - HOUR, "brain_read"), row(NOW, "brain_read")];
    expect(sessionsOf(rows)).toBe(3);
    expect(sessionsOf([])).toBe(0);
  });
  it("prices tokens saved against the corpus and counts unmeasured asks out loud", () => {
    const asks = [ask(NOW, "VERIFIED", { saved: 90_000 }), ask(NOW, "VERIFIED", { saved: 200_000 }), ask(NOW, "VERIFIED", { saved: undefined })];
    const s = tokensSaved(asks, 100_000);
    expect(s.tokens).toBe(10_000); // 100k − 90k, then clamped at zero for a saving past the corpus
    expect(s.measured).toBe(2);
    expect(s.unmeasured).toBe(1);
  });
  it("captions the window the log really covers", () => {
    expect(coverageOf(30_000)).toBe("log just started");
    expect(coverageOf(25 * 60_000)).toBe("25 min of log");
    expect(coverageOf(48 * HOUR)).toBe("48 h of log");
    expect(hoursCovered(5 * HOUR + 1)).toBe(6);
    expect(hoursCovered(400 * HOUR)).toBe(48);
    expect(fmtWin(NOW - 3 * HOUR, NOW - 2 * HOUR, NOW)).toBe("-3h → -2h");
    expect(fmtWin(NOW - HOUR, NOW, NOW)).toBe("-1h → now");
  });
});

describe("the instruments", () => {
  it("bins the pulse by hour, reads & writes apart from asks, oldest first", () => {
    const rows = [row(NOW - 2.5 * HOUR, "brain_read"), ask(NOW - 2.5 * HOUR, "VERIFIED"), row(NOW - 30_000, "brain_write")];
    const bins = hourBins(rows, NOW, 3);
    expect(bins.map((b) => [b.calls, b.asks])).toEqual([[2, 1], [0, 0], [1, 0]]);
    expect(bins[2].to).toBe(NOW);
  });
  it("buckets memory vs not, and labels the last bucket now", () => {
    const rows = [ask(NOW - 7.5 * HOUR, "VERIFIED"), ask(NOW - 7.5 * HOUR, "NOT IN BRAIN"), ask(NOW - 1000, "ERROR")];
    const b = memoryBuckets(rows, NOW, 8);
    expect(b).toHaveLength(8);
    expect(b[0]).toMatchObject({ memory: 1, fresh: 1, all: 2, label: "-8h" });
    expect(b[7]).toMatchObject({ memory: 0, fresh: 0, all: 1, label: "now" });
  });
  it("lays the heat out by weekday and four-hour band in the zone it is told", () => {
    // 2026-09-05 12:00 UTC is a Saturday: band 3 (12pm), day 5.
    const heat = heatGrid([row(NOW, "brain_read")], "utc");
    expect(heat[3][5]).toBe(1);
    expect(heat.flat().reduce((a, n) => a + n, 0)).toBe(1);
  });
  it("attributes asks by reader, busiest first, and does not time cached replays", () => {
    const rows = [ask(NOW, "VERIFIED", { ms: 1000 }), ask(NOW, "VERIFIED", { ms: 3000, cached: true }), ask(NOW, "UNVERIFIED", { model: "claude-opus-5", ms: 2000 })];
    const m = byModel(rows);
    expect(m.map((x) => x.model)).toEqual(["claude-sonnet-5", "claude-opus-5"]);
    expect(m[0]).toMatchObject({ n: 2, ok: 2, p50: "1.0 s", pct: 67 });
  });
});

describe("patterns", () => {
  const window = { from: NOW - 48 * HOUR, to: NOW, windowLabel: "48 h" };
  it("claims nothing an empty window cannot back", () => {
    expect(patternsOf({ rows: [], heat: heatGrid([], "utc"), ...window })).toEqual([]);
  });
  it("needs three calls in a cell before a weekday runs hot, and carries its derivation", () => {
    const two = [row(NOW, "brain_read"), row(NOW, "brain_read")];
    expect(patternsOf({ rows: two, heat: heatGrid(two, "utc"), ...window }).some((p) => p.title.endsWith("run hot"))).toBe(false);
    const three = [...two, row(NOW, "brain_read")];
    const hot = patternsOf({ rows: three, heat: heatGrid(three, "utc"), ...window }).find((p) => p.title.endsWith("run hot"));
    expect(hot?.title).toBe("Saturdays run hot");
    expect(hot?.how).toEqual(expect.arrayContaining([["window", "48 h"]]));
  });
  it("needs eight asks and a fifteen-percent move before the rate pattern speaks", () => {
    const early = Array.from({ length: 4 }, (_, i) => ask(NOW - 40 * HOUR + i, i < 2 ? "NOT IN BRAIN" : "VERIFIED"));
    const late = Array.from({ length: 4 }, (_, i) => ask(NOW - 4 * HOUR + i, "VERIFIED"));
    const rows = [...early, ...late];
    const p = patternsOf({ rows, heat: heatGrid(rows, "utc"), ...window }).find((x) => x.title === "Re-explaining is fading");
    expect(p?.chip).toBe("-100%");
    expect(patternsOf({ rows: rows.slice(1), heat: heatGrid(rows, "utc"), ...window }).some((x) => x.title === "Re-explaining is fading")).toBe(false);
  });
});

describe("the view model", () => {
  const input = (rows: CallRow[], covers = 48 * HOUR) => buildTrendsVM({
    now: NOW,
    calls48: { rows, covers, durable: true, source: "store" },
    life: { rows, covers: 20 * 24 * HOUR },
    corpusTokens: 100_000,
    readers: [],
    writable: true,
  });
  it("says the screen is empty once, when nothing can be trended", () => {
    const vm = input([]);
    expect(vm.nothingYet).toBe(true);
    expect(vm.lede).toContain("48 h of log");
  });
  it("draws only the hours the log covers, and says so", () => {
    const vm = input([ask(NOW - 1000, "VERIFIED")], 5 * HOUR);
    expect(vm.nothingYet).toBe(false);
    expect(vm.hoursN).toBe(5);
    expect(vm.coverage).toBe("5 h of log");
    expect(vm.cells.map((c) => c.label)).toEqual(["Tokens saved", "Time saved", "Sessions", "From memory"]);
    expect(vm.cells[0].figure).toBe("10k");
    expect(vm.cells[0].meta).toContain("lifetime");
    expect(vm.cells[3].figure).toBe("100%");
    expect(vm.cells[0].sparkNote).toBe("5 h · 1 h steps");
  });
  it("names the fallback store instead of impersonating the durable one", () => {
    const vm = buildTrendsVM({ now: NOW, calls48: { rows: [ask(NOW, "VERIFIED")], covers: HOUR, durable: false, source: "unreachable" }, life: { rows: [], covers: 0 }, corpusTokens: 1, readers: [], writable: false });
    expect(vm.lede).toContain("store unreachable — in-memory view");
  });
  it("hands the browser only the fields the instruments read", () => {
    const vm = input([ask(NOW, "VERIFIED", { saved: 5 })]);
    expect(Object.keys(vm.rows[0]).sort()).toEqual(["model", "ms", "stamp", "surface", "tool", "ts"]);
  });
});
