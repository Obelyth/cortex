/**
 * pins — the operator's explicit temperature overrides, read and written.
 *
 * note_pins has existed since the temperature migration (20260806220000) and note_scores has
 * honoured it from day one: a pinned temperature outranks the computed score, in both
 * directions — pinning something hot keeps it in the seat, pinning it cold says "I know this
 * looks busy, it is noise". What was missing was any interface for the operator to actually
 * place one. This module is that interface's data layer; the console's gated POST is the door.
 *
 * GLOBAL BY SCHEMA. note_pins is keyed on path alone — a pin holds everywhere, not per project.
 * Per-project pinning would need a schema change and is deliberately not smuggled in here.
 *
 * Store plumbing follows lib/edges.ts: raw PostgREST fetch, hard per-request budget, and null
 * for every not-an-answer state on reads — store off, table missing, store unwell — because a
 * surface must degrade to "pins unavailable" honestly rather than render "nothing is pinned"
 * out of a table it could not reach. The two claims read the same and mean opposite things.
 */
import type { Temperature } from "./frontmatter";

/** One row of note_pins, exactly as the migration defines it. */
export interface PinRow {
  path: string;
  temperature: Temperature;
  reason: string;
  pinned_at: string;
}

export interface PinStore {
  /** Every pin, or null when the store cannot answer. */
  all(): Promise<PinRow[] | null>;
  /** Place or move a pin — one row per path, so setting an existing pin replaces it. */
  set(path: string, temperature: Temperature, reason: string): Promise<void>;
  /** Remove a pin. Removing a pin that does not exist is a no-op, not an error. */
  clear(path: string): Promise<void>;
}

const PINS_TIMEOUT_MS = 10_000;

/** Test seam, same contract as mirror.ts's __setStore: undefined = derive from env, anything
 *  else — including null — is served as-is. */
let overridden: PinStore | null | undefined;
export function __setPinStore(s: PinStore | null | undefined): void {
  overridden = s;
}

function env(): { base: string; key: string } | null {
  const base = process.env.SUPABASE_URL?.replace(/\/$/, "");
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  return base && key ? { base, key } : null;
}

function pg(e: { base: string; key: string }, path: string, init: RequestInit = {}): Promise<Response> {
  return fetch(`${e.base}/rest/v1/${path}`, {
    ...init,
    headers: {
      apikey: e.key,
      Authorization: `Bearer ${e.key}`,
      "Content-Type": "application/json",
      ...(init.headers ?? {}),
    },
    signal: AbortSignal.timeout(PINS_TIMEOUT_MS),
  });
}

/** Null when the Supabase env is absent — the opt-in law: no store, no pins, and every surface
 *  says so rather than pretending an empty pin list. */
export function pinStore(): PinStore | null {
  if (overridden !== undefined) return overridden;
  const e = env();
  if (!e) return null;
  return {
    async all() {
      try {
        const res = await pg(e, "note_pins?select=path,temperature,reason,pinned_at&order=path.asc");
        if (!res.ok) return null;
        return (await res.json()) as PinRow[];
      } catch (err) {
        console.error(`[pins] read unavailable — surfaces render without pin detail: ${String(err)}`);
        return null;
      }
    },

    async set(path, temperature, reason) {
      // Upsert on the primary key: re-pinning a path replaces its row rather than erroring,
      // because "move this pin from hot to cold" is one operator gesture, not delete-then-add.
      const res = await pg(e, "note_pins?on_conflict=path", {
        method: "POST",
        headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
        body: JSON.stringify([{ path, temperature, reason, pinned_at: new Date().toISOString() }]),
      });
      // Status only — the caller shows e.message to the operator, and a PostgREST error body
      // is an uncontrolled upstream channel (the same posture as mirror.ts and bubble.ts).
      if (!res.ok) throw new Error(`pins: POST note_pins ${res.status}`);
    },

    async clear(path) {
      const res = await pg(e, `note_pins?path=eq.${encodeURIComponent(path)}`, {
        method: "DELETE",
        headers: { Prefer: "return=minimal" },
      });
      if (!res.ok) throw new Error(`pins: DELETE note_pins ${res.status}`);
    },
  };
}

/** Every pin, or null when pins cannot be read — store off or store unwell. Convenience over
 *  pinStore() for read-only callers (the heat view, the handoff bundle). */
export async function readPins(): Promise<PinRow[] | null> {
  const store = pinStore();
  if (!store) return null;
  return store.all();
}
