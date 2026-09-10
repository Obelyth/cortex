import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { buildNotices, readMarkKey, readReadMark, writeReadMark } from "../lib/notices";
import { resetKvForTests } from "../lib/kv";
import { __setOpsStore, type OpsEvent } from "../lib/ops";
import { GET } from "../app/s/[secret]/console/ops/notices/route";
import { STAMP_COOKIE, stampValue } from "../lib/stamp";

const names = new Map([["groundskeeper", "Brain groundskeeper"], ["console-secret", "Console secret"]]);
const ev = (id: number, kind: OpsEvent["kind"], extra: Partial<OpsEvent> = {}): OpsEvent => ({ id, unit_id: "groundskeeper", run_id: null, at: `2026-09-02T0${id}:00:00Z`, actor: "unit", kind, body: {}, ...extra });

describe("buildNotices", () => {
  const events = [ev(5, "alert_failed", { actor: "sweep", body: { status: 502, error: "resend 502" } }), ev(4, "alert_sent", { actor: "sweep", body: { id: "m1" }, to_state: "crashed" }), ev(3, "ack", { actor: "operator", unit_id: "console-secret" }), ev(2, "finish", { to_state: "succeeded", body: { summary: "2 pages corrected", evidence: ["https://github.com/x/y/commit/abcdef12"] } }), ev(1, "transition", { actor: "sweep", unit_id: "console-secret", to_state: "needs_you" })];
  const n = buildNotices(events, names, 2);
  // Was [id, tab, glyph]. The glyph is gone — the tray draws an unread dot where it used to sit, so
  // the field was produced and asserted but never rendered. The field's TONE replaces it rather than
  // nothing: it is the one per-notice signal that survives to the screen, as the row's chip, and it
  // keeps the discrimination the glyph was carrying here — a succeeded finish and an unverified one
  // share tab "runs" and separate on tone.
  it("maps kinds to tabs, and carries the tone the row will show", () => {
    expect(n.map((x) => [x.id, x.tab, x.field?.tone ?? null])).toEqual([[5, "mail", "crit"], [4, "mail", null], [3, "receipts", null], [2, "runs", "ok"], [1, "needs_you", null]]);
  });
  it("marks unread above the read mark", () => expect(n.map((x) => x.unread)).toEqual([true, true, true, false, false]));
  it("does not confuse provider acceptance with inbox delivery", () => {
    expect(n[1].title).toContain("accepted by provider");
    expect(n[1].line).toContain("inbox delivery unconfirmed");
    expect(n[1].line).not.toContain("delivered");
  });
  it("a needs_you notice carries ack and snooze; mail failures are crit", () => {
    expect(n[4].controls).toEqual(["ack", "snooze"]); expect(n[0].field).toEqual({ text: "mail failed · resend 502", tone: "crit" });
    expect(n[3].field).toEqual({ text: "abcdef12", tone: "ok" });
  });
  it("read events never become notices", () => expect(buildNotices([ev(9, "read")], names, 0)).toEqual([]));
});

describe("read marks", () => {
  beforeEach(() => { resetKvForTests(); vi.stubEnv("KV_REST_API_URL", ""); vi.stubEnv("KV_REST_API_TOKEN", ""); });
  afterEach(() => { vi.unstubAllEnvs(); });
  it("keys by a hash of the device stamp, never the stamp itself", () => { const k = readMarkKey("stamp-secret-value"); expect(k).toMatch(/^cortex:notices:development:[0-9a-f]{16}$/); expect(k).not.toContain("stamp-secret"); });
  it("is 0 and a no-op without KV", async () => { expect(await readReadMark("s")).toBe(0); await expect(writeReadMark("s", 5)).resolves.toBeUndefined(); });
});

describe("GET /s/[secret]/console/ops/notices", () => {
  const SECRET = "notices-route-secret";
  const get = (cookie = `${STAMP_COOKIE}=${stampValue()}`) =>
    GET(new Request("https://cortex.test/s/x/console/ops/notices", { headers: { cookie } }), { params: Promise.resolve({ secret: SECRET }) });
  beforeEach(() => {
    vi.stubEnv("CONNECTOR_PATH_SECRET", SECRET);
    vi.stubEnv("CONSOLE_PASSCODE", "notices-suite passcode");
    __setOpsStore(null);
  });
  afterEach(() => { __setOpsStore(undefined); vi.unstubAllEnvs(); });
  it("degrades to unconfigured with unread: 0 when the store is absent", async () => {
    const r = await get();
    expect(await r.json()).toEqual({ mode: "unconfigured", notices: [], unread: 0 });
  });
  it("is an empty 404 without the device stamp", async () => { expect((await get("")).status).toBe(404); });
});
