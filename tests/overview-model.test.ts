import { describe, expect, it } from "vitest";
import type { CallRow, CallWindow } from "@/lib/calls";
import type { NoteRow } from "@/lib/health";
import { activity, agoLabel, callsNote, callsWindow, chartNote, checkedOut, coversLabel, doors, dotField, MARK_CAP, pipeline, saves, windowLabel } from "@/lib/overview";

const NOW = Date.parse("2026-09-05T12:00:00Z");
const H = 3_600_000, D = 86_400_000;
const row = (agoMs: number, tool: string, stamp = "READ", extra: Partial<CallRow> = {}): CallRow => ({ ts: NOW - agoMs, surface: "terminal", tool, stamp, ms: 800, ...extra });
const note = (path: string, strip: string, extra: Partial<NoteRow> = {}): NoteRow => ({ decays: true, path, dir: path.split("/")[0], tokens: strip.length * 40, blocks: strip.length, retracted: [...strip].filter((c) => c === "x").length, strip, age: 2, title: path, desc: "", headings: [], ...extra });
const win = (rows: CallRow[], covers = 30 * D, source: CallWindow["source"] = "store"): CallWindow => ({ rows, partial: false, since: NOW - covers, covers, durable: source === "store", source });

describe("the dot field (W08)", () => {
  it("is one mark per block, cut at the cap with the cap stated", () => {
    const big = note("notes/big.md", ".".repeat(MARK_CAP - 10));
    const f = dotField([big, note("notes/tail.md", "..x.." + ".".repeat(15))], MARK_CAP + 90);
    expect(f.shown).toBe(MARK_CAP);
    expect(f.notes[1].strip).toBe("..x.......");
    expect(f.capNote).toBe(`first ${MARK_CAP.toLocaleString()} of ${(MARK_CAP + 90).toLocaleString()} shown`);
  });
  it("says all shown when nothing was cut", () => {
    expect(dotField([note("a.md", "..x")], 3).capNote).toBe("all shown");
  });
});

describe("activity (W10) and its windows (L9)", () => {
  const rows = [row(30 * 60_000, "brain_read"), row(90 * 60_000, "brain_ask", "VERIFIED", { model: "m", ms: 1200 }), row(90 * 60_000 + 5, "brain_ask", "NOT IN BRAIN", { ms: 400 }), row(3 * D + H, "brain_write", "COMMITTED", { surface: "connector" })];
  const a = activity(win(rows), NOW);
  it("buckets by hour, day and day with the asks split out", () => {
    expect(a.day.buckets).toHaveLength(24);
    expect(a.week.buckets).toHaveLength(7);
    expect(a.month.buckets).toHaveLength(30);
    const last = a.day.buckets[23];
    expect(last.n).toBe(1);
    const prev = a.day.buckets[22];
    expect(prev.n).toBe(2);
    expect(prev.asks).toBe(2);
    expect(a.week.buckets[6].n).toBe(3);
    expect(a.week.buckets[3].n).toBe(1);
  });
  it("summarises a bucket's window for the lens", () => {
    const w = a.day.buckets[22].win;
    expect(w).toMatchObject({ total: 2, asks: 2, mem: 1, fresh: 1, errors: 0, cut: 0, timedOut: 0, p50ms: 400 });
    expect(w.byTool).toEqual([["brain_ask", 2]]);
    expect(w.askRows.map((r) => r.stamp)).toEqual(["VERIFIED", "NOT IN BRAIN"]);
    expect(w.askRows[1]).toMatchObject({ model: null, cached: false, surface: "terminal" });
  });
  it("captions the window honestly", () => {
    expect(a.day.note).toBeNull();
    expect(activity(win(rows, 5 * H), NOW).day.note).toBe("log covers 5 hr");
    expect(activity(win(rows, 5 * H), NOW).callsNote).toMatch(/^log covers 5 hr · bars outside it are silence/);
    expect(callsNote({ covers: D, durable: false, source: "unconfigured" })).toMatch(/^no durable store/);
    expect(callsNote({ covers: D, durable: false, source: "unreachable" })).toMatch(/^store unreachable this render/);
  });
  it("says what the log covers once, not twice", () => {
    // callsNote already opens with coversLabel when the store is healthy, so prepending the
    // range's own note repeated the sentence: "log covers 5 hr · log covers 5 hr · bars …".
    const short = activity(win(rows, 5 * H), NOW);
    expect(chartNote(short.day.note, short.callsNote, 3)).toBe("log covers 5 hr · bars outside it are silence, not zero");
    // When the log's note cannot carry the coverage, the range's note still adds it.
    const unreachable = callsNote({ covers: 5 * H, durable: false, source: "unreachable" });
    expect(chartNote("log covers 5 hr", unreachable, 3)).toBe(`log covers 5 hr · ${unreachable}`);
    // An empty range says nothing extra: the readout already calls it silence.
    expect(chartNote("log covers 5 hr", unreachable, 0)).toBe(unreachable);
  });

  it("an empty window is silence, not zero", () => {
    const w = callsWindow([]);
    expect(w).toMatchObject({ total: 0, asks: 0, p50ms: null, byTool: [], byDoor: [], askRows: [] });
  });
});

