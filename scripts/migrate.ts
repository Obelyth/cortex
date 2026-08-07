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
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import pg from "pg";

const apply = process.argv.includes("--apply");
const url = process.env.SUPABASE_DB_URL;
if (!url) {
  console.error("SUPABASE_DB_URL is not set. It lives in the private checkout's .env.local.");
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
  // Same deny-by-default posture as every other table. Without this, default privileges let the
  // PUBLISHABLE key write the ledger — and a forged row naming a future migration file would
  // silently skip that migration on apply day.
  await client.query("alter table schema_migrations enable row level security");
  const done = new Set(
    (await client.query("select name from schema_migrations")).rows.map((r) => r.name)
  );
  const pending = files.filter((f) => !done.has(f));

  console.log(`${files.length} migration file${files.length === 1 ? "" : "s"} · ${done.size} applied · ${pending.length} pending`);
  for (const f of pending) console.log(`  pending: ${f}`);

  if (!apply) {
    console.log("\nDRY RUN — nothing applied. Re-run with --apply.");
  } else {
    for (const f of pending) {
      const sql = readFileSync(join(DIR, f), "utf8");
      await client.query("begin");
      try {
        await client.query(sql);
        await client.query("insert into schema_migrations (name) values ($1)", [f]);
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
