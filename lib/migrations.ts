/**
 * migrations — does the live schema carry every file in supabase/migrations/?
 *
 * Merged/deployed is not applied. This triage read compares names, not execution correctness.
 * scripts/migrate.ts defaults to a read-only check; supported upgrades require explicit apply.
 * Optional database workflows keep credentials isolated from ordinary CI. Pristine installation
 * is a separate administrator SQL bundle; see docs/database-bootstrap.md.
 */
import { readdirSync } from "node:fs";
import { join } from "node:path";
import type { TriageItem } from "./health";

/** Same per-request ceiling as the other small console reads (lib/pulse.ts). */
const REQUEST_TIMEOUT_MS = 6_000;
const byCodeUnit = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/**
 * The migration files this build shipped with, from disk — which is why next.config.ts traces
 * supabase/migrations/ into every function bundle. Null when the directory is not there (a build
 * that did not trace it), so the check goes quiet rather than reporting every migration pending.
 */
export function shippedMigrations(root = process.cwd()): string[] | null {
  try {
    return readdirSync(join(root, "supabase", "migrations"))
      .filter((f) => f.endsWith(".sql"))
      .sort(byCodeUnit);
  } catch {
    return null;
  }
}

/**
 * The ledger scripts/migrate.ts writes, read over PostgREST with the service-role key — the one
 * role the ledger's RLS admits. Null when the mirror is unconfigured (the public product's mode);
 * throws when the store is reachable but refuses, so the caller can say so instead of inferring
 * "nothing pending" from an empty answer.
 */
export async function appliedMigrations(): Promise<string[] | null> {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return null;
  const res = await fetch(`${url.replace(/\/$/, "")}/rest/v1/schema_migrations?select=name`, {
    headers: { apikey: key, Authorization: `Bearer ${key}` },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`migrations: GET schema_migrations ${res.status}`);
  return ((await res.json()) as Array<{ name: string }>).map((r) => r.name);
}

/** Files on disk the ledger has no row for, in apply order. Pure, so the rule is testable. */
export function pendingMigrations(shipped: string[], applied: string[]): string[] {
  const done = new Set(applied);
  return shipped.filter((f) => !done.has(f)).sort(byCodeUnit);
}

/** The triage item, or null when nothing is pending. */
export function pendingMigrationItem(pending: string[]): TriageItem | null {
  if (pending.length === 0) return null;
  const n = pending.length;
  return {
    sev: "warn",
    kind: "pending-migration",
    title: n === 1 ? "A migration is merged but not applied" : `${n} migrations are merged but not applied`,
    loc: `supabase/migrations/${pending[0]}${n > 1 ? ` +${n - 1} more` : ""}`,
    evidence: `${n === 1 ? "This file has" : "These files have"} no row in schema_migrations: ${pending.join(", ")}.`,
    why: "Merged and deployed is not applied. The code already queries what these files create or change, and a missing relation or an old function body degrades quietly — an empty board, a stale score — never as an error. The ops tables sat this way for two days and 20260812040000 for three weeks.",
    action: "Review docs/database-bootstrap.md from the trusted checkout. scripts/migrate.ts is read-only by default; --apply requires an existing supported ledger. Pristine setup is a separate administrator transaction. Never reset existing data or invent ledger rows. This item leaves when the ledger contains every file name.",
  };
}

/** The whole check, for health(). Null on a mirror that is unconfigured, a build that did not
 *  trace the directory, or a ledger that could not be read — each is logged where it is a
 *  surprise, and none is allowed to invent a finding. */
export async function pendingMigrationTriage(): Promise<TriageItem | null> {
  const shipped = shippedMigrations();
  if (!shipped) return null;
  let applied: string[] | null;
  try {
    applied = await appliedMigrations();
  } catch (e) {
    console.error(`[migrations] ledger unreadable, check skipped: ${String(e)}`);
    return null;
  }
  if (!applied) return null;
  return pendingMigrationItem(pendingMigrations(shipped, applied));
}
