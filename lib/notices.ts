// Notices are ops_events with a read mark — a filtered view, never a second source of truth.
// Read state is per deployment (one mark shared by every device the operator has stamped); a
// per-device mark needs its own cookie and is deferred to sub-project 2. `stampValue()` is one
// constant per deployment, so hashing it cannot tell two of the operator's devices apart.
import { createHash } from "node:crypto";
import { kv, kvEnv } from "./kv";
import type { OpsEvent } from "./ops";

export type NoticeTab = "all" | "needs_you" | "runs" | "receipts" | "mail";
export interface Notice { id: number; at: string; unit: string; tab: Exclude<NoticeTab, "all">; title: string; line: string; field: { text: string; tone: "ok" | "warn" | "crit" | "paper" } | null; unread: boolean; controls: Array<"ack" | "snooze"> }

const sha = (u: string) => { const m = /\/commit\/([0-9a-f]{7,40})/.exec(u); return m ? m[1].slice(0, 8) : u.slice(0, 24); };

export function buildNotices(events: OpsEvent[], unitNames: Map<string, string>, readUpTo: number): Notice[] {
  const out: Notice[] = [];
  for (const e of events) {
    if (e.kind === "read" || e.id == null) continue;
    const name = unitNames.get(e.unit_id) ?? e.unit_id;
    const base = { id: e.id, at: e.at ?? "", unit: e.unit_id, unread: e.id > readUpTo, controls: [] as Array<"ack" | "snooze"> };
    if (e.kind === "alert_sent") out.push({ ...base, tab: "mail", title: `Mail accepted by provider · ${name} → ${e.to_state ?? ""}`, line: `inbox delivery unconfirmed · resend ${String(e.body?.id ?? "")}`, field: null });
    else if (e.kind === "alert_failed") out.push({ ...base, tab: "mail", title: `Mail failed · ${name}`, line: "alert_failed logged · shown here because nothing else would have told you", field: { text: `mail failed · ${String(e.body?.error ?? "")}`, tone: "crit" } });
    else if (e.kind === "transition" && e.to_state === "needs_you") out.push({ ...base, tab: "needs_you", title: `${name} needs you`, line: "answer, acknowledge, or snooze", field: null, controls: ["ack", "snooze"] });
    else if (e.kind === "transition" && (e.to_state === "crashed" || e.to_state === "missed" || e.to_state === "failed")) out.push({ ...base, tab: "runs", title: `${name} ${e.from_state ?? ""} → ${e.to_state}`, line: "derived by the sweep", field: { text: e.to_state, tone: "crit" } });
    else if (e.kind === "finish") { const evi = Array.isArray(e.body?.evidence) ? (e.body!.evidence as string[])[0] : undefined; out.push({ ...base, tab: "runs", title: `${name} finished`, line: typeof e.body?.summary === "string" ? e.body.summary : (e.to_state ?? ""), field: evi ? { text: sha(evi), tone: "ok" } : e.to_state === "unverified" ? { text: "no evidence", tone: "warn" } : null }); }
    else if (e.kind === "start") out.push({ ...base, tab: "runs", title: `${name} started`, line: "lock taken", field: null });
    else if (e.kind === "ack" || e.kind === "snooze" || e.kind === "pause" || e.kind === "resume" || e.kind === "run_now") out.push({ ...base, tab: "receipts", title: `Receipt · you ${e.kind === "run_now" ? "ran" : e.kind === "ack" ? "acknowledged" : e.kind + "d"} ${name}`, line: `receipt ${e.id}`, field: e.kind === "snooze" ? { text: `until ${String(e.body?.until ?? "").slice(0, 16)}`, tone: "warn" } : null });
  }
  return out;
}

/** Keyed by a hash of the stamp so the raw secret never lands in KV — not to separate devices. */
export function readMarkKey(deviceStamp: string): string {
  return `cortex:notices:${kvEnv()}:${createHash("sha256").update(deviceStamp).digest("hex").slice(0, 16)}`;
}
export async function readReadMark(deviceStamp: string): Promise<number> {
  const r = kv(); if (!r) return 0;
  try { const v = await Promise.race([r.get<number>(readMarkKey(deviceStamp)), new Promise<null>((res) => setTimeout(() => res(null), 1500))]); return typeof v === "number" ? v : 0; } catch { return 0; }
}
export async function writeReadMark(deviceStamp: string, upTo: number): Promise<void> {
  const r = kv(); if (!r) return;
  try { await r.set(readMarkKey(deviceStamp), upTo, { ex: 90 * 86400 }); } catch { /* a lost read mark re-shows a notice; accepted */ }
}
