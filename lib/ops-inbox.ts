/**
 * The Ops rail's inbox, as spec §5 drew it: a cyan field with its count, the top three lines,
 * and a way out to the screen where the work happens.
 *
 * Not the Attention screen. That screen is a two-column working surface — a detail pane, a
 * 30px heading, three write buttons — and mounting it whole inside a 380px rail is what put its
 * buttons past the viewport edge and made the rail a 1400px block that shoved the controls to
 * the foot of the page (critique 2026-09-05, P0). A rail summarises and points; the Attention
 * screen keeps its route and its job.
 */
import type { TriageItem } from "./health";
import type { Proposal } from "./proposals";

export interface InboxLine { sev: TriageItem["sev"]; title: string; loc: string }

export interface InboxSummary {
  /** Everything waiting on a person: triage findings plus pending proposals. */
  count: number;
  triage: number;
  proposals: number;
  /** The first INBOX_LINES, most urgent first — crit, warn, watch — then by location, so the
   *  same queue renders the same three lines on every device. */
  lines: InboxLine[];
  /** How many findings sit behind the lines shown. */
  more: number;
}

export const INBOX_LINES = 3;
const SEV_RANK: Record<TriageItem["sev"], number> = { crit: 0, warn: 1, watch: 2 };

export function inboxSummary(queue: TriageItem[], proposals: Proposal[]): InboxSummary {
  const sorted = [...queue].sort((a, b) => SEV_RANK[a.sev] - SEV_RANK[b.sev] || a.loc.localeCompare(b.loc));
  const lines = sorted.slice(0, INBOX_LINES).map((q) => ({ sev: q.sev, title: q.title, loc: q.loc }));
  return {
    count: queue.length + proposals.length,
    triage: queue.length,
    proposals: proposals.length,
    lines,
    more: Math.max(0, sorted.length - lines.length),
  };
}

/** A severity as the field tone the console paints it in. watch is paper: structure worth a
 *  glance, never a colour. */
export function sevTone(sev: TriageItem["sev"]): "crit" | "warn" | "paper" {
  return sev === "crit" ? "crit" : sev === "warn" ? "warn" : "paper";
}

/**
 * The Decisions panel (v2): everything waiting on a person, as one list the lens opens from —
 * the whole item, not a three-line summary, because the lens shows its evidence, its why and
 * its buttons. Proposals lead: a stranger asking to put something in the brain outranks a
 * finding the corpus made about itself (attention/page.tsx); then the queue in the order
 * inboxSummary prints it. Ids are unique within one list so the lens can name what it shows
 * and notice when that item has left.
 */
export type DecisionItem =
  | { id: string; kind: "triage"; sev: TriageItem["sev"]; title: string; loc: string; item: TriageItem }
  | { id: string; kind: "proposal"; sev: "proposal"; title: string; loc: string; proposal: Proposal };

export function decisionItems(queue: TriageItem[], proposals: Proposal[]): DecisionItem[] {
  const sorted = [...queue].sort((a, b) => SEV_RANK[a.sev] - SEV_RANK[b.sev] || a.loc.localeCompare(b.loc));
  const seen = new Map<string, number>();
  const unique = (base: string) => { const n = seen.get(base) ?? 0; seen.set(base, n + 1); return n ? `${base}#${n}` : base; };
  return [
    ...proposals.map((p): DecisionItem => ({ id: unique(`proposal:${p.id}`), kind: "proposal", sev: "proposal", title: proposalTitle(p), loc: `${p.client ?? "client unstated"} → ${p.path}`, proposal: p })),
    ...sorted.map((q): DecisionItem => ({ id: unique(`triage:${q.kind ?? "danger"}:${q.loc}`), kind: "triage", sev: q.sev, title: q.title, loc: q.loc, item: q })),
  ];
}

/** The first line of the proposed text, cut for a list row. Untrusted prose, rendered as text;
 *  the lens shows the whole of it, verbatim, before anyone decides. */
export function proposalTitle(p: Proposal, max = 96): string {
  const line = p.content.split("\n").map((l) => l.trim()).find(Boolean) ?? "";
  const text = line || `${p.mode} → ${p.path}`;
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}