describe("doors (W13)", () => {
  it("lights a dot only for a call under 24 h old, and names a closed door", () => {
    const rows = [row(2 * H, "brain_read"), row(3 * D, "brain_ask", "VERIFIED", { surface: "guest" })];
    const d = doors(rows, { token: true, connector: true, guest: true }, NOW, "30 d");
    expect(d[0]).toMatchObject({ live: true, sub: "Claude Code · Cursor · bearer · 2 hr ago" });
    expect(d[1]).toMatchObject({ live: false, sub: "claude.ai · custom connector · no calls in 30 d" });
    expect(d[2]).toMatchObject({ live: false, sub: "any assistant with the url · 3 d ago", grant: "ask only" });
    expect(doors(rows, { token: false, connector: true, guest: false }, NOW, "30 d")[0].sub).toBe("no bearer token — door closed");
    expect(doors(rows, { token: true, connector: true, guest: false }, NOW, "30 d")[2]).toMatchObject({ open: false, last: null, sub: "no guest door open" });
  });

  it("states the window the log covers, not the one the page asked for", () => {
    // readCalls returns covers = min(windowMs, now - start), so a fresh deploy or either
    // fallback mode covers a fraction of the 30 days requested. The panel used to say "no calls
    // in 30 d" beside a chart that said the log covered 40 minutes.
    expect(doors([], { token: true, connector: true, guest: true }, NOW, "40 min")[0].sub)
      .toBe("Claude Code · Cursor · bearer · no calls in 40 min");
    expect(windowLabel(30 * D)).toBe("30 d");
    expect(windowLabel(40 * 60_000)).toBe("40 min");
    expect(windowLabel(5 * H)).toBe("5 hr");
    // Under a minute there is no number worth printing, and the phrase still has to read after "in".
    expect(windowLabel(10_000)).toBe("the log so far");
  });

  it("shuts every door the bearer shuts, and says which thing is missing", () => {
    // The connector and guest routes are the bearer-gated handler behind a path secret: both
    // check MCP_TOKEN before their own secret, so a set path secret alone opens nothing.
    const d = doors([], { token: false, connector: true, guest: true }, NOW, "30 d");
    expect(d.map((x) => x.open)).toEqual([false, false, false]);
    expect(d[1].sub).toBe("no bearer token — every door rides MCP_TOKEN");
    expect(d[2].sub).toBe("no bearer token — every door rides MCP_TOKEN");
    expect(doors([], { token: true, connector: false, guest: true }, NOW, "30 d")[1].sub).toBe("no connector secret");
    // A guest secret equal to the connector's is refused by the route, so the panel must not
    // call that door open.
    const clash = doors([], { token: true, connector: true, guest: true, guestClashes: true }, NOW, "30 d");
    expect(clash[2]).toMatchObject({ open: false, sub: "guest secret equals the connector's — the route refuses it" });
    expect(clash[1].open).toBe(true);
  });
});

describe("calls the platform cut off", () => {
  it("count as their own thing — not memory, not an error, and not a latency", () => {
    const w = callsWindow([row(H, "brain_ask", "VERIFIED", { ms: 900 }), row(2 * H, "brain_ask", "CUT OFF", { ms: 60_000 }), row(3 * H, "brain_ask", "ERROR", { ms: 300 })]);
    expect(w).toMatchObject({ asks: 3, mem: 1, errors: 1, cut: 1, p50ms: 300 }); // the cut row's 60 s never enters the median
    expect(w.askRows.map((r) => r.stamp)).toEqual(["VERIFIED", "CUT OFF", "ERROR"]);
    const c = checkedOut([row(H, "brain_ask", "CUT OFF", { ms: 60_000 })], NOW);
    expect(c.rows.find((r) => r.k === "cut off by the platform")).toMatchObject({ n: 1, tone: "warn" });
    expect(c.stamps.find((s) => s.s === "CUT OFF")?.n).toBe(1);
  });
});

