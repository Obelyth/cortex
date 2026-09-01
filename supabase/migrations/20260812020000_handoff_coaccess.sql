-- brain_handoff serves notes the SERVER chose — the same class of row as mode='boot', and the
-- coaccess derivation must treat it the same way. Without this, every handoff bundle lands its
-- project page and its graph-nominated neighbours in one clock-hour window, which is precisely
-- the co-access signal the graph then reads back: the bundle would strengthen the edges that
-- built the bundle, ratcheting its own picks permanent. Boot rows were excluded on day one for
-- exactly this shape ("counting it would wire profile.md to everything by construction");
-- handoff rows arrive with the tool and are excluded before the first one is ever written, so
-- no window of self-taught edges exists to clean up.
--
-- A NEW migration restating the whole body, same as 20260812010000 and for the same reason: the
-- runner keys its ledger on filename+checksum, so editing an applied file would leave the
-- database holding the old definition while the ledger reports it current. `create or replace`
-- preserves the existing grants (execute already revoked from public/anon/authenticated).
-- Everything except the two mode filters and the evidence wording is verbatim from
-- 20260812010000_edges_rebuild_safeupdate.sql.
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
  -- Boot AND handoff rows are excluded on purpose: both record what the SERVER pushes (the boot
  -- call's profile+logs; a handoff's page+neighbours), not what a session chose to read.
  -- Counting boot would wire profile.md to everything by construction; counting handoff would
  -- let the bundle vote for its own edges. Endpoints are joined against notes so an edge can
  -- never name a path the corpus no longer holds — access history outlives deletions.
  insert into note_edges (src, dst, kind, weight, evidence, built_head)
    select w.a, w.b, 'coaccess', count(*)::real,
           'co-read in ' || count(*) || ' shared one-hour windows of note_access '
             || '(whole log, boot/handoff rows excluded; last ' || to_char(max(w.w), 'YYYY-MM-DD HH24:MI') || ' UTC)',
           new_head
    from (
      select distinct a.path as a, b.path as b, a.w
      from (select distinct date_trunc('hour', at) as w, path from note_access where mode not in ('boot', 'handoff')) a
      join (select distinct date_trunc('hour', at) as w, path from note_access where mode not in ('boot', 'handoff')) b
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
