-- A backstop for the co-access signal that does not depend on the caller telling the truth.
--
-- 20260812030000 excluded maintenance rows, which was right, but it is DECLARED: brain_read takes
-- `maintenance` and the sweep has to pass it. Every mechanism in this system that depended on a
-- hand-maintained declaration has rotted the same way — the healthcheck's hardcoded tool count
-- (four multi-night outages), the settings.json allow-list (four hand-corrections in three weeks).
-- Each failed silently, because the symptom was absence. An undeclared sweep is that shape again:
-- it does not error, it just quietly teaches the graph its traversal order.
--
-- So this adds the guard the server CAN enforce without being told: a window that touched more
-- than `fanout_cap` distinct notes contributes no co-access evidence at all.
--
-- The justification is not merely pragmatic, it is what the evidence is worth. A window of n notes
-- yields n*(n-1)/2 pairs, and testifies exactly as strongly for every one of them. Twelve notes in
-- an hour produce 66 pairs and no reason to believe any particular two belong together; two notes
-- in an hour produce one pair and a real claim. Raw co-occurrence counting is therefore
-- quadratically biased toward the broadest windows — the ones carrying the least information per
-- pair. Measured on synthetic data matching the real shape (a 12-note sweep repeated five nights,
-- against one genuine pair co-read five times): 67 coaccess edges, 66 of them sweep noise. The
-- signal was 1.5% of the output.
--
-- The cap is deliberately not a "sweeps only" heuristic. A human session that opens twelve pages
-- while surveying is also not evidence that any two of them belong together, and it should be
-- discarded for the same reason. This asks how much the window can prove, not who opened it.
--
-- Six is chosen because the observed nightly sweep opens eight to twelve, and a focused reading
-- session runs two to five. It is one literal, declared once, so moving it is a one-line change if
-- the corpus outgrows it.
--
-- A NEW migration restating the whole body, same as 20260812010000/020000/030000 and for the same
-- reason: the runner keys its ledger on filename+checksum, so editing an applied file would leave
-- the database holding the old definition while the ledger reports it current. Everything except
-- the declare block, the coaccess CTE and the evidence wording is verbatim from
-- 20260812030000_maintenance_coaccess.sql.
create or replace function edges_rebuild(new_head text, edges jsonb default '[]'::jsonb)
returns boolean
language plpgsql
set search_path = public, pg_catalog
as $$
declare
  mirror_head text;
  -- Windows touching more than this many distinct notes prove nothing about any single pair.
  fanout_cap constant int := 6;
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
  -- `reads` is the eligible row set (the three declared exclusions); `focused` keeps only the
  -- windows narrow enough for a pair inside them to mean something; `eligible` is the rows that
  -- survive both. Written as CTEs rather than repeated subqueries so the exclusion list and the
  -- cap each appear exactly once — the previous form stated the mode filter twice, which is one
  -- edit away from the two halves disagreeing about what counts as a read.
  -- The filter stays on ONE line, in the exact shape tests/maintenance-read.test.ts parses. That
  -- test reads the winning migration and extracts every mode filter applied to note_access; split
  -- across lines it matches nothing, and a derivation with no filter at all would read as clean.
  with reads as (
    select distinct date_trunc('hour', at) as w, path from note_access where mode not in ('boot', 'handoff', 'maintenance')
  ), focused as (
    select w from reads group by w having count(*) <= fanout_cap
  ), eligible as (
    select r.w, r.path from reads r join focused f on f.w = r.w
  )
  insert into note_edges (src, dst, kind, weight, evidence, built_head)
    select w.a, w.b, 'coaccess', count(*)::real,
           'co-read in ' || count(*) || ' shared one-hour windows of note_access '
             || '(boot/handoff/maintenance rows and windows over ' || fanout_cap
             || ' notes excluded; last ' || to_char(max(w.w), 'YYYY-MM-DD HH24:MI') || ' UTC)',
           new_head
    from (
      select distinct a.path as a, b.path as b, a.w
      from eligible a
      join eligible b on a.w = b.w and a.path < b.path
    ) w
    where exists (select 1 from notes n where n.path = w.a)
      and exists (select 1 from notes n where n.path = w.b)
    group by w.a, w.b
    having count(*) >= 2;

  update edges_state set built_head = new_head, built_at = now() where id is true;
  return true;
end
$$;
