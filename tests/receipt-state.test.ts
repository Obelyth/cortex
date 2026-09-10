import { describe, it, expect } from "vitest";
import { receiptReducer, DONE_HOLD_MS, type ReceiptState } from "../lib/receipt-state";
const rest: ReceiptState = { phase: "rest", receipt: null, error: null, since: 0 };
describe("receiptReducer", () => {
  it("press → working; ok → done with the receipt; settle after the hold → rest", () => {
    const w = receiptReducer(rest, { type: "press", at: 100 }); expect(w.phase).toBe("working");
    const d = receiptReducer(w, { type: "ok", receipt: 42, at: 600 }); expect(d).toMatchObject({ phase: "done", receipt: 42, since: 600 });
    expect(receiptReducer(d, { type: "settle", at: 600 + DONE_HOLD_MS - 1 }).phase).toBe("done");
    expect(receiptReducer(d, { type: "settle", at: 600 + DONE_HOLD_MS }).phase).toBe("rest");
  });
  it("fail → failed with the error; a new press clears it", () => {
    const f = receiptReducer({ ...rest, phase: "working" }, { type: "fail", error: "ledger unreachable this render", at: 5 });
    expect(f).toMatchObject({ phase: "failed", error: "ledger unreachable this render" });
    expect(receiptReducer(f, { type: "press", at: 9 })).toMatchObject({ phase: "working", error: null });
  });
  it("ignores ok/fail while at rest (a stale response)", () => expect(receiptReducer(rest, { type: "ok", receipt: 1, at: 1 })).toBe(rest));
  it("reset clears a done/failed chip back to rest, but is ignored while a request is in flight", () => {
    expect(receiptReducer({ phase: "done", receipt: 42, error: null, since: 600 }, { type: "reset", at: 700 })).toEqual({ phase: "rest", receipt: null, error: null, since: 700 });
    const working: ReceiptState = { phase: "working", receipt: null, error: null, since: 100 };
    expect(receiptReducer(working, { type: "reset", at: 200 })).toBe(working);
  });
});
