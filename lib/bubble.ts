/**
 * bubble — working memory. The layer that lets a session on any surface pick up where the last
 * one left off, and the one class of data Postgres owns outright (spec §7.1, §7.3).
 *
 * Not notes: notes are durable and git-authoritative. Not a transcript: nothing is logged
 * passively. Items are written DELIBERATELY, corrected in place, and leave in exactly two ways —
 * FILED into a note (they mattered; the caller writes the note first, then marks the item with
 * where it went) or AGED OUT (they did not; a read-path sweep flips anything untouched for
 * 14 days). Filed and aged items are never deleted — deletion is a human decision, and both are
 * evidence for the temperature system later.
 *
 * The render is BUDGETED because the bubble rides the boot call. It behaves the way the spec
 * says working memory must: never unbounded, and what does not fit is counted out loud.
 */
import { safeText, MAX_DESCRIPTION } from "./frontmatter";

export type BubbleKind = "focus" | "decision" | "question" | "handoff";

export interface BubbleItem {
  id: number;
  kind: BubbleKind;
  project: string;
  body: string;
  status: "open" | "filed" | "aged";
  filed_into: string;
  surface: string;
  touched_at: string;
  created_at: string;
}

/** The one read: the freshest page, the TRUE open total, and how many the sweep just aged. */
export interface BubbleRead {
  items: BubbleItem[];
  total: number;
  swept: number;
}

export interface BubbleStore {
  /** Open items, freshest touch first — one RPC that sweeps, counts and returns together, so
   *  the numbers a render states are exact rather than page-local. */
  open(): Promise<BubbleRead>;
  add(kind: BubbleKind, body: string, project: string, surface: string): Promise<BubbleItem>;
  /** Update body/kind/project in place; bumps touched_at. Returns null when the id is not open. */
  update(id: number, patch: { body?: string; kind?: BubbleKind; project?: string }): Promise<BubbleItem | null>;
  /** Mark filed into a note the caller has ALREADY written. Returns null when the id is not open. */
  file(id: number, notePath: string): Promise<BubbleItem | null>;
  /** Manual age-out. Returns null when the id is not open. */
  drop(id: number): Promise<BubbleItem | null>;
}

const REQUEST_TIMEOUT_MS = 10_000;
export const MAX_AGE_DAYS = 14;

/** Test seam, same contract as mirror.ts's __setStore. */
let overridden: BubbleStore | null | undefined;
export function __setBubbleStore(s: BubbleStore | null | undefined): void {
  overridden = s;
}

/** Null when the Supabase env is absent — the bubble simply does not exist on a zero-env deploy,
 *  and every caller degrades to the phase-2 behaviour it replaced. */
export function bubbleStore(): BubbleStore | null {
  if (overridden !== undefined) return overridden;
  const base = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!base || !key) return null;
  return pgrstBubble(base.replace(/\/$/, ""), key);
}

