// The feedback grammar's state machine (spec §12.3): press → working → done(receipt) → rest,
// or → failed(error). Pure, so the hook is a thin useReducer around it.
export type ReceiptPhase = "rest" | "working" | "done" | "failed";
export interface ReceiptState { phase: ReceiptPhase; receipt: number | null; error: string | null; since: number }
export type ReceiptEvent = { type: "press"; at: number } | { type: "ok"; receipt: number | null; at: number } | { type: "fail"; error: string; at: number } | { type: "settle"; at: number } | { type: "reset"; at: number };
export const DONE_HOLD_MS = 1800;
export function receiptReducer(s: ReceiptState, e: ReceiptEvent): ReceiptState {
  switch (e.type) {
    case "press": return { phase: "working", receipt: null, error: null, since: e.at };
    case "ok": return s.phase === "working" ? { phase: "done", receipt: e.receipt, error: null, since: e.at } : s;
    case "fail": return s.phase === "working" ? { phase: "failed", receipt: null, error: e.error, since: e.at } : s;
    case "settle": return s.phase === "done" && e.at - s.since >= DONE_HOLD_MS ? { phase: "rest", receipt: s.receipt, error: null, since: e.at } : s;
    // Forces the machine back to rest — the caller (OpsClient's select()) fires this on a row
    // change so a still-visible done/failed chip can never be read against the newly selected
    // row. Ignored while working: a request already in flight owns the state until it settles,
    // and select() itself never calls reset() during "working" (it no-ops first), so this is
    // belt-and-braces against a caller that doesn't guard the same way.
    case "reset": return s.phase === "working" ? s : { phase: "rest", receipt: null, error: null, since: e.at };
  }
}