describe("calls the request deadline timed out", () => {
  it("count as their own thing too — not memory, not an error, not a latency, and never dropped from the bar", () => {
    // brain_ask stamps TIMED OUT when the corpus did not load in budget. Before the reader
    // knew the stamp it counted as a memory answer, its ~50 s entered the median, and the
    // evidence bar had no bucket for it — the denominator lost it in silence.
    const w = callsWindow([row(H, "brain_ask", "VERIFIED", { ms: 900 }), row(2 * H, "brain_ask", "TIMED OUT", { ms: 49_000 }), row(3 * H, "brain_ask", "ERROR", { ms: 300 })]);
    expect(w).toMatchObject({ asks: 3, mem: 1, errors: 1, cut: 0, timedOut: 1, p50ms: 300 });
    const c = checkedOut([row(H, "brain_ask", "TIMED OUT", { ms: 49_000 })], NOW);
    expect(c.asks).toBe(1);
    expect(c.rows.find((r) => r.k === "timed out in budget")).toMatchObject({ n: 1, tone: "warn", pct: 100 });
    expect(c.rows.reduce((a, r) => a + r.n, 0)).toBe(c.asks);
    expect(c.stamps.find((s) => s.s === "TIMED OUT")?.n).toBe(1);
  });
});

describe("answer evidence outcomes (W15)", () => {
  it("does not call a verified-but-wrong claim correct or a partial absence wrong",()=>{
    // These stamps can accompany either semantic outcome. The roll-up receives no judge.
    const wrongWithRealQuote={...row(0,"brain_ask","VERIFIED"),input:"synthetic incorrect conclusion"};
    const honestPartial={...row(H,"brain_ask","UNVERIFIED"),input:"synthetic incomplete search abstention"};
    const result=checkedOut([wrongWithRealQuote,honestPartial],NOW);
    expect(result.rows.filter(r=>r.n).map(r=>r.k)).toEqual(["source verified","unverified evidence"]);
    expect(JSON.stringify(result)).not.toMatch(/"(?:right|wrong|accuracy)"/);
  });
  it("counts source verification, never semantic correctness, inside 24 h only", () => {
    const rows = ["VERIFIED", "CORRECTED", "UNVERIFIED", "NOT IN BRAIN", "ERROR", "SUPERSEDED"].map((s, i) => row(i * H, "brain_ask", s));
    rows.push(row(30 * H, "brain_ask", "VERIFIED"));
    const c = checkedOut(rows, NOW);
    expect(c.asks).toBe(6);
    expect(c.rows.map((r) => [r.k, r.n])).toEqual([["source verified", 2], ["unverified evidence", 1], ["reported absent", 1], ["errors", 1], ["cut off by the platform", 0], ["timed out in budget", 0]]);
    expect(c.rows[0].pct).toBe(40);
    expect(c.stamps.find((s) => s.s === "SUPERSEDED")?.n).toBe(1);
  });
});

