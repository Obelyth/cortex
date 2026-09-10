# Database setup: new installation or existing database

The database is optional for basic note browsing. Add it for working notes, the notes mirror, devices, and Ops receipts. Git remains the authority for durable notes; working notes and operations history need their own database backups.

Choose the correct path before running anything:

| Database state | Path |
| --- | --- |
| New, dedicated project with an empty application namespace | Pristine bootstrap below. |
| Existing Cortex installation, or any database containing application data | Existing-database checks and forward migrations. Never pristine bootstrap. |
| Unknown, shared, or partially initialized | Stop and inspect with the administrator. Do not drop tables or manufacture migration records to make a check pass. |

## New, empty database

1. Create a dedicated Supabase project using your own account. Keep the service-role key server-side. The installer expects the provider's existing `anon`, `authenticated`, and `service_role` roles; `service_role` must have `BYPASSRLS`. It does not create or broaden these roles. The project's `public` application namespace must be empty of non-extension tables, functions, and types, except for a compatible prerequisite helper. Do not use a project that already stores other application data.
2. Open [supabase/bootstrap.sql](../supabase/bootstrap.sql) from the release you are installing. Read and copy the **complete** file, from `begin;` through its final `commit;`, including the validation checks. Do not copy a truncated terminal or chat excerpt. This checked-in bundle is generated from that release's immutable migration files and is parity-tested against its generator.

   Maintainers can regenerate the same SQL from the source root using Node 22.x (tested with 22.23.2):

   ```bash
   node scripts/bootstrap.ts --print-pristine
   ```

   This optional command only prints SQL. It reads no connection string, opens no database connection, and applies nothing. New operators can use the checked-in file without running it.
3. In that project's SQL editor, confirm the project identity and administrator role, then run the complete generated transaction. This is an explicit one-time administrator action outside the Cortex dashboard. The bundle validates the empty namespace, installs the immutable migration chain with matching checksum records, checks row-level security and service-role grants, and verifies that user-data tables are empty before committing. It creates structural bookkeeping only, not notes, projects, working items, or historical receipts.
4. Confirm the transaction succeeded. The installation marker can be inspected without changing anything:

   ```sql
   select mode from public.cortex_installation where id = true;
   select count(*) as recorded_migrations from public.schema_migrations;
   ```

   The marker must be `pristine`; the migration count must match the generated bundle. A failed transaction is not a successful setup. Read the reported failure and correct the prerequisite; do not remove checks or rerun the installer over an existing schema. If the first run already succeeded, use the existing-database path from then on.
5. In the Vercel project's Production environment, set `SUPABASE_URL` to this project's URL and `SUPABASE_SERVICE_ROLE_KEY` to its matching service-role key. Deploy, then inspect Settings and Ops. Presence of both values does not prove that the schema or provider permissions are usable.

The service-role key bypasses row-level security. Never put it in browser code, a `NEXT_PUBLIC_` variable, the notes repository, or an issue. Cortex's database access is server-side; do not grant anonymous or general signed-in users access to its private tables to resolve an error. See Supabase's [API key guidance](https://supabase.com/docs/guides/api/api-keys) and [Data API security guidance](https://supabase.com/docs/guides/api/securing-your-api).

## Existing Cortex database

Back up the database and verify the exact target before any schema change. Use the migration check workflow first, inspect its immutable-file checksums and plan, and explicitly approve only pending forward migrations. Published migration files are not edited in place.

The optional dashboard workflow uses the `cortex-database` GitHub environment. Store `SUPABASE_DB_URL` there as an environment secret and, if the connection needs one, store its trusted PEM certificate as `CORTEX_DATABASE_CA`. Require environment review and restrict the approved source branch. Never disable TLS certificate verification. `CORTEX_MIGRATION_TARGET` identifies the intended database but does not authorize access to it.

The command-line runner is dry-run by default:

```bash
node scripts/migrate.ts
```

Only after reviewing its plan, target, backup, and release instructions should an administrator use `node scripts/migrate.ts --apply`. **That command is not a new-database installer.** Do not fabricate ledger rows, relabel old checksums, or use pristine bootstrap to bypass an existing-database failure.

If an existing installation specifically needs the RLS prerequisite helper, `node scripts/bootstrap.ts --print-prerequisite` prints that small administrator-reviewed transaction. It validates or installs only the compatible invoker helper; it does not initialize the schema, attach an event trigger, or authorize replaying the complete historical migration chain.

## Local verification is separate

The native tests use a disposable local PostgreSQL cluster, not a hosted project. `CORTEX_NATIVE_PG=1` opts in and `CORTEX_NATIVE_PG_SOCKET` points to an absolute Unix-socket directory for that test cluster. These variables are test-only, not production bootstrap requirements. Read `tests/bootstrap.pg.test.ts` before opting in. Never connect its destructive fixtures to an existing database.
