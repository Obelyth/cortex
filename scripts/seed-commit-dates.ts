/**
 * seed-commit-dates — fill `notes.last_commit_at` from git history, once.
 *
 * The reconciler learns commit dates going forward, on the patch path. It cannot learn them
 * backwards: a backfilled row knows only when it was mirrored, which is why the first temperature
 * run scored every note 0.97-0.99 on write recency. This script asks GitHub for the last commit
 * touching each path and writes it in.
 *
 * One call per note (86 today), so it is a seed, never a routine. Dry-run by default. It only
 * ever fills NULLs — a date the reconciler already learned is never overwritten by this slower,
 * coarser source.
 *
 * Usage: npx tsx scripts/seed-commit-dates.ts [--apply]
 */
import { readFileSync } from "node:fs";

const apply = process.argv.includes("--apply");

async function main(): Promise<void> {
const env = readFileSync(new URL("../.env.local", import.meta.url).pathname, "utf8");
for (const line of env.split("\n")) {
  const m = line.match(/^([A-Z_]+)=(.*)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim().replace(/^"|"$/g, "");
}

const SUPA = process.env.SUPABASE_URL?.replace(/\/$/, "");
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const REPO = process.env.BRAIN_REPO;
const GH = process.env.GITHUB_TOKEN;
if (!SUPA || !KEY || !REPO || !GH) {
  console.error("need SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, BRAIN_REPO, GITHUB_TOKEN");
  process.exit(2);
}
const H = { apikey: KEY, Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" };

/**
 * Make a value from a response safe to print.
 *
 * Note paths are repo content, so anyone who can land a file in the brain chooses them. A path
 * carrying a newline or a carriage return can forge whole lines in this script's output — invent a
 * "0 unresolved" summary, or overwrite the line above it in a terminal — and the operator reads
 * that output to decide whether the backfill worked. Control characters become "?" and the length
 * is capped, so one row cannot flood the log either.
 */
const safe = (s: string): string =>
  s.replace(/[\u0000-\u001f\u007f-\u009f]/g, "?").slice(0, 200);

const res = await fetch(`${SUPA}/rest/v1/notes?select=path&last_commit_at=is.null&order=path`, { headers: H });
// Both checks are load-bearing, and neither was here. PostgREST answers a bad key with 401 and a
// JSON *object*, so the cast below was a lie on every failure path: `rows.length` came out
// undefined and the loop threw somewhere further down, reporting a destructuring error instead of
// "your credentials are wrong". Fail here, where the cause is still legible.
if (!res.ok) {
  console.error(`postgrest ${res.status} listing notes — check SUPABASE_URL and the service-role key`);
  process.exit(1);
}
const body: unknown = await res.json();
if (!Array.isArray(body)) {
  console.error("postgrest returned a non-array; expected a list of notes");
  process.exit(1);
}
// Built element by element rather than cast. `as Array<{path: string}>` asserted a shape nothing
// had checked: a row whose `path` was null or missing sailed through and became the string
// "undefined" inside a GitHub URL, which then 404s and gets counted as "no commit history" -- a
// silent miscount blamed on git. Anything that is not a non-empty string is now dropped and said
// out loud.
const rows: Array<{ path: string }> = [];
let malformed = 0;
for (const item of body) {
  const p = (item as { path?: unknown })?.path;
  if (typeof p === "string" && p.length > 0) rows.push({ path: p });
  else malformed++;
}
if (malformed) console.error(`${malformed} row(s) had no usable path and were skipped`);
console.log(`${rows.length} note(s) with no commit date`);

let filled = 0;
let missing = 0;
for (const { path } of rows) {
  const r = await fetch(
    `https://api.github.com/repos/${REPO}/commits?path=${encodeURIComponent(path)}&per_page=1`,
    { headers: { Authorization: `Bearer ${GH}`, Accept: "application/vnd.github+json" } }
  );
  if (!r.ok) {
    console.error(`  ${safe(path)}: HTTP ${r.status}`);
    missing++;
    continue;
  }
  const commits = (await r.json()) as Array<{ commit: { author?: { date?: string }; committer?: { date?: string } } }>;
  const at = commits[0]?.commit?.author?.date ?? commits[0]?.commit?.committer?.date ?? null;
  if (!at) {
    // A path git has no history for is a path the mirror should not have. Report, never guess.
    console.error(`  ${safe(path)}: no commit history`);
    missing++;
    continue;
  }
  if (apply) {
    const u = await fetch(`${SUPA}/rest/v1/notes?path=eq.${encodeURIComponent(path)}&last_commit_at=is.null`, {
      method: "PATCH",
      headers: { ...H, Prefer: "return=minimal" },
      body: JSON.stringify({ last_commit_at: at }),
    });
    if (!u.ok) {
      console.error(`  ${safe(path)}: write failed HTTP ${u.status}`);
      missing++;
      continue;
    }
  }
  filled++;
  if (filled <= 5) console.log(`  ${safe(path)} → ${safe(at).slice(0, 10)}`);
}

console.log(`\n${apply ? "filled" : "would fill"} ${filled} · ${missing} unresolved`);
if (!apply) console.log("DRY RUN — re-run with --apply.");
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
