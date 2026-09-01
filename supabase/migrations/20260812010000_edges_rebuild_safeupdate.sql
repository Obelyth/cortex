-- The first live rebuild died in production on `delete from note_edges;` —
-- `ERROR: DELETE requires a WHERE clause` (postgres logs, 2026-08-11 23:10 UTC). Supabase runs
-- the safeupdate guard on served connections, which refuses unqualified DELETE/UPDATE. The
-- fixture tests mock this RPC, so only production could catch it; sync_apply never hit it
-- because its deletes are qualified by path. The fix is the qualification safeupdate wants:
-- `where true` states "yes, all of it" explicitly — a full replace is this function's whole
-- design, not an accident the guard should prevent.
--
-- Written as a NEW migration restating the whole body, because the runner keys its ledger on
-- filename+checksum: editing the applied 20260812000000 file would leave the database holding
-- the broken definition while the ledger reports it applied. `create or replace` preserves the
-- existing grants (execute already revoked from public/anon/authenticated; service_role keeps
-- its own), so only the function body rides in this file. Everything except the one delete line
-- is verbatim from 20260812000000_note_edges.sql.
create or replace function edges_rebuild(new_head text, edges jsonb default '[]'::jsonb)
returns boolean
language plpgsql
set search_path = public, pg_catalog
as $$
declare
  mirror_head text;
begin
  -- Serialize contending rebuilds on the singleton; each contender sees the truth the previous
  -- winner left. Insert-then-lock so the very first rebuild has a row to serialize on.
  insert into edges_state (id, built_head) values (true, '')
    on conflict (id) do nothing;
  perform 1 from edges_state where id is true for update;

  -- The graph must describe the corpus the mirror actually holds. Two rebuilds racing for
  -- different heads cannot be ordered by SHA, but the mirror can order them: a builder whose
  -- head is no longer the mirror's head is building a graph of a corpus nobody is serving, and
  -- is refused whole. The next reconcile triggers the rebuild that is current.
  select head_sha into mirror_head from sync_state where id is true;
  if mirror_head is distinct from new_head then
    return false;
  end if;

  -- Full replace by design; `where true` is for safeupdate, which refuses the bare form.
  delete from note_edges where true;

  -- The lexical/structural kinds, derived in the server from the corpus at new_head. The server
  -- is the right deriver for these: it already holds the parsed corpus in memory, and the
  -- tokenizer/frontmatter/retraction rules live in one place there (lib/narrow.ts,
  -- lib/frontmatter.ts, lib/verify.ts) — reimplementing any of them in SQL would be the
  -- dual-implementation drift this repo keeps paying to delete.
  insert into note_edges (src, dst, kind, weight, evidence, built_head)
    select x.src, x.dst, x.kind, x.weight, x.evidence, new_head
    from jsonb_to_recordset(coalesce(edges, '[]'::jsonb))
      as x(src text, dst text, kind text, weight real, evidence text);

  -- coaccess is the one kind derived HERE, because its raw material never leaves Postgres:
  -- note_access at ~row-per-read scale is exactly the table you aggregate where it lives rather
  -- than download to count. Two notes are co-accessed when both were served inside the same
  -- clock-hour window; the weight is how many distinct windows agree, and one shared window is
  -- below the floor — a single session touching two notes once is coincidence, a pair that
  -- recurs is structure.
  --
  -- Boot rows are excluded on purpose: mode='boot' records what the SERVER pushes on every
  -- connect (profile + recent logs), not what a session chose to read, so counting it would wire
  -- profile.md to everything by construction. Endpoints are joined against notes so an edge can
  -- never name a path the corpus no longer holds — access history outlives deletions.
  insert into note_edges (src, dst, kind, weight, evidence, built_head)
    select w.a, w.b, 'coaccess', count(*)::real,
           'co-read in ' || count(*) || ' shared one-hour windows of note_access '
             || '(whole log, boot rows excluded; last ' || to_char(max(w.w), 'YYYY-MM-DD HH24:MI') || ' UTC)',
           new_head
    from (
      select distinct a.path as a, b.path as b, a.w
      from (select distinct date_trunc('hour', at) as w, path from note_access where mode <> 'boot') a
      join (select distinct date_trunc('hour', at) as w, path from note_access where mode <> 'boot') b
        on a.w = b.w and a.path < b.path
    ) w
    where exists (select 1 from notes n where n.path = w.a)
      and exists (select 1 from notes n where n.path = w.b)
    group by w.a, w.b
    having count(*) >= 2;

  update edges_state set built_head = new_head, built_at = now() where id is true;
  return true;
end
$$;
