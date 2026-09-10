#!/usr/bin/env npx tsx
/**
 * lifecycle-sweep — read the temperature split, and nominate notes that have earned retirement.
 *
 * READ-ONLY BY DEFAULT. Without --propose it reports what is already there and changes nothing.
 * With --propose it calls propose_deletions(), which INSERTS nominations and never removes a
 * note: the decision column stays null until a person fills it. There is deliberately no flag
 * here that deletes anything.
 *
 * Usage:
 *   SUPABASE_URL=… SUPABASE_SERVICE_ROLE_KEY=… npx tsx scripts/lifecycle-sweep.ts
 *   …                                          npx tsx scripts/lifecycle-sweep.ts --propose [--days 180]
 *
 * The service-role key is the right credential and the only one that works: the migration revoked
 * execute on propose_deletions from public, anon and authenticated, leaving service_role.
 */
import { summariseLifecycle, type Candidate, type TempCount } from "../lib/lifecycle";

const url = process.env.SUPABASE_URL?.replace(/\/$/, "");
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) {
  console.error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must both be set.");
  process.exit(2);
}
const propose = process.argv.includes("--propose");
const daysAt = process.argv.indexOf("--days");
const days = daysAt >= 0 ? Number(process.argv[daysAt + 1]) : 180;
if (!Number.isFinite(days) || days < 1) {
  console.error(`--days must be a positive number, got ${process.argv[daysAt + 1]}`);
  process.exit(2);
}

const headers = { apikey: key, Authorization: `Bearer ${key}`, "Content-Type": "application/json" };

async function rest<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(`${url}/rest/v1/${path}`, {
    ...init,
    headers: { ...headers, ...(init.headers ?? {}) },
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) throw new Error(`${init.method ?? "GET"} ${path} → ${res.status} ${(await res.text()).slice(0, 200)}`);
  return (await res.json()) as T;
}

async function main(): Promise<void> {
  if (propose) {
    const n = await rest<number>("rpc/propose_deletions", {
      method: "POST",
      body: JSON.stringify({ min_age_days: days }),
    });
    console.log(`propose_deletions(${days}) nominated ${n} new note(s)`);
  }

  // note_scores is a view over the mirror; one row per scored note.
  const scored = await rest<Array<{ temperature: string }>>("note_scores?select=temperature");
  const byTemp = new Map<string, number>();
  for (const r of scored) byTemp.set(r.temperature, (byTemp.get(r.temperature) ?? 0) + 1);
  const temps: TempCount[] = [...byTemp].map(([temperature, n]) => ({ temperature, n }));

  const candidates = await rest<Candidate[]>(
    "deletion_candidates?select=path,reason&decision=is.null"
  );

  console.log(summariseLifecycle(temps, candidates));
  if (!propose) console.log("\nread-only — re-run with --propose to nominate new candidates.");
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  });
}