describe("the memory pipeline (W12)", () => {
  it("names every source's mode rather than a zero", () => {
    // One missing env, one mode name. All three pulses gate on the same env() (lib/pulse.ts:20),
    // but only the mirror reports "off" for it — the other two return null, which used to print
    // as "unreachable" beside the mirror's "off": two names for one cause, and the wrong remedy
    // on two of the three rows.
    const off = pipeline({ state: "off", gitHead: "", mirrorHead: null, notes: null, syncedAt: null }, null, null, NOW);
    expect(off.state).toBe("mirror off");
    expect(off.rows.map((r) => r.v)).toEqual([
      "off · every read hauls the tarball",
      "no Supabase env — nothing is recorded",
      "no Supabase env — nothing is scored",
    ]);
    // A store that IS configured and did not answer is a different fault, and still says so.
    const gone = pipeline(null, null, null, NOW);
    expect(gone).toMatchObject({ state: "unreachable", tone: "warn" });
    expect(gone.rows[0].v).toBe("unreachable this render");
    expect(gone.rows.map((r) => r.v)).toContain("telemetry unreachable");
    expect(gone.rows.map((r) => r.v)).toContain("temperatures unreachable");
  });
  it("reads a live mirror, the access breakdown and the temperatures", () => {
    const p = pipeline(
      { state: "live", gitHead: "abcdef0123", mirrorHead: "abcdef0123", notes: 41, syncedAt: new Date(NOW - 5 * 60_000).toISOString() },
      { last24h: 30, prior24h: 20, byTool: [{ tool: "brain_ask", n: 20 }, { tool: "brain_read", n: 10 }], topNotes: [{ path: "notes/a.md", n: 4 }], basis: 30, firstAt: null },
      { hot: 12, warm: 20, cold: 9, pendingDeletions: 2, coldest: [] },
      NOW
    );
    expect(p).toMatchObject({ state: "in sync", tone: "accent" });
    expect(p.rows.map((r) => [r.k, r.v])).toEqual([
      ["git → Postgres mirror", "41 notes"], ["served at commit", "abcdef01"], ["last reconciled", "5 min ago"],
      ["notes served · 24 h", "ask 20 · read 10"], ["most read", "a ×4"],
      ["what every session loads", "12 hot · 20 warm · 9 cold"], ["deletion candidates", "2 awaiting your call"],
    ]);
    expect(p.notes).toEqual(["nothing is ever deleted automatically — review on Attention"]);
  });
});

describe("recent saves (W14)", () => {
  const lite = (path: string) => ({ path, title: path, desc: "", dir: path.split("/")[0], blocks: 3, tokens: 100, retracted: 0, age: 0 });

  it("ties a commit to the note its message names, only when the corpus holds it", () => {
    const notes = new Map([["log/2026-09-05.md", { path: "log/2026-09-05.md", title: "5 Sep", desc: "", dir: "log", blocks: 3, tokens: 100, retracted: 0, age: 0 }]]);
    const s = saves([{ sha: "1", message: "log 2026-09-05: wrap", date: "" }, { sha: "2", message: "notes/missing: x", date: "" }, { sha: "3", message: "chore", date: "" }, { sha: "4", message: "brain: append log/2026-09-05.md", date: "" }], notes);
    expect(s[0].note?.path).toBe("log/2026-09-05.md");
    expect(s[1].note).toBeNull();
    expect(s[2].note).toBeNull();
    expect(s[3].note?.path).toBe("log/2026-09-05.md");
  });

  it("ties the shapes the brain itself commits, capture included", () => {
    // brain_capture writes log/<date>.md under a message that opens `brain: capture`, so a day
    // log saved from a session tied to nothing while the same note saved from the CLI tied fine.
    const notes = new Map([
      ["log/2026-09-05.md", lite("log/2026-09-05.md")],
      ["notes/example-1.md", lite("notes/example-1.md")],
      ["projects/example-fixture.md", lite("projects/example-fixture.md")],
    ]);
    const tie = (message: string) => saves([{ sha: "1", message, date: "" }], notes)[0].note?.path ?? null;
    expect(tie("brain: capture 2026-09-05 14:20")).toBe("log/2026-09-05.md");
    expect(tie("log 2026-09-05: wrap")).toBe("log/2026-09-05.md");
    expect(tie("brain: write notes/example-1.md")).toBe("notes/example-1.md");
    expect(tie("brain: append projects/example-fixture.md")).toBe("projects/example-fixture.md");
    expect(tie("brain: regenerate index")).toBeNull();
    // A capture whose day the corpus does not hold ties to nothing rather than to a guess.
    expect(tie("brain: capture 2026-01-01 09:00")).toBeNull();
  });
});

describe("labels", () => {
  it("speak one dialect", () => {
    expect(agoLabel(NOW - 10_000, NOW)).toBe("just now");
    expect(agoLabel(NOW - 5 * 60_000, NOW)).toBe("5 min ago");
    expect(agoLabel(NOW - 3 * H, NOW)).toBe("3 hr ago");
    expect(agoLabel(NOW - 3 * D, NOW)).toBe("3 d ago");
    expect(coversLabel(30_000)).toBe("log just started");
    expect(coversLabel(20 * 60_000)).toBe("log covers 20 min");
    expect(coversLabel(9 * D)).toBe("log covers 9 d");
  });
});
