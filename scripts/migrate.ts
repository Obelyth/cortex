/**
 * migrate — apply supabase/migrations/*.sql to the database SUPABASE_DB_URL points at.
 *
 * Dry-run by default, because this touches the production mirror. `--apply` runs for real.
 *
 * Deliberately boring: files run in filename order, each inside its own transaction, and every
 * applied file is recorded in `schema_migrations` so a re-run applies only what is new. There is
 * no down-migration machinery — the mirror's schema moves forward only, and anything that needs
 * undoing gets undone by a new migration that says so, the same way the brain corrects notes in
 * place rather than rewriting history.
 *
 * The ledger insert happens INSIDE the migration's transaction: a migration that half-applied and
 * then got recorded — or applied and then failed to be recorded — would leave the ledger lying
 * about the schema, which is this script's only real failure mode.
 *
 * Usage:
 *   SUPABASE_DB_URL=... npx tsx scripts/migrate.ts            # dry run: list what would apply
 *   SUPABASE_DB_URL=... npx tsx scripts/migrate.ts --apply
 */
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import pg from "pg";

const apply = process.argv.includes("--apply");
const allowOutOfOrder = process.argv.includes("--allow-out-of-order");
const sha256 = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");
const url = process.env.SUPABASE_DB_URL;
if (!url) {
  console.error("SUPABASE_DB_URL is not set. Put it in your .env.local (local only — never deployed).");
  process.exit(2);
}

const DIR = join(process.cwd(), "supabase", "migrations");
const files = readdirSync(DIR).filter((f) => f.endsWith(".sql")).sort();
if (files.length === 0) {
  console.error(`no .sql files under ${DIR}`);
  process.exit(2);
}

async function main(): Promise<void> {
const client = new pg.Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
await client.connect();

try {
  await client.query(
    `create table if not exists schema_migrations (
       name text primary key,
       applied_at timestamptz not null default now()
     )`
  );
  // Added after the fact, so existing ledgers get the column without a rewrite. Nullable on
  // purpose: rows applied before this existed have no recorded hash, and inventing one would be
  // a lie about what ran.
  await client.query("alter table schema_migrations add column if not exists checksum text");
  // Same deny-by-default posture as every other table. Without this, default privileges let the
  // PUBLISHABLE key write the ledger — and a forged row naming a future migration file would
  // silently skip that migration on apply day.
  await client.query("alter table schema_migrations enable row level security");
  const ledger = new Map<string, string | null>(
    (await client.query("select name, checksum from schema_migrations")).rows.map((r) => [
      r.name as string,
      (r.checksum as string | null) ?? null,
    ])
  );
  const body = new Map(files.map((f) => [f, readFileSync(join(DIR, f), "utf8")]));
  const pending = files.filter((f) => !ledger.has(f));

  // A ZERO-BYTE MIGRATION IS A FAILED FETCH WEARING A FILENAME. `git show` through a flaky
  // proxy wrote an empty file once (2026-08-12): the apply committed an empty transaction,
  // booked sha256("") in the ledger, and that false checksum then refused every later
  // migration as drift. Refuse the empty file before the ledger can be lied to, and call out
  // any historical row already booked against nothing — that migration NEVER RAN, whatever
  // the ledger says.
  const emptyFiles = files.filter((f) => !body.get(f)!.trim());
  if (emptyFiles.length) {
    console.error(`\nREFUSING: ${emptyFiles.length} migration file(s) are empty or whitespace:`);
    for (const f of emptyFiles) console.error(`  empty: ${f}`);
    console.error("\nRe-fetch the file (check its byte count) and re-run.");
    process.exit(3);
  }
  const EMPTY_SHA = sha256("");
  const falselyBooked = [...ledger.entries()].filter(([, sum]) => sum === EMPTY_SHA).map(([n]) => n);
  if (falselyBooked.length) {
    console.error(
      `\nWARNING: ${falselyBooked.length} ledger row(s) carry the checksum of an EMPTY file — those migrations never ran:`
    );
    for (const f of falselyBooked) console.error(`  falsely booked: ${f}`);
    console.error("Delete the row(s) and re-apply the real file; verify against pg_proc/pg_tables after.");
  }

  // AN EDITED MIGRATION IS NOT AN APPLIED MIGRATION. Without this the ledger keys on filename
  // alone: change the SQL of a file that already ran and the script reports "0 pending", exits
  // 0, and the live database keeps the old definition — the ledger lying about the schema,
  // which this script's own header calls its only real failure mode.
  const drifted = files.filter((f) => {
    const recorded = ledger.get(f);
    return recorded != null && recorded !== sha256(body.get(f)!);
  });
  if (drifted.length) {
    console.error(
      `\nREFUSING: ${drifted.length} already-applied migration file${drifted.length === 1 ? " has" : "s have"} changed since it was applied:`
    );
    for (const f of drifted) console.error(`  changed: ${f}`);
    console.error(
      "\nThe database still holds the ORIGINAL definition. Migrations move forward only —\n" +
        "revert the edit and add a new migration that makes the change."
    );
    process.exit(3);
  }

  // A back-dated filename would otherwise run AFTER everything newer, silently reverting a
  // later `create or replace` or dropping a view a newer file rebuilt.
  const highestApplied = [...ledger.keys()].sort().at(-1);
  const outOfOrder = highestApplied ? pending.filter((f) => f < highestApplied) : [];
  if (outOfOrder.length && !allowOutOfOrder) {
    console.error(`\nREFUSING: ${outOfOrder.length} pending migration(s) sort before the last applied one (${highestApplied}):`);
    for (const f of outOfOrder) console.error(`  out of order: ${f}`);
    console.error("\nRename them to a later timestamp, or re-run with --allow-out-of-order if you are certain.");
    process.exit(3);
  }

  console.log(`${files.length} migration file${files.length === 1 ? "" : "s"} · ${ledger.size} applied · ${pending.length} pending`);
  for (const f of pending) console.log(`  pending: ${f}`);

  if (!apply) {
    console.log("\nDRY RUN — nothing applied. Re-run with --apply.");
  } else {
    for (const f of pending) {
      const sql = body.get(f)!;
      await client.query("begin");
      try {
        await client.query(sql);
        await client.query("insert into schema_migrations (name, checksum) values ($1, $2)", [
          f,
          sha256(sql),
        ]);
        await client.query("commit");
        console.log(`applied: ${f}`);
      } catch (e) {
        await client.query("rollback");
        console.error(`FAILED (rolled back): ${f}`);
        throw e;
      }
    }
  }

  // Either way, report what the database actually looks like now — trust the ledger, verify the
  // schema.
  const tables = await client.query(
    "select tablename from pg_tables where schemaname = 'public' order by tablename"
  );
  console.log(`\npublic tables: ${tables.rows.map((r) => r.tablename).join(", ") || "(none)"}`);
} finally {
  await client.end();
}
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
