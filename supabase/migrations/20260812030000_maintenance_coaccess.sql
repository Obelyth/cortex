-- The third face of the self-teaching ratchet, and the only one the server cannot spot for
-- itself: an automated sweep is not a read.
--
-- The nightly groundskeeper opens eight to twelve pages through brain_read inside a single clock
-- hour, every night, over overlapping page sets. Every one of those rows lands as mode='read'
-- and is therefore co-access evidence — so the sweep manufactures precisely the signal the inbox
-- then hands back to the operator to review ("co-read pair with no link"), one watch item per
-- pair the sweep happened to visit together. Eight of them in one night's inbox, at least six
-- traceable to recent sweeps. The graph was not learning what belongs together; it was learning
-- the groundskeeper's traversal order, and then asking to have it written down.
--
-- This is the same shape boot and handoff were excluded for: rows recording what something other
-- than a session's own curiosity chose to open. The difference is that those two are identifiable
-- by tool, and this one is not — currentSurface() reports `terminal` for the nightly sweep and
-- `terminal` for the operator's own Claude Code session, and no signal on the wire separates
-- them. So the CALLER declares it: brain_read takes an optional `maintenance` flag, and lib/access
-- records mode='maintenance' instead of 'read'. Everything else about that call is unchanged,
-- which is the point — the sweep must keep reading the same bytes through the same egress gate.
--
-- The rows are still WRITTEN. They stay in note_access, still count toward temperature and the
-- decay/heat aggregates (a page the groundskeeper had to open is a page that got touched), and
-- stay auditable. They are excluded from exactly one inference: the one that treats "served in
-- the same hour" as evidence of a relationship. A machine on a timer is not a reader.
--
-- A NEW migration restating the whole body, same as 20260812010000 and 20260812020000 and for the
-- same reason: the runner keys its ledger on filename+checksum, so editing an applied file would
-- leave the database holding the old definition while the ledger reports it current. `create or
-- replace` preserves the existing grants (execute already revoked from public/anon/authenticated).
-- Everything except the two mode filters and the evidence wording is verbatim from
-- 20260812020000_handoff_coaccess.sql.
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
  -- Boot, handoff AND maintenance rows are excluded on purpose. The first two record what the
  -- SERVER pushes (the boot call's profile+logs; a handoff's page+neighbours); the third records
  -- what an automated sweep opened on a schedule. None of the three is a session choosing to read
  -- two notes together. Counting boot would wire profile.md to everything by construction;
  -- counting handoff would let the bundle vote for its own edges; counting maintenance would let
  -- the nightly groundskeeper's traversal order become the graph, which it briefly did. Endpoints
  -- are joined against notes so an edge can never name a path the corpus no longer holds —
  -- access history outlives deletions.
  insert into note_edges (src, dst, kind, weight, evidence, built_head)
    select w.a, w.b, 'coaccess', count(*)::real,
           'co-read in ' || count(*) || ' shared one-hour windows of note_access '
             || '(whole log, boot/handoff/maintenance rows excluded; last ' || to_char(max(w.w), 'YYYY-MM-DD HH24:MI') || ' UTC)',
           new_head
    from (
      select distinct a.path as a, b.path as b, a.w
      from (select distinct date_trunc('hour', at) as w, path from note_access where mode not in ('boot', 'handoff', 'maintenance')) a
      join (select distinct date_trunc('hour', at) as w, path from note_access where mode not in ('boot', 'handoff', 'maintenance')) b
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
