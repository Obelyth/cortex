-- The connections graph — layer 2 of the learning layer (spec 2026-08-11, "structure learning").
--
-- EVERYTHING HERE IS DERIVED. An edge is rebuilt from git + the access log and stored beside the
-- temperatures; deleting the whole table loses nothing but warm-up time (law 1 of the learning
-- layer). Nothing writes back into a note, and no model is ever consulted — every kind below is
-- lexical, structural, or statistical.
--
-- THE EVIDENCE COLUMN IS LOAD-BEARING. The product's one claim is that answers are provable, and
-- a graph that says "these notes are related, trust me" would be the first unprovable surface in
-- the system. So every edge names what justifies it — the referencing line, the shared tags, the
-- matched terms, the co-read windows — and the check constraint makes an evidence-free edge
-- unrepresentable rather than merely discouraged.

-- One row per (src, dst, kind). Directed kinds (link, correction, lexical) store the direction
-- they were derived in; symmetric kinds (tag, coaccess) store one row with src < dst, and the
-- reader looks both ways. `built_head` rides on every row so a single row can testify which
-- corpus commit it describes, even when read without the state row beside it.
create table if not exists note_edges (
  src        text not null,
  dst        text not null,
  -- link: an explicit [[..]] reference resolved to a live note ·
  -- tag: shared frontmatter tags · coaccess: co-read within the same one-hour window ·
  -- lexical: a top-k BM25 neighbour · correction: a retraction marker naming another note
  kind       text not null check (kind in ('link', 'tag', 'coaccess', 'lexical', 'correction')),
  weight     real not null,
  -- 1..200: never empty (an edge with no evidence is an assertion, and this system does not
  -- assert), never unbounded (evidence is note-derived text and lands on the console — one
  -- enormous phrase must not decide what the corpus screen costs to load).
  evidence   text not null check (char_length(evidence) between 1 and 200),
  built_head text not null,
  built_at   timestamptz not null default now(),
  primary key (src, dst, kind)
);

-- The two lookups the console makes for a selected note: edges out of it (ranked by weight, so
-- "top edges" is an index walk) and edges into it (the reverse half of symmetric kinds and the
-- incoming half of directed ones).
create index if not exists note_edges_src_weight on note_edges (src, weight desc);
create index if not exists note_edges_dst on note_edges (dst);

-- What head the graph was built from — the sync_state pattern, for the same reason: a singleton,
-- because two rows claiming different build heads would make "is the graph current" unanswerable.
-- It exists apart from the rows so "built, and the corpus had no edges" is distinguishable from
-- "never built": zero rows plus a state row is an honest empty graph, zero rows alone is absence.
create table if not exists edges_state (
  id         boolean primary key default true,
  built_head text not null,
  built_at   timestamptz not null default now(),
  constraint edges_state_singleton check (id)
);

-- Deny-by-default, same as every table here: RLS on, no policies. The server talks to these
-- with the service key, which bypasses RLS; nothing else has any business in a derived table.
alter table note_edges enable row level security;
alter table edges_state enable row level security;

-- The one write path, and it is atomic — the sync_apply lesson applied before it is re-learned:
-- PostgREST calls are independent transactions, so a client-side delete-then-insert could be
-- interleaved by a second builder into a graph neither intended, or crash between the two and
-- leave half a graph under a current-looking state row. One function, one transaction, one
-- winner; a full replace, because the graph is cheap to derive and "rebuilt from scratch" is the
-- only rebuild that cannot accumulate drift.
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

  delete from note_edges;

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

-- PostgREST exposes public functions to every role by default grant. This one rewrites the
-- graph; only the service key has any business calling it.
revoke execute on function edges_rebuild(text, jsonb) from public;
revoke execute on function edges_rebuild(text, jsonb) from anon;
revoke execute on function edges_rebuild(text, jsonb) from authenticated;