function pgrstBubble(base: string, key: string): BubbleStore {
  async function call(path: string, init: RequestInit = {}): Promise<Response> {
    const res = await fetch(`${base}/rest/v1/${path}`, {
      ...init,
      headers: {
        apikey: key,
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
        ...(init.headers ?? {}),
      },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!res.ok) {
      // Status only — tools.ts hands e.message to callers, and a PostgREST body is an
      // uncontrolled upstream channel.
      throw new Error(`bubble: ${init.method ?? "GET"} ${path.split("?")[0]} ${res.status}`);
    }
    return res;
  }

  async function one(res: Response): Promise<BubbleItem | null> {
    const rows = (await res.json()) as BubbleItem[];
    return rows[0] ?? null;
  }

  return {
    async open() {
      // One transaction: sweep (so "open" means what it says without a scheduled job), the true
      // total, and the page. Two calls here once meant two 10s exposures on the boot path and a
      // page presented as the universe.
      const res = await call("rpc/bubble_open", {
        method: "POST",
        body: JSON.stringify({ max_age_days: MAX_AGE_DAYS, max_items: 200 }),
      });
      return (await res.json()) as BubbleRead;
    },

    async add(kind, body, project, surface) {
      const res = await call("bubble_items", {
        method: "POST",
        headers: { Prefer: "return=representation" },
        body: JSON.stringify([{ kind, body, project, surface }]),
      });
      return (await one(res))!;
    },

    async update(id, patch) {
      const res = await call(`bubble_items?id=eq.${id}&status=eq.open`, {
        method: "PATCH",
        headers: { Prefer: "return=representation" },
        body: JSON.stringify({ ...patch, touched_at: new Date().toISOString() }),
      });
      return one(res);
    },

    async file(id, notePath) {
      const res = await call(`bubble_items?id=eq.${id}&status=eq.open`, {
        method: "PATCH",
        headers: { Prefer: "return=representation" },
        body: JSON.stringify({ status: "filed", filed_into: notePath, touched_at: new Date().toISOString() }),
      });
      return one(res);
    },

    async drop(id) {
      const res = await call(`bubble_items?id=eq.${id}&status=eq.open`, {
        method: "PATCH",
        headers: { Prefer: "return=representation" },
        body: JSON.stringify({ status: "aged", touched_at: new Date().toISOString() }),
      });
      return one(res);
    },
  };
}

/** Bytes of rendered bubble the boot call will spend. ~1.5k tokens — working state, not an essay. */
export const BUBBLE_BUDGET_BYTES = 6_000;

const KIND_LABEL: Record<BubbleKind, string> = {
  focus: "FOCUS",
  decision: "DECISION",
  question: "QUESTION",
  handoff: "HANDOFF",
};

function age(touched: string): string {
  const ms = Date.now() - Date.parse(touched);
  const h = Math.floor(ms / 3_600_000);
  if (h < 1) return "just now";
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return `${d}d ago`;
}

/**
 * The boot-call section. Newest touch first, budgeted — and every number is measured against the
 * store's OWN total, not the fetched page, so what is not shown is counted exactly. The sweep is
 * disclosed too: an item the reaper took is reported, never disappeared.
 */
export function renderBubble(read: BubbleRead): string {
  const { items, total, swept } = read;
  if (items.length === 0 && swept === 0) return "";
  const lines: string[] = [];
  let spent = 0;
  let rendered = 0;
  for (const it of items) {
    // Through safeText, the same gate every note-derived string passes before a rendered
    // surface: no control characters (a newline in a body must not forge a second row), no
    // field separator, and a length bound so one chatty item cannot eat the whole section.
    const line = `- [#${it.id} ${KIND_LABEL[it.kind]}${safeText(it.project, 40) ? ` · ${safeText(it.project, 40)}` : ""} · ${age(it.touched_at)}] ${safeText(it.body, 300)}`;
    if (spent + line.length > BUBBLE_BUDGET_BYTES) continue;
    lines.push(line);
    spent += line.length;
    rendered++;
  }
  const notShown = total - rendered;
  const notes: string[] = [];
  if (notShown > 0) notes.push(`${notShown} more open item${notShown === 1 ? "" : "s"} not shown — brain_bubble list for all`);
  if (swept > 0) notes.push(`${swept} item${swept === 1 ? "" : "s"} just aged out (untouched ${MAX_AGE_DAYS}+ days)`);
  const tail = notes.length ? `\n(${notes.join(" · ")})` : "";
  if (lines.length === 0) return tail ? `# BUBBLE (working state — update with brain_bubble)\n${tail}` : "";
  return `# BUBBLE (working state — update with brain_bubble)\n\n${lines.join("\n")}${tail}`;
}

/** The full listing brain_bubble returns for `list` — no byte budget, but the page is finite and
 *  says so against the true total. */
export function renderBubbleList(read: BubbleRead): string {
  const { items, total, swept } = read;
  if (items.length === 0) {
    const sweptNote = swept > 0 ? ` (${swept} item${swept === 1 ? "" : "s"} just aged out — untouched ${MAX_AGE_DAYS}+ days)` : "";
    return `Bubble is empty${sweptNote}. Nothing is marked in progress — add what you are working on with brain_bubble add.`;
  }
  const lines = items.map(
    (it) =>
      `- [#${it.id} ${KIND_LABEL[it.kind]}${safeText(it.project, 40) ? ` · ${safeText(it.project, 40)}` : ""} · touched ${age(it.touched_at)}] ${safeText(it.body, MAX_DESCRIPTION * 10)}`
  );
  const head = total > items.length ? `showing ${items.length} of ${total} open items` : `${total} open item${total === 1 ? "" : "s"}`;
  const sweptNote = swept > 0 ? `\n(${swept} item${swept === 1 ? "" : "s"} just aged out — untouched ${MAX_AGE_DAYS}+ days)` : "";
  return `${head}:\n${lines.join("\n")}${sweptNote}\n\nUpdate in place, file into a note once durable, or drop what stopped mattering. Items untouched ${MAX_AGE_DAYS} days age out on their own.`;
}