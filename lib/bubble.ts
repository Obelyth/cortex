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
import { normaliseProject } from "./project";
import { utf8Bytes } from "./utf8";
import { BUBBLE_KINDS } from "./bubble-fields";
import type { WorkingCommand, WorkingQuery } from "./working-state-contract";

/** The four kinds, as a value: the console composes a class per kind (`ovWsKind-<kind>`) and its
 *  classes test must be able to enumerate them rather than keep a second hand-written list. */
export { BUBBLE_KINDS } from "./bubble-fields";
export type BubbleKind = (typeof BUBBLE_KINDS)[number];

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
  /** Separate management contract; never silently falls back to unversioned table writes. */
  manage?(query: WorkingQuery | { id: number }): Promise<unknown>;
  change?(command: WorkingCommand): Promise<unknown>;
  /** Open items, freshest touch first — one RPC that sweeps, counts and returns together, so
   *  the numbers a render states are exact rather than page-local. */
  open(scope?: { project: string; includeGeneral: boolean }): Promise<BubbleRead>;
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

export class BubbleManagementError extends Error {
  constructor(readonly migrationRequired: boolean) { super("working-state store unavailable"); }
}

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
      if (path.startsWith("rpc/bubble_console_")) {
        const data = await res.json().catch(() => null) as { code?: unknown } | null;
        throw new BubbleManagementError(res.status === 404 || data?.code === "42703" || data?.code === "42883" || data?.code === "PGRST202");
      }
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
    async manage(query) {
      const path = "id" in query ? "rpc/bubble_console_item" : "rpc/bubble_console_list";
      const body = "id" in query ? {item_id:query.id} : {
        project_name:query.project,before_touched:query.before?.touched_at??null,before_id:query.before?.id??null,page_size:20,
      };
      return (await call(path,{method:"POST",body:JSON.stringify(body)})).json();
    },
    async change(command) {
      const add = command.action === "add";
      const body = add ? {request_key:command.requestKey,item_kind:command.kind,item_body:command.body,project_name:command.project} : {
        item_id:command.id,expected_version:command.version,item_kind:command.action==="edit"?command.kind??null:null,
        item_body:command.action==="edit"?command.body??null:null,project_name:command.action==="edit"?command.project??null:null,age_out:command.action==="drop",
      };
      return (await call(add?"rpc/bubble_console_add":"rpc/bubble_console_edit",{method:"POST",body:JSON.stringify(body)})).json();
    },
    async open(scope) {
      // One transaction: sweep (so "open" means what it says without a scheduled job), the true
      // total, and the page. Two calls here once meant two 10s exposures on the boot path and a
      // page presented as the universe.
      const project = scope ? normaliseProject(scope.project) : "";
      const res = await call(scope ? "rpc/bubble_open_scoped" : "rpc/bubble_open", {
        method: "POST",
        body: JSON.stringify(scope
          ? { max_age_days: MAX_AGE_DAYS, max_items: 200, project_name: project, include_general: scope.includeGeneral }
          : { max_age_days: MAX_AGE_DAYS, max_items: 200 }),
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
 *
 * SCOPED when brain_context is called for one project: only that project's items and the general
 * (project-less) ones ride, so a session picking up cortex is not handed the ego backlog. General
 * items always ride because they belong to no project and so bleed into none — they are the
 * cross-cutting working state. Scoping changes the "not shown" accounting: the store's total
 * counts every open item across every project, which is not what a scoped view left out, so a
 * scoped section names the filter and points at `brain_bubble list` for the global total rather
 * than quoting a subtraction that would read as "12 more cortex items" when they are ego ones.
 */
export function bubbleView(read: BubbleRead, project?: string): { text: string; usableItems: number; renderedItems: number } {
  const { total, swept } = read;
  const scope = project ? normaliseProject(project) : "";
  const items = scope
    ? read.items.filter((it) => {
        const p = normaliseProject(it.project);
        return p === scope || p === "";
      })
    : read.items;
  if (items.length === 0 && swept === 0) {
    // A scoped view with nothing for this project still says so, so the reader can tell "no
    // working state here" apart from "the bubble is off" (which degrades to logs upstream).
    const text = scope ? `# BUBBLE (working state — update with brain_bubble)\n\n(no open items for ${safeText(scope, 40)} · brain_bubble list for all open items)` : "";
    return { text, usableItems: 0, renderedItems: 0 };
  }
  const lines: string[] = [];
  let rendered = 0;
  for (const it of items) {
    // Through safeText, the same gate every note-derived string passes before a rendered
    // surface: no control characters (a newline in a body must not forge a second row), no
    // field separator, and a length bound so one chatty item cannot eat the whole section.
    const line = `- [#${it.id} ${KIND_LABEL[it.kind]}${safeText(it.project, 40) ? ` · ${safeText(it.project, 40)}` : ""} · ${age(it.touched_at)}] ${safeText(it.body, 300)}`;
    const candidate = [...lines, line];
    const candidateRendered = rendered + 1;
    const notes: string[] = [];
    if (scope) {
      const notShown = Math.max(0, total - candidateRendered);
      if (notShown > 0) notes.push(`${notShown} more ${safeText(scope, 40)}/general item${notShown === 1 ? "" : "s"} not shown — brain_bubble list for all`);
      else notes.push(`scoped to ${safeText(scope, 40)} + general · brain_bubble list for all open items`);
    } else if (total - candidateRendered > 0) {
      const notShown = total - candidateRendered;
      notes.push(`${notShown} more open item${notShown === 1 ? "" : "s"} not shown — brain_bubble list for all`);
    }
    if (swept > 0) notes.push(`${swept} item${swept === 1 ? "" : "s"} just aged out (untouched ${MAX_AGE_DAYS}+ days)`);
    const tail = notes.length ? `\n(${notes.join(" · ")})` : "";
    const doc = `# BUBBLE (working state — update with brain_bubble)\n\n${candidate.join("\n")}${tail}`;
    if (utf8Bytes(doc) > BUBBLE_BUDGET_BYTES) continue;
    lines.push(line);
    rendered = candidateRendered;
  }
  const notes: string[] = [];
  if (scope) {
    // The scoped RPC's total is already filtered before its database page limit. Subtract what
    // this section genuinely rendered so both rows beyond that page and fetched rows refused by
    // this render budget remain visible in one exact count.
    const notShown = Math.max(0, total - rendered);
    if (notShown > 0) notes.push(`${notShown} more ${safeText(scope, 40)}/general item${notShown === 1 ? "" : "s"} not shown — brain_bubble list for all`);
    else notes.push(`scoped to ${safeText(scope, 40)} + general · brain_bubble list for all open items`);
  } else {
    const notShown = total - rendered;
    if (notShown > 0) notes.push(`${notShown} more open item${notShown === 1 ? "" : "s"} not shown — brain_bubble list for all`);
  }
  if (swept > 0) notes.push(`${swept} item${swept === 1 ? "" : "s"} just aged out (untouched ${MAX_AGE_DAYS}+ days)`);
  const tail = notes.length ? `\n(${notes.join(" · ")})` : "";
  const text = lines.length === 0
    ? tail ? `# BUBBLE (working state — update with brain_bubble)\n${tail}` : ""
    : `# BUBBLE (working state — update with brain_bubble)\n\n${lines.join("\n")}${tail}`;
  // Only rows genuinely present in `text` are usable boot memory. Filter/expiry notices and
  // open rows that the section budget refused must not suppress the bounded recent-log fallback.
  return { text, usableItems: rendered, renderedItems: rendered };
}

export function renderBubble(read: BubbleRead, project?: string): string {
  return bubbleView(read, project).text;
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
