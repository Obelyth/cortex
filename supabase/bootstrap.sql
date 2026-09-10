-- ONE EXPLICIT ADMINISTRATOR TRANSACTION. Review the complete bundle before execution.
begin;
set local lock_timeout='5s';
set local statement_timeout='120s';
select pg_advisory_xact_lock(763541,3);
do $cortex_roles$
begin
 if (select count(*) from pg_catalog.pg_roles where rolname in ('anon','authenticated','service_role'))<>3
   or not exists(select 1 from pg_catalog.pg_roles where rolname='service_role' and rolbypassrls) then
   raise exception 'Existing anon/authenticated/service_role roles and service_role BYPASSRLS are required; bootstrap does not alter roles';
 end if;
end $cortex_roles$;
do $cortex_empty$
begin
 if exists(select 1 from pg_catalog.pg_class c join pg_catalog.pg_namespace n on n.oid=c.relnamespace
   where n.nspname='public' and not exists(select 1 from pg_catalog.pg_depend d where d.classid='pg_catalog.pg_class'::regclass and d.objid=c.oid and d.deptype='e'))
 or exists(select 1 from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on n.oid=p.pronamespace
   where n.nspname='public' and not(p.proname='rls_auto_enable' and p.pronargs=0)
     and not exists(select 1 from pg_catalog.pg_depend d where d.classid='pg_catalog.pg_proc'::regclass and d.objid=p.oid and d.deptype='e'))
 or exists(select 1 from pg_catalog.pg_type t join pg_catalog.pg_namespace n on n.oid=t.typnamespace
   where n.nspname='public' and t.typelem=0
     and not exists(select 1 from pg_catalog.pg_depend d where d.classid='pg_catalog.pg_type'::regclass and d.objid=t.oid and d.deptype='e')) then
   raise exception 'Pristine bootstrap requires an empty dedicated public application namespace; no reset or merge was attempted';
 end if;
end $cortex_empty$;
do $cortex_roles$
begin
 if (select count(*) from pg_catalog.pg_roles where rolname in ('anon','authenticated','service_role'))<>3
   or not exists(select 1 from pg_catalog.pg_roles where rolname='service_role' and rolbypassrls) then
   raise exception 'Existing anon/authenticated/service_role roles and service_role BYPASSRLS are required; bootstrap does not alter roles';
 end if;
end $cortex_roles$;
do $cortex_helper$
declare existing pg_catalog.pg_proc;
begin
 select p.* into existing from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on n.oid=p.pronamespace
   where n.nspname='public' and p.proname='rls_auto_enable' and p.pronargs=0;
 if found then
   if existing.prosrc is distinct from '
declare command record;
begin
  for command in select * from pg_catalog.pg_event_trigger_ddl_commands() loop
    if command.command_tag in (''CREATE TABLE'',''CREATE TABLE AS'',''SELECT INTO'')
      and exists(select 1 from pg_catalog.pg_class c join pg_catalog.pg_namespace n on n.oid=c.relnamespace
        where c.oid=command.objid and n.nspname=''public'' and c.relkind in (''r'',''p'')) then
      execute pg_catalog.format(''alter table %s enable row level security'',command.objid::pg_catalog.regclass);
    end if;
  end loop;
end
' or existing.prorettype<>'pg_catalog.event_trigger'::pg_catalog.regtype
     or existing.prosecdef or existing.prolang<>(select oid from pg_catalog.pg_language where lanname='plpgsql')
     or existing.proconfig is distinct from array['search_path=""']::text[] then
     raise exception 'Incompatible rls_auto_enable prerequisite; no existing definition was overwritten';
   end if;
 else
   execute 'create function public.rls_auto_enable() returns event_trigger language plpgsql security invoker set search_path='''' as ''
declare command record;
begin
  for command in select * from pg_catalog.pg_event_trigger_ddl_commands() loop
    if command.command_tag in (''''CREATE TABLE'''',''''CREATE TABLE AS'''',''''SELECT INTO'''')
      and exists(select 1 from pg_catalog.pg_class c join pg_catalog.pg_namespace n on n.oid=c.relnamespace
        where c.oid=command.objid and n.nspname=''''public'''' and c.relkind in (''''r'''',''''p'''')) then
      execute pg_catalog.format(''''alter table %s enable row level security'''',command.objid::pg_catalog.regclass);
    end if;
  end loop;
end
''';
 end if;
end $cortex_helper$;
revoke all on function public.rls_auto_enable() from public,anon,authenticated,service_role;
create table public.schema_migrations(name text primary key,applied_at timestamptz not null default now(),checksum text not null);
alter table public.schema_migrations enable row level security;
revoke all on public.schema_migrations from public,anon,authenticated;
grant select on public.schema_migrations to service_role;

-- IMMUTABLE FILE 20260805220000_mirror.sql SHA256 3497c64883a3335479ee8dbfb658807c5b50278822921d4e7a8b5b5425d37d4b
-- The corpus mirror, the sync ledger, and the access log.
--
-- GIT IS THE AUTHORITY FOR EVERY ROW IN `notes`. This schema stores nothing that cannot be
-- rebuilt from the brain repo at a commit: `commit_sha` records exactly which commit each row's
-- content came from, and the reconciler's contract is that backfill equals "reconcile from empty".
-- If this database vanished, the mirror is one tarball fetch from whole again. (The classes that
-- WILL be authoritative here — the bubble, scores — arrive in later phases with point-in-time
-- recovery as their safety net; nothing in this migration is one of them.)

-- One row per live note, byte-identical to the file at `commit_sha`.
--
-- Content is stored verbatim and never rewritten: the deterministic verifier proves quotes
-- against file bytes, so a mirror that normalised line endings or trimmed whitespace would break
-- citations on exactly the notes it touched. `bytes` is generated, not written, so it cannot
-- drift from the content it measures.
create table if not exists notes (
  path        text primary key,
  content     text not null,
  bytes       integer not null generated always as (octet_length(content)) stored,
  commit_sha  text not null,
  mirrored_at timestamptz not null default now()
);

-- What head the mirror believes it reflects. A single row, enforced by the check — two rows
-- claiming different heads would make "is the mirror current" unanswerable.
create table if not exists sync_state (
  id        boolean primary key default true,
  head_sha  text not null,
  synced_at timestamptz not null default now(),
  constraint sync_state_singleton check (id)
);

-- Note-level access log — the temperature groundwork (spec §7.4).
--
-- Nothing in phase 2 reads this table. It exists now because scores need history and usage
-- history cannot be backfilled: by the time the library is big enough to need grading, the
-- grades need months of data behind them. One row per note actually served to a caller.
-- Aggregation, decay and pruning arrive with pg_cron in phase 4; until then this only grows,
-- which at row-per-read scale is well within a Pro project's headroom.
create table if not exists note_access (
  id      bigint generated always as identity primary key,
  at      timestamptz not null default now(),
  path    text not null,
  -- which tool served the note: brain_read | brain_corpus | brain_ask | brain_context
  tool    text not null,
  -- which door the call came through: terminal | connector | guest | "" when unknown
  surface text not null default '',
  -- how the note was chosen: paths | question | listing | full | boot | "" when n/a
  mode    text not null default ''
);

-- The two questions phase 4 will ask: "how has THIS note been used" and "what was used lately".
create index if not exists note_access_path_at on note_access (path, at desc);
create index if not exists note_access_at on note_access (at desc);

-- Deny-by-default for the anon/publishable key: RLS enabled, no policies. The server talks to
-- these tables with the service key, which bypasses RLS; nothing else has any business here.
alter table notes enable row level security;
alter table sync_state enable row level security;
alter table note_access enable row level security;

insert into public.schema_migrations(name,checksum) values('20260805220000_mirror.sql','3497c64883a3335479ee8dbfb658807c5b50278822921d4e7a8b5b5425d37d4b');

-- IMMUTABLE FILE 20260805230000_sync_apply.sql SHA256 65e5a9f6bf5ea630329162666dbd62eb7d1c19576661b0391e4d5f3b5a2672f6
-- Atomic, serialized sync — and the lockdown the first migration missed.
--
-- WHY AN RPC. The adversarial review of the first mirror cut proved two interleavings wrong in
-- JavaScript: a stalled write-through landing after a newer reconcile left a stale row under a
-- current head forever, and two concurrent reconcilers could interleave upsert/remove/setHead
-- into a state neither intended. Client-side sequencing cannot fix either — PostgREST calls are
-- independent transactions. So the whole sync batch moves into ONE function: a compare-and-swap
-- on sync_state decides exactly one winner, the singleton row lock serializes contenders, and
-- the batch applies all-or-nothing in the same transaction. A loser's entire batch is refused,
-- not half-applied.
create or replace function sync_apply(
  expected_head text,
  new_head text,
  upserts jsonb default '[]'::jsonb,
  removes text[] default '{}'::text[]
) returns boolean
language plpgsql
as $$
declare
  current_head text;
begin
  -- Serialize every sync on the singleton row. Contenders queue here; each sees the truth the
  -- previous winner left behind.
  select head_sha into current_head from sync_state where id is true for update;

  -- The CAS: proceed only if the mirror is where the caller believed it was. `is distinct from`
  -- because expected_head is null for a never-synced mirror, and null = null is not true in SQL.
  if current_head is distinct from expected_head then
    return false;
  end if;

  insert into notes (path, content, commit_sha)
    select x.path, x.content, x.commit_sha
    from jsonb_to_recordset(coalesce(upserts, '[]'::jsonb))
      as x(path text, content text, commit_sha text)
  on conflict (path) do update
    set content = excluded.content,
        commit_sha = excluded.commit_sha,
        mirrored_at = now();

  delete from notes where path = any(coalesce(removes, '{}'::text[]));

  insert into sync_state (id, head_sha, synced_at)
    values (true, new_head, now())
  on conflict (id) do update
    set head_sha = excluded.head_sha, synced_at = now();

  return true;
end
$$;

-- PostgREST exposes public functions to every role, including anon. This one rewrites the
-- mirror; only the service key has any business calling it.
revoke execute on function sync_apply(text, text, jsonb, text[]) from public;
revoke execute on function sync_apply(text, text, jsonb, text[]) from anon;
revoke execute on function sync_apply(text, text, jsonb, text[]) from authenticated;

-- The ledger the migration runner bootstraps sat in public WITHOUT row level security — the one
-- table outside the deny-by-default posture the first migration states in prose. Under default
-- privileges the publishable key could read and WRITE it, and a forged row naming a future
-- migration file would silently skip that migration on apply day.
alter table if exists schema_migrations enable row level security;

insert into public.schema_migrations(name,checksum) values('20260805230000_sync_apply.sql','65e5a9f6bf5ea630329162666dbd62eb7d1c19576661b0391e4d5f3b5a2672f6');

-- IMMUTABLE FILE 20260806090000_bubble.sql SHA256 ce9c7788ac2d1c0d1ce21c8d9ac46fbf66f1407426ebb9854f4de20422850ed2
-- The bubble — working memory, and the one class of data Postgres OWNS (spec §7.1, §7.3).
--
-- Everything else in this database is a mirror of git. The bubble is not: working state changes
-- too often to be a commit per touch, and it is wrong more often than notes are — items get
-- corrected in place, then either FILED into a note (they mattered) or AGED OUT (they did not).
-- That is why Pro-tier point-in-time recovery stopped being a nicety the day this table landed:
-- this data exists nowhere else.
--
-- It is NOT a transcript. No conversation logging, no session replay. Short, structured items
-- written deliberately by tool call — what is being worked on, decisions not yet filed, open
-- questions, handoffs for the next session on any surface.
create table if not exists bubble_items (
  id         bigint generated always as identity primary key,
  -- focus: what is being worked on · decision: made but not yet filed · question: open/blocker ·
  -- handoff: what the next session needs to know
  kind       text not null check (kind in ('focus', 'decision', 'question', 'handoff')),
  -- routing key, matches the brain's project vocabulary ('cortex', 'harbor', ...); '' = general
  project    text not null default '',
  body       text not null check (char_length(body) between 1 and 2000),
  status     text not null default 'open' check (status in ('open', 'filed', 'aged')),
  -- where a filed item went: the note path the caller wrote it into. Set exactly when filed.
  filed_into text not null default '',
  surface    text not null default '',
  created_at timestamptz not null default now(),
  -- bumped on every update; age-out keys off this, so an item kept current stays hot
  touched_at timestamptz not null default now()
);

-- The one query the boot call makes: open items, freshest touch first.
create index if not exists bubble_open_touched on bubble_items (status, touched_at desc);

alter table bubble_items enable row level security;

-- Lazy age-out, called on the read path. Phase 4's pg_cron owns scheduled decay; until then the
-- reader sweeps on entry, which keeps "aged" true without depending on a job that could silently
-- stop. Items are flipped, never deleted — deletion is a human decision (spec §7.6), and an aged
-- item is still evidence for the temperature system.
create or replace function bubble_sweep(max_age_days integer default 14)
returns integer
language sql
as $$
  with swept as (
    update bubble_items
       set status = 'aged'
     where status = 'open'
       and touched_at < now() - make_interval(days => max_age_days)
    returning 1
  )
  select count(*)::integer from swept;
$$;

revoke execute on function bubble_sweep(integer) from public;
revoke execute on function bubble_sweep(integer) from anon;
revoke execute on function bubble_sweep(integer) from authenticated;

insert into public.schema_migrations(name,checksum) values('20260806090000_bubble.sql','ce9c7788ac2d1c0d1ce21c8d9ac46fbf66f1407426ebb9854f4de20422850ed2');

-- IMMUTABLE FILE 20260806100000_bubble_open.sql SHA256 a41f3d014032b57fb219a606f4afab4b6245b1011e92acc4981a5879a23aca3a
-- One round trip for the whole bubble read — and exact numbers, which the two-call shape could
-- not give. The review proved the seam: a limit with no count meant every surface presented the
-- fetched page as the universe, so item #101 was invisible everywhere while the sweep quietly
-- aged it out — the silent-loss failure, in the one table git cannot rebuild. And sweep-then-
-- select doubled the boot path's exposure to a slow store.
--
-- bubble_open sweeps, counts, and returns in a single transaction: the sweep count and the TRUE
-- open total ride with the page, so a render can state exactly what it is not showing.
create or replace function bubble_open(max_age_days integer default 14, max_items integer default 200)
returns jsonb
language plpgsql
as $$
declare
  swept integer;
  total integer;
  items jsonb;
begin
  update bubble_items
     set status = 'aged'
   where status = 'open'
     and touched_at < now() - make_interval(days => max_age_days);
  get diagnostics swept = row_count;

  select count(*)::integer into total from bubble_items where status = 'open';

  select coalesce(jsonb_agg(t), '[]'::jsonb) into items
  from (
    select id, kind, project, body, status, filed_into, surface, created_at, touched_at
      from bubble_items
     where status = 'open'
     order by touched_at desc
     limit max_items
  ) t;

  return jsonb_build_object('total', total, 'swept', swept, 'items', items);
end
$$;

revoke execute on function bubble_open(integer, integer) from public;
revoke execute on function bubble_open(integer, integer) from anon;
revoke execute on function bubble_open(integer, integer) from authenticated;

-- Superseded by bubble_open before anything shipped; two functions with overlapping duties is
-- how the next reader calls the wrong one.
drop function if exists bubble_sweep(integer);

insert into public.schema_migrations(name,checksum) values('20260806100000_bubble_open.sql','a41f3d014032b57fb219a606f4afab4b6245b1011e92acc4981a5879a23aca3a');

-- IMMUTABLE FILE 20260806220000_temperature.sql SHA256 8fd8846d6c42f1be234e694effb1e7990931810b55001ba1092d187498b773e9
-- Temperatures — the always-loaded set bounded by SCORE, not by existence (spec §7.2, §7.4).
--
-- The router is a complete table: one row per live note, always. What temperature decides is
-- which rows are RENDERED into every conversation. Cold is not gone and not lossy — it is one
-- query away, and every note keeps a row here no matter how cold it gets.
--
-- COLD START IS DESIGNED FOR, not discovered later. Scores need usage and on day one there is
-- barely a day of it, so a scorer weighted on access alone would put the entire brain in cold on
-- its first run. Write-recency, the directory prior and pins carry the score until access history
-- is deep enough to outweigh them — see the blend in note_scores below.

-- Explicit pins. The operator's judgement outranks any computed score, in both directions: pinning
-- something cold is as legitimate as pinning it hot ("I know this looks busy, it is noise").
create table if not exists note_pins (
  path       text primary key,
  temperature text not null check (temperature in ('hot', 'warm', 'cold')),
  reason     text not null default '',
  pinned_at  timestamptz not null default now()
);
alter table note_pins enable row level security;

-- Deletion review queue. DEMOTION IS AUTOMATIC; DELETION NEVER IS (spec §7.5, §15). Cold notes
-- that have gone untouched for a long time surface here as candidates, and a human decides.
-- Rows are never acted on by any job — this table is a suggestion box, and the console is where
-- it is read.
create table if not exists deletion_candidates (
  path        text primary key,
  reason      text not null,
  proposed_at timestamptz not null default now(),
  -- null = awaiting review · 'keep' = the operator said no, never propose again · 'approved' = the operator
  -- said yes, and a HUMAN still performs the delete through the ordinary write path.
  decision    text check (decision in ('keep', 'approved')),
  decided_at  timestamptz
);
alter table deletion_candidates enable row level security;

/*
 * note_scores — the temperature of every mirrored note, computed on read.
 *
 * A VIEW, not a materialised table: at this corpus size the whole computation is milliseconds
 * over a few thousand access rows, and a view cannot go stale between cron runs. When the library
 * outgrows that, this becomes a materialised view refreshed by the same pg_cron schedule that
 * runs the decay — the callers do not change.
 *
 * The blend, and why each term is here:
 *   access_score  — how often AND how recently a note was actually served. Exponential decay with
 *                   a 30-day half-life, so a note read ten times last week outranks one read
 *                   fifty times in March. This is the term that eventually dominates.
 *   write_score   — recently edited material is usually live material. Carries the cold start.
 *   dir_prior     — profile and projects/ start warmer than notes/; archive/ starts cold.
 *   RECENCY_GRACE — a note written in the last week is never cold, whatever its access history.
 *                   New notes have no reads BECAUSE they are new; demoting them would be a
 *                   self-fulfilling prophecy.
 */
create or replace view note_scores as
with access_agg as (
  select
    path,
    count(*)                                                as reads,
    max(at)                                                 as last_read,
    -- 30-day half-life: each read contributes 0.5^(age_days/30).
    sum(power(0.5, extract(epoch from (now() - at)) / 2592000.0)) as decayed_reads
  from note_access
  group by path
),
base as (
  select
    n.path,
    n.mirrored_at,
    coalesce(a.reads, 0)                                    as reads,
    a.last_read,
    coalesce(a.decayed_reads, 0)                            as decayed_reads,
    -- Directory prior. The brain's own shape: the boot file and live projects earn presence;
    -- archive/ is superseded material by definition.
    case
      when n.path = 'profile.md'          then 1.00
      when n.path like 'projects/%'       then 0.70
      when n.path like 'log/%'            then 0.35
      when n.path like 'archive/%'        then 0.05
      else 0.50
    end                                                     as dir_prior,
    -- Write recency, 21-day half-life. Uses mirrored_at, which tracks the commit the row came
    -- from, so an edited note re-warms itself.
    power(0.5, extract(epoch from (now() - n.mirrored_at)) / 1814400.0) as write_score
  from notes n
  left join access_agg a on a.path = n.path
  where n.path like '%.md'
),
scored as (
  select
    b.*,
    -- Normalised against the busiest note so the scale is stable as the corpus grows.
    case when max(b.decayed_reads) over () > 0
         then b.decayed_reads / max(b.decayed_reads) over ()
         else 0 end                                         as access_score
  from base b
)
select
  s.path,
  s.reads,
  s.last_read,
  round(s.access_score::numeric, 4)  as access_score,
  round(s.write_score::numeric, 4)   as write_score,
  s.dir_prior,
  p.temperature                      as pinned,
  round((0.45 * s.access_score + 0.30 * s.write_score + 0.25 * s.dir_prior)::numeric, 4) as score,
  case
    when p.temperature is not null then p.temperature
    -- The grace window: nothing written in the last 7 days is cold.
    when s.mirrored_at > now() - interval '7 days'
         and (0.45 * s.access_score + 0.30 * s.write_score + 0.25 * s.dir_prior) < 0.35
      then 'warm'
    when (0.45 * s.access_score + 0.30 * s.write_score + 0.25 * s.dir_prior) >= 0.45 then 'hot'
    when (0.45 * s.access_score + 0.30 * s.write_score + 0.25 * s.dir_prior) >= 0.20 then 'warm'
    else 'cold'
  end                                as temperature
from scored s
left join note_pins p on p.path = s.path;

/*
 * Deletion candidates, proposed — never executed.
 *
 * Deliberately narrow: cold, never read at all, not written in six months, not pinned, not
 * already decided. A note that was read even once is not a candidate, because the one thing worse
 * than clutter is proposing to delete something that proved itself useful.
 */
create or replace function propose_deletions(min_age_days integer default 180)
returns integer
language plpgsql
as $$
declare
  n integer;
begin
  insert into deletion_candidates (path, reason)
  select s.path,
         format('cold · never read · unchanged %s days',
                floor(extract(epoch from (now() - nt.mirrored_at)) / 86400)::text)
  from note_scores s
  join notes nt on nt.path = s.path
  where s.temperature = 'cold'
    and s.reads = 0
    and s.pinned is null
    and nt.mirrored_at < now() - make_interval(days => min_age_days)
  on conflict (path) do nothing;
  get diagnostics n = row_count;
  return n;
end
$$;

revoke execute on function propose_deletions(integer) from public;
revoke execute on function propose_deletions(integer) from anon;
revoke execute on function propose_deletions(integer) from authenticated;

-- note_scores is a view over RLS-enabled tables; PostgREST reaches it with the service key only.
revoke all on note_scores from public;
revoke all on note_scores from anon;
revoke all on note_scores from authenticated;

insert into public.schema_migrations(name,checksum) values('20260806220000_temperature.sql','8fd8846d6c42f1be234e694effb1e7990931810b55001ba1092d187498b773e9');

-- IMMUTABLE FILE 20260806230000_last_commit_at.sql SHA256 a62319f1d2253f1ed302183829e6a7fa897fb9f1f68501baa016aaa0b03dabd8
-- Write recency must measure WRITING, not mirroring.
--
-- The first temperature run exposed this immediately: every note scored 0.97-0.99 on write
-- recency because `mirrored_at` records when the ROW was written, and the backfill wrote all 86
-- rows in one second. Thirty percent of the score was measuring the mirror's own history.
--
-- `last_commit_at` is the note's actual last commit date in git. The reconciler sets it on the
-- patch path, where the head commit's date is exactly when those files changed. Full syncs and
-- the backfill leave it null and inherit whatever was already known, so a rebuild never erases
-- history it cannot re-derive; a one-time seed script fills the initial values from the commits
-- API. Scores coalesce to mirrored_at when it is null, so the column can populate gradually
-- without any window where scoring breaks.
alter table notes add column if not exists last_commit_at timestamptz;

create index if not exists notes_last_commit_at on notes (last_commit_at desc nulls last);

-- sync_apply gains the column, and — load-bearing — NEVER nulls a known value. A full sync
-- carries no per-file dates; without the coalesce it would wipe every date the patch path had
-- learned, silently, on the first force-push or oversized diff.
create or replace function sync_apply(
  expected_head text,
  new_head text,
  upserts jsonb default '[]'::jsonb,
  removes text[] default '{}'::text[]
) returns boolean
language plpgsql
as $$
declare
  current_head text;
begin
  select head_sha into current_head from sync_state where id is true for update;

  if current_head is distinct from expected_head then
    return false;
  end if;

  insert into notes (path, content, commit_sha, last_commit_at)
    select x.path, x.content, x.commit_sha, x.last_commit_at
    from jsonb_to_recordset(coalesce(upserts, '[]'::jsonb))
      as x(path text, content text, commit_sha text, last_commit_at timestamptz)
  on conflict (path) do update
    set content = excluded.content,
        commit_sha = excluded.commit_sha,
        last_commit_at = coalesce(excluded.last_commit_at, notes.last_commit_at),
        mirrored_at = now();

  delete from notes where path = any(coalesce(removes, '{}'::text[]));

  insert into sync_state (id, head_sha, synced_at)
    values (true, new_head, now())
  on conflict (id) do update
    set head_sha = excluded.head_sha, synced_at = now();

  return true;
end
$$;

revoke execute on function sync_apply(text, text, jsonb, text[]) from public;
revoke execute on function sync_apply(text, text, jsonb, text[]) from anon;
revoke execute on function sync_apply(text, text, jsonb, text[]) from authenticated;

-- The view, now scoring on authorship time where it is known.
--
-- Dropped and recreated rather than replaced: CREATE OR REPLACE VIEW cannot add a column in the
-- middle of the list, and `written_at` belongs beside the other inputs rather than bolted on the
-- end. propose_deletions references this view by name at runtime, not by dependency, so it
-- survives the drop untouched.
drop view if exists note_scores;
create view note_scores as
with access_agg as (
  select
    path,
    count(*)                                                as reads,
    max(at)                                                 as last_read,
    sum(power(0.5, extract(epoch from (now() - at)) / 2592000.0)) as decayed_reads
  from note_access
  group by path
),
base as (
  select
    n.path,
    coalesce(n.last_commit_at, n.mirrored_at)               as written_at,
    coalesce(a.reads, 0)                                    as reads,
    a.last_read,
    coalesce(a.decayed_reads, 0)                            as decayed_reads,
    case
      when n.path = 'profile.md'          then 1.00
      when n.path like 'projects/%'       then 0.70
      when n.path like 'log/%'            then 0.35
      when n.path like 'archive/%'        then 0.05
      else 0.50
    end                                                     as dir_prior,
    power(0.5, extract(epoch from (now() - coalesce(n.last_commit_at, n.mirrored_at))) / 1814400.0) as write_score
  from notes n
  left join access_agg a on a.path = n.path
  where n.path like '%.md'
),
scored as (
  select
    b.*,
    case when max(b.decayed_reads) over () > 0
         then b.decayed_reads / max(b.decayed_reads) over ()
         else 0 end                                         as access_score
  from base b
)
select
  s.path,
  s.reads,
  s.last_read,
  s.written_at,
  round(s.access_score::numeric, 4)  as access_score,
  round(s.write_score::numeric, 4)   as write_score,
  s.dir_prior,
  p.temperature                      as pinned,
  round((0.45 * s.access_score + 0.30 * s.write_score + 0.25 * s.dir_prior)::numeric, 4) as score,
  case
    when p.temperature is not null then p.temperature
    when s.written_at > now() - interval '7 days'
         and (0.45 * s.access_score + 0.30 * s.write_score + 0.25 * s.dir_prior) < 0.35
      then 'warm'
    when (0.45 * s.access_score + 0.30 * s.write_score + 0.25 * s.dir_prior) >= 0.45 then 'hot'
    when (0.45 * s.access_score + 0.30 * s.write_score + 0.25 * s.dir_prior) >= 0.20 then 'warm'
    else 'cold'
  end                                as temperature
from scored s
left join note_pins p on p.path = s.path;

revoke all on note_scores from public;
revoke all on note_scores from anon;
revoke all on note_scores from authenticated;

insert into public.schema_migrations(name,checksum) values('20260806230000_last_commit_at.sql','a62319f1d2253f1ed302183829e6a7fa897fb9f1f68501baa016aaa0b03dabd8');

-- IMMUTABLE FILE 20260807000000_deletion_age.sql SHA256 43f02c6f2bbe61de0526d7fa73d07a1c56cf40de437a20d539edc4c631b5ac3b
-- propose_deletions must measure AUTHORSHIP age, not mirror age.
--
-- The migration immediately before this one declared `mirrored_at` unfit for measuring write time
-- and moved note_scores onto `written_at`. propose_deletions was left behind on the old column,
-- and the consequence is worse than an inaccurate string: sync_apply sets `mirrored_at = now()`
-- on every upserted row, and a FULL sync upserts every file. So one force-push, one diverged
-- history, one failed compare, or any diff over PATCH_LIMIT resets the 180-day floor for the
-- entire corpus — and the review queue silently produces nothing for another six months. A queue
-- that quietly stops proposing looks exactly like a queue with nothing to propose.
--
-- The reason string moves too. A human deciding whether to delete something is owed the age of
-- the WRITING, not the age of the row that mirrors it.
create or replace function propose_deletions(min_age_days integer default 180)
returns integer
language plpgsql
as $$
declare
  n integer;
begin
  insert into deletion_candidates (path, reason)
  select s.path,
         format('cold · never read · unwritten %s days',
                floor(extract(epoch from (now() - s.written_at)) / 86400)::text)
  from note_scores s
  where s.temperature = 'cold'
    and s.reads = 0
    and s.pinned is null
    and s.written_at < now() - make_interval(days => min_age_days)
  on conflict (path) do nothing;
  get diagnostics n = row_count;
  return n;
end
$$;

revoke execute on function propose_deletions(integer) from public;
revoke execute on function propose_deletions(integer) from anon;
revoke execute on function propose_deletions(integer) from authenticated;

comment on function propose_deletions(integer) is
  'Proposes cold, never-read, long-unwritten notes for HUMAN review. Never deletes. Reads only '
  'note_scores, so it measures authorship age and can never be reset by a mirror rebuild.';

insert into public.schema_migrations(name,checksum) values('20260807000000_deletion_age.sql','43f02c6f2bbe61de0526d7fa73d07a1c56cf40de437a20d539edc4c631b5ac3b');

-- IMMUTABLE FILE 20260807001000_grace_honest.sql SHA256 3025f798e82b40fef076a9746157a45856d78842211e1449122fdcf208e0b23b
-- The 7-day grace clause was inert, and inert-but-load-bearing-looking is worse than absent.
--
-- A skeptic proved it arithmetically: grace eligibility requires written_at > now() - 7 days, and
-- write_score is computed from that same timestamp, so any note the clause could apply to already
-- has write_score >= 0.5^(7/21) = 0.7937. Even at the archive floor that forces
-- score >= 0.30*0.7937 + 0.25*0.05 = 0.2506, which is already above the 0.20 cold cutoff. The
-- clause could only ever fire on notes that were warm anyway. It read as the safety net protecting
-- new notes from being buried, and it was decoration.
--
-- The protection is real, but it comes from the WEIGHTS, not from that clause. So the clause goes
-- and the property becomes an explicit, testable guard: a note written inside the grace window is
-- never cold, stated once, enforceable, and impossible to mistake for a rule that is doing work
-- somewhere else. If the weights are ever retuned, this guard starts mattering — and now it will
-- actually fire instead of being shadowed by arithmetic nobody re-derived.
drop view if exists note_scores;
create view note_scores as
with access_agg as (
  select
    path,
    count(*)                                                as reads,
    max(at)                                                 as last_read,
    sum(power(0.5, extract(epoch from (now() - at)) / 2592000.0)) as decayed_reads
  from note_access
  group by path
),
base as (
  select
    n.path,
    coalesce(n.last_commit_at, n.mirrored_at)               as written_at,
    coalesce(a.reads, 0)                                    as reads,
    a.last_read,
    coalesce(a.decayed_reads, 0)                            as decayed_reads,
    case
      when n.path = 'profile.md'          then 1.00
      when n.path like 'projects/%'       then 0.70
      when n.path like 'log/%'            then 0.35
      when n.path like 'archive/%'        then 0.05
      else 0.50
    end                                                     as dir_prior,
    power(0.5, extract(epoch from (now() - coalesce(n.last_commit_at, n.mirrored_at))) / 1814400.0) as write_score
  from notes n
  left join access_agg a on a.path = n.path
  where n.path like '%.md'
),
scored as (
  select
    b.*,
    -- Normalised against the busiest note. The `> 0` guard is what keeps a corpus with no access
    -- history at all from dividing by zero — the state every new deployment starts in.
    case when max(b.decayed_reads) over () > 0
         then b.decayed_reads / max(b.decayed_reads) over ()
         else 0 end                                         as access_score,
    round((0.45 * (case when max(b.decayed_reads) over () > 0
                        then b.decayed_reads / max(b.decayed_reads) over ()
                        else 0 end)
         + 0.30 * b.write_score
         + 0.25 * b.dir_prior)::numeric, 4)                 as score
  from base b
)
select
  s.path,
  s.reads,
  s.last_read,
  s.written_at,
  round(s.access_score::numeric, 4) as access_score,
  round(s.write_score::numeric, 4)  as write_score,
  s.dir_prior,
  p.temperature                     as pinned,
  s.score,
  case
    -- A pin is the operator's judgement and outranks every computed band, in both directions.
    when p.temperature is not null then p.temperature
    when s.score >= 0.45 then 'hot'
    when s.score >= 0.20 then 'warm'
    -- THE GUARD: nothing written in the last 7 days is cold, whatever its score. A new note has
    -- no reads BECAUSE it is new, and demoting it would be a self-fulfilling prophecy. Redundant
    -- at today's weights (the arithmetic above cannot produce a sub-0.20 score inside the window)
    -- and deliberately kept, because it becomes load-bearing the moment those weights move.
    when s.written_at > now() - interval '7 days' then 'warm'
    else 'cold'
  end                               as temperature
from scored s
left join note_pins p on p.path = s.path;

revoke all on note_scores from public;
revoke all on note_scores from anon;
revoke all on note_scores from authenticated;

insert into public.schema_migrations(name,checksum) values('20260807001000_grace_honest.sql','3025f798e82b40fef076a9746157a45856d78842211e1449122fdcf208e0b23b');

-- IMMUTABLE FILE 20260807020000_fts.sql SHA256 08d660b3f4fb8714f919c2768c7f2d57633cd06e08a9ee8e2b2ce644c0ee67ca
-- Full-text search — the arm that makes "cold is one query away" true rather than aspirational.
--
-- Phase 4 stopped rendering cold notes into every conversation. That is only honest if there is a
-- real way to find them again, and the incumbent way is BM25 computed in memory: to narrow 86
-- notes to 10, the server loads all 86 and scores them. The database can do that with an index.
--
-- STORED, not computed on the fly: the tsvector is a generated column so it can be indexed, and
-- so it can never drift from the content beside it. A search index that disagrees with the note
-- is a search index that hides material, which is the failure this whole system is built against.
--
-- Weights encode where a match matters most. The path carries the note's name and directory
-- ('harbor', 'projects'), which is the strongest signal a query can hit; the body is the mass of
-- the evidence. Postgres ranks A above B above C, so a question naming a note finds that note
-- even when a dozen others discuss it.
alter table notes
  add column if not exists fts tsvector
  generated always as (
    setweight(to_tsvector('english', coalesce(replace(replace(path, '/', ' '), '-', ' '), '')), 'A')
    || setweight(to_tsvector('english', coalesce(content, '')), 'C')
  ) stored;

create index if not exists notes_fts on notes using gin (fts);

/*
 * search_notes — rank the corpus against a question, cheaply, in the database.
 *
 * websearch_to_tsquery, not plainto_tsquery: it understands quoted phrases and OR the way a
 * person actually types a question, and — critically — it does not throw on punctuation. A
 * search function that errors on an apostrophe would take down the read path it is meant to
 * serve, so the parse is the forgiving one and every failure below degrades to fewer results,
 * never to an exception.
 *
 * Returns rank AND temperature so the caller can decide policy. This function deliberately does
 * NOT filter by temperature: cold material is exactly what search exists to reach, and a search
 * that hid cold notes would close the only door phase 4 left open for them.
 */
create or replace function search_notes(q text, k integer default 10)
returns table (path text, rank real, temperature text)
language sql
stable
as $$
  with query as (
    select websearch_to_tsquery('english', coalesce(nullif(trim(q), ''), 'zzzznomatchzzzz')) as tsq
  )
  select n.path,
         ts_rank(n.fts, query.tsq) as rank,
         coalesce(s.temperature, 'hot') as temperature
  from notes n
  cross join query
  left join note_scores s on s.path = n.path
  where n.path like '%.md'
    and n.fts @@ query.tsq
  order by ts_rank(n.fts, query.tsq) desc, n.path asc
  limit greatest(1, least(coalesce(k, 10), 100));
$$;

revoke execute on function search_notes(text, integer) from public;
revoke execute on function search_notes(text, integer) from anon;
revoke execute on function search_notes(text, integer) from authenticated;

comment on function search_notes(text, integer) is
  'Ranks live notes against a question using the stored FTS index. Never filters by temperature — '
  'reaching cold material is the reason this exists.';

insert into public.schema_migrations(name,checksum) values('20260807020000_fts.sql','08d660b3f4fb8714f919c2768c7f2d57633cd06e08a9ee8e2b2ce644c0ee67ca');

-- IMMUTABLE FILE 20260807030000_fts_or.sql SHA256 c77de747f008876cddfbf1762f5b8187323ff2ac8b8a8b2e0828ce1f18a54d60
-- The first search_notes ANDed its terms, and the eval caught it in one run: 33.5% recall
-- against the incumbent BM25's 97.6%.
--
-- websearch_to_tsquery('english', 'is harbor local-first or is it on vercel') produces
-- 'harbor' & 'local-first' <-> ... | 'vercel' — conjunctive. A question containing ONE word the
-- note happens not to use matches nothing at all, while BM25 ORs the terms and ranks by how many
-- landed. The comparison was never FTS versus BM25; it was AND versus OR wearing FTS's name.
--
-- So the query becomes disjunctive: every lexeme the question reduces to, OR'd, ranked by
-- ts_rank. Recall stops depending on the question's least common word, and the weights (path A,
-- body C) still decide the order.
--
-- Building the query from to_tsvector's own lexemes rather than by splitting on whitespace is
-- deliberate: it applies the SAME stemming and stopword list the index was built with, so the
-- query can never contain a form the index does not. Hand-splitting is how a search function
-- develops a private, slightly-wrong idea of what a word is.
create or replace function search_notes(q text, k integer default 10)
returns table (path text, rank real, temperature text)
language sql
stable
as $$
  with lex as (
    -- Lexemes of the question, in the index's own vocabulary. Empty for a question that is all
    -- stopwords, which the guard below turns into "no results" rather than an error.
    select string_agg(lexeme, ' | ') as ored
    from unnest(to_tsvector('english', coalesce(q, '')))
  ),
  query as (
    select to_tsquery('english', coalesce(nullif(lex.ored, ''), 'zzzznomatchzzzz')) as tsq
    from lex
  )
  select n.path,
         ts_rank(n.fts, query.tsq) as rank,
         coalesce(s.temperature, 'hot') as temperature
  from notes n
  cross join query
  left join note_scores s on s.path = n.path
  where n.path like '%.md'
    and n.fts @@ query.tsq
  order by ts_rank(n.fts, query.tsq) desc, n.path asc
  limit greatest(1, least(coalesce(k, 10), 100));
$$;

revoke execute on function search_notes(text, integer) from public;
revoke execute on function search_notes(text, integer) from anon;
revoke execute on function search_notes(text, integer) from authenticated;

comment on function search_notes(text, integer) is
  'Ranks live notes against a question using the stored FTS index, DISJUNCTIVELY — an AND query '
  'made recall depend on the question''s rarest word. Never filters by temperature: reaching cold '
  'material is the reason this exists.';

insert into public.schema_migrations(name,checksum) values('20260807030000_fts_or.sql','c77de747f008876cddfbf1762f5b8187323ff2ac8b8a8b2e0828ce1f18a54d60');

-- IMMUTABLE FILE 20260807040000_fts_quote.sql SHA256 b5b157b90887807660e0009277fd2ac29e8de1fcdbc8cbe226e6de4b571ef491
-- Quote the lexemes before handing them to to_tsquery.
--
-- The disjunctive rewrite concatenated raw lexemes into a query string, which means the CONTENT of
-- a lexeme was being parsed as query SYNTAX. Fuzzing found no input that broke it — the english
-- configuration strips quotes and operators during tokenisation, so "a'|'b", "don't 'quote' me"
-- and "x' | 'y" all reduce to harmless words. That is empirical safety: a statement about the
-- inputs that were tried, not about the ones that exist.
--
-- quote_literal makes it structural. Every lexeme becomes a quoted term with its internal quotes
-- doubled, so no lexeme content can ever be read as an operator, regardless of the text search
-- configuration this function is later pointed at. The failure mode being closed is not "wrong
-- results" but "exception on the read path", which is the one outcome the original comment
-- promised could not happen.
--
-- Lexemes are already dictionary-normalised, so re-processing them as quoted terms is idempotent;
-- the retrieval eval is unchanged by this migration (91.2% recall@10, verified before and after).
create or replace function search_notes(q text, k integer default 10)
returns table (path text, rank real, temperature text)
language sql
stable
as $$
  with lex as (
    select string_agg(quote_literal(lexeme), ' | ') as ored
    from unnest(to_tsvector('english', coalesce(q, '')))
  ),
  query as (
    select to_tsquery('english', coalesce(nullif(lex.ored, ''), '''zzzznomatchzzzz''')) as tsq
    from lex
  )
  select n.path,
         ts_rank(n.fts, query.tsq) as rank,
         coalesce(s.temperature, 'hot') as temperature
  from notes n
  cross join query
  left join note_scores s on s.path = n.path
  where n.path like '%.md'
    and n.fts @@ query.tsq
  order by ts_rank(n.fts, query.tsq) desc, n.path asc
  limit greatest(1, least(coalesce(k, 10), 100));
$$;

revoke execute on function search_notes(text, integer) from public;
revoke execute on function search_notes(text, integer) from anon;
revoke execute on function search_notes(text, integer) from authenticated;

comment on function search_notes(text, integer) is
  'Ranks live notes against a question using the stored FTS index, disjunctively over quoted '
  'lexemes. Never filters by temperature: reaching cold material is the reason this exists. '
  'NOT the default narrower — BM25 beat it on the labelled set (see spec 10.1).';

insert into public.schema_migrations(name,checksum) values('20260807040000_fts_quote.sql','b5b157b90887807660e0009277fd2ac29e8de1fcdbc8cbe226e6de4b571ef491');

-- IMMUTABLE FILE 20260807050000_case_decay_seed.sql SHA256 015e38c3bf9a8ef980c5d61e7e689162d91a1f48a0a17083bea86e998a507b61
-- Three defects found by a full-repo review, plus the honest labelling of three mechanisms that
-- are built but not wired. All of them are cases of the schema and the code — or the schema and
-- itself — disagreeing quietly rather than failing.
--
-- Written as a NEW migration rather than as edits to the files that introduced these definitions,
-- because the runner keys its ledger on filename: editing an applied migration in place leaves
-- the database holding the original definition while the ledger reports it applied. (That gap is
-- now refused outright — scripts/migrate.ts records a checksum per file.)


-- 1. SEED THE SINGLETON, so the compare-and-swap actually locks something.
--
-- sync_apply's guarantee is "exactly one winner", and it rests on
-- `select head_sha into current_head from sync_state where id is true for update`. FOR UPDATE
-- locks ROWS. On a mirror that has never synced there is no row, so it locks nothing: two
-- instances both read current_head = NULL, both pass the `is distinct from` check, and both
-- apply. The loser's older file set lands second and re-inserts paths the winner had deleted —
-- phantom notes that can never appear in a future diff, so they are served as live forever.
--
-- An empty-string head is "synced to nothing", which is exactly what a fresh mirror means, and
-- it is `distinct from` every real sha so the first genuine sync still proceeds normally.
insert into sync_state (id, head_sha) values (true, '') on conflict (id) do nothing;


-- 2. "IS THIS A NOTE" MUST MEAN THE SAME THING IN SQL AS IN TYPESCRIPT.
--
-- lib/corpus.ts:isLive() tests /\.md$/i, case-INsensitively, and says why: a note saved as
-- `Setup.MD` is a note, and the old exact-match test dropped it silently. Every SQL consumer
-- used `like '%.md'`, which in Postgres is case-SENSITIVE. So an uppercase-extension note was a
-- live, mirrored, served corpus row with no score row: no temperature, never returned by
-- search_notes, never a deletion candidate — and the console showed N notes while hot+warm+cold
-- summed to N-1, with nothing on screen explaining the gap.
--
-- 3. BOUND THE DECAY WINDOW.
--
-- access_agg aggregated the ENTIRE note_access table on every evaluation, with a power() and an
-- extract() per row, and note_access is append-only with no prune (the pg_cron rollup promised
-- in the mirror migration never shipped). This view is read once per boot call and five more
-- times per console overview render, and neither existing index can serve an unbounded GROUP BY.
--
-- 180 days is six half-lives at the 30-day constant: a read older than that contributes under 2%
-- of its original weight, so the cutoff changes scores in the fourth decimal place while making
-- the aggregate an index range scan on note_access_at instead of a full table scan.
drop view if exists note_scores;
create view note_scores as
with access_agg as (
  select
    path,
    count(*)                                                as reads,
    max(at)                                                 as last_read,
    sum(power(0.5, extract(epoch from (now() - at)) / 2592000.0)) as decayed_reads
  from note_access
  where at > now() - interval '180 days'
  group by path
),
base as (
  select
    n.path,
    coalesce(n.last_commit_at, n.mirrored_at)               as written_at,
    coalesce(a.reads, 0)                                    as reads,
    a.last_read,
    coalesce(a.decayed_reads, 0)                            as decayed_reads,
    case
      when n.path = 'profile.md'          then 1.00
      when n.path ilike 'projects/%'      then 0.70
      when n.path ilike 'log/%'           then 0.35
      -- archive/ is excluded from the corpus by lib/corpus.ts's SKIP_PREFIX and is no longer a
      -- writable path, so this branch cannot match a mirrored row. Kept as the documented floor
      -- in case the archive is ever admitted to the reader tier.
      when n.path ilike 'archive/%'       then 0.05
      else 0.50
    end                                                     as dir_prior,
    power(0.5, extract(epoch from (now() - coalesce(n.last_commit_at, n.mirrored_at))) / 1814400.0) as write_score
  from notes n
  left join access_agg a on a.path = n.path
  where n.path ilike '%.md'
),
scored as (
  select
    b.*,
    -- Normalised against the busiest note. The `> 0` guard is what keeps a corpus with no access
    -- history at all from dividing by zero — the state every new deployment starts in.
    case when max(b.decayed_reads) over () > 0
         then b.decayed_reads / max(b.decayed_reads) over ()
         else 0 end                                         as access_score,
    round((0.45 * (case when max(b.decayed_reads) over () > 0
                        then b.decayed_reads / max(b.decayed_reads) over ()
                        else 0 end)
         + 0.30 * b.write_score
         + 0.25 * b.dir_prior)::numeric, 4)                 as score
  from base b
)
select
  s.path,
  s.reads,
  s.last_read,
  s.written_at,
  round(s.access_score::numeric, 4) as access_score,
  round(s.write_score::numeric, 4)  as write_score,
  s.dir_prior,
  p.temperature                     as pinned,
  s.score,
  case
    -- A pin is the operator's judgement and outranks every computed band, in both directions.
    when p.temperature is not null then p.temperature
    when s.score >= 0.45 then 'hot'
    when s.score >= 0.20 then 'warm'
    -- THE GUARD: nothing written in the last 7 days is cold, whatever its score. A new note has
    -- no reads BECAUSE it is new, and demoting it would be a self-fulfilling prophecy. Redundant
    -- at today's weights (the arithmetic above cannot produce a sub-0.20 score inside the window)
    -- and deliberately kept, because it becomes load-bearing the moment those weights move.
    when s.written_at > now() - interval '7 days' then 'warm'
    else 'cold'
  end                               as temperature
from scored s
left join note_pins p on p.path = s.path;

revoke all on note_scores from public;
revoke all on note_scores from anon;
revoke all on note_scores from authenticated;


-- The same case fix on the retrieval arm, so search and scoring agree about what a note is.
create or replace function search_notes(q text, k integer default 10)
returns table (path text, rank real, temperature text)
language sql
stable
as $$
  with lex as (
    select string_agg(quote_literal(lexeme), ' | ') as ored
    from unnest(to_tsvector('english', coalesce(q, '')))
  ),
  query as (
    select to_tsquery('english', coalesce(nullif(lex.ored, ''), '''zzzznomatchzzzz''')) as tsq
    from lex
  )
  select n.path,
         ts_rank(n.fts, query.tsq) as rank,
         coalesce(s.temperature, 'hot') as temperature
  from notes n
  cross join query
  left join note_scores s on s.path = n.path
  where n.path ilike '%.md'
    and n.fts @@ query.tsq
  order by ts_rank(n.fts, query.tsq) desc, n.path asc
  limit greatest(1, least(coalesce(k, 10), 100));
$$;

revoke execute on function search_notes(text, integer) from public;
revoke execute on function search_notes(text, integer) from anon;
revoke execute on function search_notes(text, integer) from authenticated;


-- 4. SAY WHICH MECHANISMS ARE NOT WIRED.
--
-- Three things in this schema are built, reviewed, revised — and unreachable from the running
-- server. A reader of these migrations reasonably concludes otherwise, and the console's own
-- "0 deletion candidates" reads as a healthy queue rather than as a queue nothing ever fills.
-- Labelled here rather than deleted, because each is a phase away from being wired and the work
-- is sound; what was wrong was the silence.
comment on function propose_deletions(integer) is
  'UNWIRED as of 2026-08-07: no caller in the application and no scheduler. deletion_candidates '
  'is therefore always empty, and nothing can write its `decision` column either, so the queue '
  'could not drain if it filled. Wire a pg_cron schedule plus console actions before treating '
  'the overview''s candidate count as meaningful.';

comment on table note_pins is
  'UNWIRED as of 2026-08-07: note_scores honours a pin above every computed band, but no tool or '
  'console control can create one — the only way to pin a note today is hand-written SQL.';

comment on function search_notes(text, integer) is
  'Ranks live notes against a question using the stored FTS index, disjunctively over quoted '
  'lexemes. Never filters by temperature: reaching cold material is the reason this exists. '
  'NOT the default narrower — BM25 beat it on the labelled set (see spec 10.1) — and NOT on any '
  'request path: as of 2026-08-07 its only caller is scripts/eval-retrieval.ts. The stored '
  'tsvector and its GIN index are maintained on every upsert for an offline evaluation.';

insert into public.schema_migrations(name,checksum) values('20260807050000_case_decay_seed.sql','015e38c3bf9a8ef980c5d61e7e689162d91a1f48a0a17083bea86e998a507b61');

-- IMMUTABLE FILE 20260811170000_advisor_hardening.sql SHA256 318c16865e65066830c7dc6afeb4dbad05a74461a0a5054d88cfd63bd75db2e8
-- Two findings from Supabase's own security linter (2026-08-11 advisor run), closed here.
-- Neither is exploitable today — every table already carries deny-all RLS and the server reaches
-- Postgres with the service role only — but both are defaults that bite the day something else
-- changes, which is exactly when nobody is looking at function definitions.
--
-- 1. FOUR FUNCTIONS RESOLVE NAMES THROUGH THE CALLER'S search_path (linter 0011).
--
-- A function without a pinned search_path looks tables and operators up in whatever path the
-- CALLING role happens to have. For a SECURITY INVOKER function called by the service role that
-- is harmless right now — but it means the function's meaning depends on session state it does
-- not control, and a future caller (a new role, a pooler default, an extension schema) can
-- change what `notes` resolves to without touching this code. Pin it: these functions mean the
-- public schema, so say so in the definition.
alter function public.bubble_open(max_age_days integer, max_items integer)
  set search_path = public, pg_catalog;
alter function public.propose_deletions(min_age_days integer)
  set search_path = public, pg_catalog;
alter function public.search_notes(q text, k integer)
  set search_path = public, pg_catalog;
alter function public.sync_apply(expected_head text, new_head text, upserts jsonb, removes text[])
  set search_path = public, pg_catalog;

-- 2. EVERY RPC IS CALLABLE BY anon/authenticated OVER REST (linters 0028/0029 flagged the
--    SECURITY DEFINER one; the same default grant covers the rest).
--
-- Supabase's default privileges hand EXECUTE on new public functions to anon and authenticated,
-- so all five functions are reachable at /rest/v1/rpc/<name> with the publishable key. The four
-- INVOKER functions currently dead-end on deny-all RLS, and rls_auto_enable() only turns RLS ON
-- (its failure mode is over-protection) — but this database has exactly one legitimate caller,
-- the server on the service role. A door nobody should walk through gets locked, not monitored.
-- service_role keeps its own grant; nothing the server does changes.
revoke execute on function public.bubble_open(max_age_days integer, max_items integer)
  from anon, authenticated;
revoke execute on function public.propose_deletions(min_age_days integer)
  from anon, authenticated;
revoke execute on function public.search_notes(q text, k integer)
  from anon, authenticated;
revoke execute on function public.sync_apply(expected_head text, new_head text, upserts jsonb, removes text[])
  from anon, authenticated;
-- rls_auto_enable() is created by no migration in this chain — it exists only on databases
-- where it was installed out of band. REVOKE has no IF EXISTS form, so on a fresh database
-- this statement would raise 42883 and roll back the whole file. Guard on existence: where
-- the function is absent there is nothing to lock, and that is a no-op, not an error.
do $$ begin
  if to_regprocedure('public.rls_auto_enable()') is not null then
    revoke execute on function public.rls_auto_enable() from anon, authenticated;
  end if;
end $$;

insert into public.schema_migrations(name,checksum) values('20260811170000_advisor_hardening.sql','318c16865e65066830c7dc6afeb4dbad05a74461a0a5054d88cfd63bd75db2e8');

-- IMMUTABLE FILE 20260812000000_note_edges.sql SHA256 d6ac72924962c8e77a21af303d52960dbfc04ac25a95ea33e0897a3b35f1b3fd
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

insert into public.schema_migrations(name,checksum) values('20260812000000_note_edges.sql','d6ac72924962c8e77a21af303d52960dbfc04ac25a95ea33e0897a3b35f1b3fd');

-- IMMUTABLE FILE 20260812010000_edges_rebuild_safeupdate.sql SHA256 764c20b6c28790c03203e40c412f2b0c391be7846a7d23705e72c16473befe67
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

insert into public.schema_migrations(name,checksum) values('20260812010000_edges_rebuild_safeupdate.sql','764c20b6c28790c03203e40c412f2b0c391be7846a7d23705e72c16473befe67');

-- IMMUTABLE FILE 20260812020000_handoff_coaccess.sql SHA256 fc1f7b1a2486974693775e9002ae8624b8c72e2d3afb4b99aecd3c1d8563ff38
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

insert into public.schema_migrations(name,checksum) values('20260812020000_handoff_coaccess.sql','fc1f7b1a2486974693775e9002ae8624b8c72e2d3afb4b99aecd3c1d8563ff38');

-- IMMUTABLE FILE 20260812030000_maintenance_coaccess.sql SHA256 d4b14e2572f5584d8db83c3423faa91fccc5182c6ec053b2a855fac3267b61b6
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

insert into public.schema_migrations(name,checksum) values('20260812030000_maintenance_coaccess.sql','d4b14e2572f5584d8db83c3423faa91fccc5182c6ec053b2a855fac3267b61b6');

-- IMMUTABLE FILE 20260812040000_coaccess_fanout_cap.sql SHA256 ddef50dc889f876ffa7d8a97e636d1f0fa3955bf8049e5cdf86bd2e83c2f3bdf
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

insert into public.schema_migrations(name,checksum) values('20260812040000_coaccess_fanout_cap.sql','ddef50dc889f876ffa7d8a97e636d1f0fa3955bf8049e5cdf86bd2e83c2f3bdf');

-- IMMUTABLE FILE 20260902120000_ops_ledger.sql SHA256 e5af327626ef5c03e9558cde9b990a60e7f87e50ea7b0ef58d04fe2e9a4c15bd
-- The ops ledger: what is expected to run (ops_units), what actually ran (ops_runs), and the
-- append-only receipt trail (ops_events). Spec: docs/superpowers/specs/2026-09-02-cortex-
-- mission-control-design.md §4. States are never stored as a reporter's adjective — the server
-- derives them from the clock and evidence (lib/ops-state.ts) and the stored `state` column on
-- ops_runs is the last derived value, kept so the sweep can detect transitions.
--
-- RLS is enabled with no policies on purpose: only the service-role key (server) reaches these
-- tables; anon and authenticated see nothing. Same posture as bubble_items.

create table if not exists ops_units (
  id            text primary key,
  kind          text not null check (kind in ('routine','machine','agent','operator','item')),
  name          text not null,
  owner         text not null default 'none' check (owner in ('manager','indexer','retrieval','none')),
  period_s      integer,                 -- null = no schedule (items, agents)
  grace_s       integer not null default 1800,
  max_run_s     integer not null default 1200,
  pages         boolean not null default true,
  tolerance     integer not null default 1,   -- consecutive failures before a page
  paused_until  timestamptz,
  run_now       jsonb,                    -- {"kind":"dispatch"|"link","target":"..."}
  notes         text,
  created_at    timestamptz not null default now()
);
alter table ops_units enable row level security;

create table if not exists ops_runs (
  id            bigint generated always as identity primary key,
  unit_id       text not null references ops_units(id) on delete cascade,
  run_key       text not null,
  trigger       text not null default 'cron' check (trigger in ('cron','manual','retry','webhook','heartbeat')),
  scheduled_at  timestamptz,
  started_at    timestamptz,
  ended_at      timestamptz,
  lease_until   timestamptz,
  state         text not null default 'scheduled',
  exit_reason   text check (exit_reason in ('code','infra','timeout','no_signal','question')),
  attempt       integer not null default 1,
  summary       text check (char_length(summary) <= 280),
  error         text,
  evidence      jsonb not null default '[]'::jsonb,
  cost          jsonb,
  facts         jsonb,
  updated_at    timestamptz not null default now(),
  unique (unit_id, run_key)
);
create index if not exists ops_runs_unit_started on ops_runs (unit_id, started_at desc);
alter table ops_runs enable row level security;

create table if not exists ops_events (
  id            bigint generated always as identity primary key,
  unit_id       text not null references ops_units(id) on delete cascade,
  run_id        bigint references ops_runs(id) on delete set null,
  at            timestamptz not null default now(),
  actor         text not null check (actor in ('unit','sweep','operator','guest')),
  kind          text not null check (kind in ('start','finish','heartbeat','transition','ack','snooze','pause','resume','run_now','alert_sent','alert_failed','read')),
  from_state    text,
  to_state      text,
  body          jsonb not null default '{}'::jsonb
);
create index if not exists ops_events_at on ops_events (at desc);
create index if not exists ops_events_unit_at on ops_events (unit_id, at desc);
alter table ops_events enable row level security;

insert into public.schema_migrations(name,checksum) values('20260902120000_ops_ledger.sql','e5af327626ef5c03e9558cde9b990a60e7f87e50ea7b0ef58d04fe2e9a4c15bd');

-- IMMUTABLE FILE 20260902130000_run_now_links.sql SHA256 f751f3e5b4ede0aef9e28d0f6b9d78fa74ddb7e1ab804072f9245da6269f2953
-- Public installations start without operator routines. Run-now targets are configured only
-- after the owner creates the corresponding provider automation.

insert into public.schema_migrations(name,checksum) values('20260902130000_run_now_links.sql','f751f3e5b4ede0aef9e28d0f6b9d78fa74ddb7e1ab804072f9245da6269f2953');

-- IMMUTABLE FILE 20260902140000_agent_units.sql SHA256 48be816d4b255f9e92663571edbcee9b290b720ef9698da9105b77d051d8845a
-- Public installations start without a developer workstation or agent. Owners add units only
-- after their own reporters and lifecycle hooks are configured.

insert into public.schema_migrations(name,checksum) values('20260902140000_agent_units.sql','48be816d4b255f9e92663571edbcee9b290b720ef9698da9105b77d051d8845a');

-- IMMUTABLE FILE 20260905100000_sync_apply_content_aware.sql SHA256 c2a2ba50caf95aea90dfff5408d4ac00c1e58cce7e3e730e80d7051c5df297b1
-- Why nothing in the brain ever went cold (measured 2026-09-04 with scripts/lifecycle-sweep.ts:
-- 156 scored notes, 118 sharing one written_at, 0 cold, 0 retirement candidates).
--
-- lib/mirror.ts's full-sync path stamped EVERY row with the head commit's date, and the rule this
-- file replaces — coalesce(excluded.last_commit_at, notes.last_commit_at) — let any non-null
-- incoming value win. So a rebuild, a force-push, or one commit touching more than PATCH_LIMIT
-- files reset the authorship age of the entire corpus to "today", and write_score (30% of the
-- temperature) alone held every note above the cold line: 0.30 × 0.90 = 0.27 > 0.20.
--
-- 20260806230000 had guarded the opposite failure — NULL rows coalescing to mirrored_at — and the
-- head-date stamp that followed replaced "everything looks written today" with "everything looks
-- written at head", the same defect wearing a date. Both versions guessed.
--
-- THE RULE NOW: CONTENT DECIDES. On an upsert whose content is unchanged the row keeps the date it
-- has, whatever the caller sent — a full sync carries every note, and a note the commit did not
-- change was not written by it. On an upsert whose content changed the row takes the caller's
-- date, and the caller is allowed not to know it: the patch path sends the head commit's date for
-- the files that commit touched, a full sync sends NULL for every row. NULL is honest for a
-- changed note — note_scores coalesces it to mirrored_at, and the note DID just change — and
-- dateUndatedNotes (lib/mirror.ts, run by the ops cron) learns the true date from the commits API
-- within a tick.
create or replace function sync_apply(
  expected_head text,
  new_head text,
  upserts jsonb default '[]'::jsonb,
  removes text[] default '{}'::text[]
) returns boolean
language plpgsql
set search_path = public, pg_catalog
as $$
declare
  current_head text;
begin
  select head_sha into current_head from sync_state where id is true for update;

  if current_head is distinct from expected_head then
    return false;
  end if;

  insert into notes (path, content, commit_sha, last_commit_at)
    select x.path, x.content, x.commit_sha, x.last_commit_at
    from jsonb_to_recordset(coalesce(upserts, '[]'::jsonb))
      as x(path text, content text, commit_sha text, last_commit_at timestamptz)
  on conflict (path) do update
    set content = excluded.content,
        commit_sha = excluded.commit_sha,
        -- Content decides (see the header). `is distinct from`, so a NULL on either side reads
        -- as a change rather than as unknown.
        last_commit_at = case
          when notes.content is distinct from excluded.content then excluded.last_commit_at
          else notes.last_commit_at
        end,
        mirrored_at = now();

  delete from notes where path = any(coalesce(removes, '{}'::text[]));

  insert into sync_state (id, head_sha, synced_at)
    values (true, new_head, now())
  on conflict (id) do update
    set head_sha = excluded.head_sha, synced_at = now();

  return true;
end
$$;

-- CREATE OR REPLACE resets every attribute the new definition does not state, which is why the
-- search_path pin from 20260811170000 is written into the definition above rather than trusted to
-- survive. Grants do survive a replace; the revokes are restated so this file stands on its own.
revoke execute on function sync_apply(text, text, jsonb, text[]) from public, anon, authenticated;

insert into public.schema_migrations(name,checksum) values('20260905100000_sync_apply_content_aware.sql','c2a2ba50caf95aea90dfff5408d4ac00c1e58cce7e3e730e80d7051c5df297b1');

-- IMMUTABLE FILE 20260908095014_corpus_snapshot.sql SHA256 10baa86566782e22e0e28b0ee6d212e72274ef961f2387815aa10518656d7724
-- One coherent, bounded corpus read for PostgREST. A STABLE function uses the snapshot of its
-- calling query for every SELECT it executes, so head and rows cannot straddle a concurrent
-- sync_apply transaction. The per-row JSON is measured before jsonb_agg is allowed to allocate
-- the array. Row bytes, array separators and the complete serialized envelope are counted exactly
-- inside the same 64 MiB ceiling used by the decompressed archive reader.
create or replace function public.corpus_snapshot()
returns jsonb
language plpgsql
stable
security invoker
set search_path = public, pg_catalog
as $$
declare
  snapshot_head text;
  row_count bigint;
  row_bytes bigint;
  payload_bytes bigint;
  max_payload_bytes constant bigint := 67108864;
begin
  select s.head_sha
    into snapshot_head
    from public.sync_state as s
    where s.id is true;

  select pg_catalog.count(*),
         coalesce(
           pg_catalog.sum(pg_catalog.octet_length(encoded.row_json::text)),
           0
         )
    into row_count, row_bytes
    from (
      select pg_catalog.jsonb_build_object(
               'path', n.path,
               'content', n.content,
               'commit_sha', n.commit_sha
             ) as row_json
        from public.notes as n
    ) as encoded;

  -- jsonb text renders array elements with a comma-and-space separator. The empty envelope
  -- already contributes both brackets, so replacing its empty array contents requires exactly
  -- the serialized row bytes plus two bytes between each adjacent pair.
  payload_bytes :=
    pg_catalog.octet_length(
      pg_catalog.jsonb_build_object(
        'head', snapshot_head,
        'rows', '[]'::jsonb
      )::text
    )::bigint
    + row_bytes
    + 2 * greatest(row_count - 1, 0);

  if payload_bytes > max_payload_bytes then
    raise exception using
      errcode = '54000',
      message = 'corpus snapshot exceeds 64 MiB safety limit';
  end if;

  return (
    select pg_catalog.jsonb_build_object(
             'head', snapshot_head,
             'rows', coalesce(
               pg_catalog.jsonb_agg(encoded.row_json order by encoded.path),
               '[]'::jsonb
             )
           )
      from (
        select n.path,
               pg_catalog.jsonb_build_object(
                 'path', n.path,
                 'content', n.content,
                 'commit_sha', n.commit_sha
               ) as row_json
          from public.notes as n
      ) as encoded
  );
end
$$;

revoke execute on function public.corpus_snapshot() from public, anon, authenticated;
grant execute on function public.corpus_snapshot() to service_role;

insert into public.schema_migrations(name,checksum) values('20260908095014_corpus_snapshot.sql','10baa86566782e22e0e28b0ee6d212e72274ef961f2387815aa10518656d7724');

-- IMMUTABLE FILE 20260908103956_bubble_open_scoped.sql SHA256 d66e5c8b23e174ccb7f9455ed83f2472e0c9ecc51accb46f8568be0cb6d938a6
-- Project-scoped working memory. Scope is applied before both count and limit, so a busy
-- unrelated project cannot hide an older open item for the requested project.
--
-- Project identity already uses ECMAScript's locale-independent Unicode lowercasing. PostgreSQL
-- lower() follows the database collation, so the default locale is not an equivalent contract.
-- Select a deterministic full-Unicode provider explicitly: PostgreSQL 18's built-in provider,
-- or an ICU root collation on older supported installations. If neither exists, fail migration
-- clearly; the application then takes its honest missing-RPC log fallback instead of silently
-- splitting non-ASCII project identities.
do $normalizer$
declare
  chosen text;
  candidate text;
  probe text[];
  trim_chars text := E' \t\n\r\v\f' || chr(160) || chr(5760) || chr(8192) || chr(8193) ||
    chr(8194) || chr(8195) || chr(8196) || chr(8197) || chr(8198) || chr(8199) || chr(8200) ||
    chr(8201) || chr(8202) || chr(8232) || chr(8233) || chr(8239) || chr(8287) || chr(12288) || chr(65279);
begin
  if to_regcollation('pg_catalog.pg_unicode_fast') is not null then
    chosen := 'pg_catalog.pg_unicode_fast';
  else
    for candidate in
      select format('%I.%I', n.nspname, c.collname)
        from pg_catalog.pg_collation c
        join pg_catalog.pg_namespace n on n.oid = c.collnamespace
       where c.collprovider = 'i'
         and c.collname in ('und-x-icu', 'unicode')
       order by (c.collname = 'und-x-icu') desc
    loop
      begin
        execute format(
          'select array[lower($1 collate %s), lower($2 collate %s), lower($3 collate %s), lower($4 collate %s)]',
          candidate, candidate, candidate, candidate
        ) into probe using 'İ', 'Σ', 'ΟΣ', 'K';
        if probe = array['i̇', 'σ', 'ος', 'k'] then
          chosen := candidate;
          exit;
        end if;
      exception when others then
        -- A catalog can retain ICU collation rows in a build without ICU support. Try the next
        -- deterministic provider and raise the explicit prerequisite below if none executes.
        null;
      end;
    end loop;
  end if;

  if chosen is null then
    raise exception 'bubble_open_scoped requires pg_unicode_fast (PostgreSQL 18+) or an executable ICU root collation with Unicode full case mapping';
  end if;

  execute format($create$
    create or replace function public.bubble_normalize_project(input text)
    returns text
    language sql
    immutable
    parallel safe
    set search_path = ''
    as $body$
      select pg_catalog.btrim(
        pg_catalog.regexp_replace(
          pg_catalog.regexp_replace(
            pg_catalog.lower(pg_catalog.btrim(input, %L) collate %s),
            '^projects/', ''
          ),
          '\.md$', ''
        ),
        %L
      )
    $body$
  $create$, trim_chars, chosen, trim_chars);
end
$normalizer$;

create index if not exists bubble_open_project_touched
  on public.bubble_items (
    (public.bubble_normalize_project(project)),
    touched_at desc,
    id desc
  )
  where status = 'open';

create or replace function public.bubble_open_scoped(
  max_age_days integer default 14,
  max_items integer default 200,
  project_name text default '',
  include_general boolean default false
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  swept integer;
  total integer;
  items jsonb;
  scope text := public.bubble_normalize_project(project_name);
begin
  update public.bubble_items
     set status = 'aged'
   where status = 'open'
     and touched_at < now() - make_interval(days => max_age_days);
  get diagnostics swept = row_count;

  select count(*)::integer into total
    from public.bubble_items
   where status = 'open'
     and (
       (scope <> '' and public.bubble_normalize_project(project) = scope)
       or (include_general and public.bubble_normalize_project(project) = '')
     );

  select coalesce(jsonb_agg(t), '[]'::jsonb) into items
  from (
    select id, kind, project, body, status, filed_into, surface, created_at, touched_at
      from public.bubble_items
     where status = 'open'
       and (
         (scope <> '' and public.bubble_normalize_project(project) = scope)
         or (include_general and public.bubble_normalize_project(project) = '')
       )
     order by touched_at desc, id desc
     limit greatest(max_items, 0)
  ) t;

  return jsonb_build_object('total', total, 'swept', swept, 'items', items);
end
$$;

revoke execute on function public.bubble_normalize_project(text) from public;
revoke execute on function public.bubble_normalize_project(text) from anon;
revoke execute on function public.bubble_normalize_project(text) from authenticated;
grant execute on function public.bubble_normalize_project(text) to service_role;

revoke execute on function public.bubble_open_scoped(integer, integer, text, boolean) from public;
revoke execute on function public.bubble_open_scoped(integer, integer, text, boolean) from anon;
revoke execute on function public.bubble_open_scoped(integer, integer, text, boolean) from authenticated;
grant execute on function public.bubble_open_scoped(integer, integer, text, boolean) to service_role;

insert into public.schema_migrations(name,checksum) values('20260908103956_bubble_open_scoped.sql','d66e5c8b23e174ccb7f9455ed83f2472e0c9ecc51accb46f8568be0cb6d938a6');

-- IMMUTABLE FILE 20260908121912_bubble_console_working_state.sql SHA256 d3571c01983b8a2fc1beb51fb179977296da977000c10a7cf6401521567ac38b
-- Requires bubble_items and the reviewed Unicode project normalizer from bubble_open_scoped.
-- Revisions belong to the database: old MCP/table writers and lazy age-out advance them too.
alter table public.bubble_items
  add column version bigint not null default 1 check (version > 0),
  add column console_request_key uuid unique,
  add column console_payload_digest text;

create function public.bubble_advance_version()
returns trigger language plpgsql security invoker set search_path = '' as $$
begin
  new.version := old.version + 1;
  -- An add's identity describes its ORIGINAL payload even after a model edits the item.
  new.console_request_key := old.console_request_key;
  new.console_payload_digest := old.console_payload_digest;
  return new;
end $$;
create trigger bubble_item_revision before update on public.bubble_items
  for each row execute function public.bubble_advance_version();

create function public.bubble_console_add(request_key uuid, item_kind text, item_body text, project_name text)
returns jsonb language plpgsql security invoker set search_path = '' as $$
declare
  item public.bubble_items;
  project text := public.bubble_normalize_project(project_name);
  fingerprint text;
begin
  if request_key is null or item_kind is null or item_kind not in ('focus','decision','question','handoff')
     or item_body is null or char_length(item_body) not between 1 and 2000 or octet_length(item_body) > 8000
     or btrim(item_body) = '' or project is null or char_length(project) > 80 or octet_length(project) > 320 then
    return jsonb_build_object('outcome','invalid');
  end if;
  fingerprint := encode(sha256(convert_to(jsonb_build_array(item_kind,item_body,project)::text,'UTF8')),'hex');
  insert into public.bubble_items(kind,body,project,surface,console_request_key,console_payload_digest)
    values(item_kind,item_body,project,'console',request_key,fingerprint)
    on conflict(console_request_key) do nothing;
  -- The unique constraint waits for competing inserts. A subsequent statement sees its winner.
  select * into item from public.bubble_items b where b.console_request_key = request_key for update;
  if not found then raise exception 'working state unavailable'; end if;
  if item.console_payload_digest <> fingerprint then return jsonb_build_object('outcome','key_conflict'); end if;
  if item.status = 'open' and item.touched_at < now() - interval '14 days' then
    update public.bubble_items set status='aged' where id=item.id returning * into item;
  end if;
  return jsonb_build_object('outcome','saved','item',to_jsonb(item));
end $$;

create function public.bubble_console_edit(
  item_id bigint, expected_version bigint, item_kind text default null, item_body text default null,
  project_name text default null, age_out boolean default false
)
returns jsonb language plpgsql security invoker set search_path = '' as $$
declare item public.bubble_items;
begin
  if item_id is null or item_id < 1 or expected_version is null or expected_version < 1 or age_out is null
     or (item_kind is not null and item_kind not in ('focus','decision','question','handoff'))
     or (item_body is not null and (char_length(item_body) not between 1 and 2000 or octet_length(item_body)>8000 or btrim(item_body)=''))
     or (project_name is not null and (char_length(public.bubble_normalize_project(project_name))>80 or octet_length(project_name)>320)) then
    return jsonb_build_object('outcome','invalid');
  end if;
  select * into item from public.bubble_items where id=item_id for update;
  if not found then return jsonb_build_object('outcome','missing'); end if;
  if item.status='open' and item.touched_at < now()-interval '14 days' then
    update public.bubble_items set status='aged' where id=item_id returning * into item;
  end if;
  if item.version <> expected_version or item.status <> 'open' then
    return jsonb_build_object('outcome','conflict','item',to_jsonb(item));
  end if;
  update public.bubble_items set
    kind=coalesce(item_kind,kind), body=coalesce(item_body,body),
    project=coalesce(public.bubble_normalize_project(project_name),project),
    status=case when age_out then 'aged' else status end, touched_at=now()
    where id=item_id returning * into item;
  return jsonb_build_object('outcome','saved','item',to_jsonb(item));
end $$;

create index bubble_console_open_order on public.bubble_items(touched_at desc,id desc) where status='open';

create function public.bubble_console_list(
  project_name text default null, before_touched timestamptz default null,
  before_id bigint default null, page_size integer default 20
)
returns jsonb language plpgsql security invoker set search_path = '' as $$
declare swept integer; result jsonb;
begin
  if page_size is null or page_size not between 1 and 50 or (before_touched is null) <> (before_id is null)
     or before_id < 1 or char_length(project_name)>80 then raise exception 'invalid management page'; end if;
  with aged as (
    update public.bubble_items set status='aged' where status='open' and touched_at<now()-interval '14 days'
    returning project
  ) select count(*)::integer into swept from aged
    where project_name is null or public.bubble_normalize_project(project)=public.bubble_normalize_project(project_name);
  -- One statement gives the count and page the same snapshot and exactly the same scope.
  with scoped as materialized (
    select id,version,kind,body,project,status,touched_at from public.bubble_items
    where status='open' and (project_name is null or public.bubble_normalize_project(project)=public.bubble_normalize_project(project_name))
  ), page as (
    select * from scoped where before_touched is null or (touched_at,id)<(before_touched,before_id)
    order by touched_at desc,id desc limit page_size+1
  ), shown as (select * from page order by touched_at desc,id desc limit page_size)
  select jsonb_build_object(
    'total',(select count(*) from scoped),'swept',swept,
    'items',coalesce((select jsonb_agg(s order by touched_at desc,id desc) from shown s),'[]'::jsonb),
    'next',case when (select count(*) from page)>page_size
      then (select jsonb_build_object('touched_at',touched_at,'id',id) from shown order by touched_at,id limit 1)
      else null end
  ) into result;
  return result;
end $$;

create function public.bubble_console_item(item_id bigint)
returns jsonb language plpgsql security invoker set search_path = '' as $$
declare item public.bubble_items;
begin
  select * into item from public.bubble_items where id=item_id for update;
  if not found then return null; end if;
  if item.status='open' and item.touched_at<now()-interval '14 days' then
    update public.bubble_items set status='aged' where id=item_id returning * into item;
  end if;
  return to_jsonb(item);
end $$;

-- Existing service writes remain supported; no browser role gains table or function access.
grant select,insert,update on public.bubble_items to service_role;
grant usage,select on sequence public.bubble_items_id_seq to service_role;
create policy bubble_service_working_state on public.bubble_items to service_role using(true) with check(true);
revoke execute on function public.bubble_advance_version() from public,anon,authenticated;
revoke execute on function public.bubble_console_add(uuid,text,text,text) from public,anon,authenticated;
revoke execute on function public.bubble_console_edit(bigint,bigint,text,text,text,boolean) from public,anon,authenticated;
revoke execute on function public.bubble_console_list(text,timestamptz,bigint,integer) from public,anon,authenticated;
revoke execute on function public.bubble_console_item(bigint) from public,anon,authenticated;
grant execute on function public.bubble_console_add(uuid,text,text,text) to service_role;
grant execute on function public.bubble_console_edit(bigint,bigint,text,text,text,boolean) to service_role;
grant execute on function public.bubble_console_list(text,timestamptz,bigint,integer) to service_role;
grant execute on function public.bubble_console_item(bigint) to service_role;

insert into public.schema_migrations(name,checksum) values('20260908121912_bubble_console_working_state.sql','d3571c01983b8a2fc1beb51fb179977296da977000c10a7cf6401521567ac38b');

-- IMMUTABLE FILE 20260908130734_console_devices.sql SHA256 439d9e5a9b7e10cc32e03667a0cd62440b906b02442723b4a7e3c0301768b3a4
-- Explicit browser inventory, not reporters, health, authentication or hardware discovery.
-- Live rows stay until Forget. Intent validity lasts 24 hours; expired request metadata
-- is pruned on a later valid admission and can remain longer on an inactive deployment.
create table public.console_devices (
  id uuid primary key,
  label text not null check (char_length(btrim(label)) between 1 and 60 and octet_length(label) <= 240 and label !~ '[[:cntrl:]]'),
  category text check (category in ('computer','phone','tablet','other')),
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  last_seen_at timestamptz
);
create table public.console_device_requests (
  request_key uuid primary key,
  input_fingerprint text not null check (input_fingerprint ~ '^[0-9a-f]{64}$'),
  expires_at timestamptz not null,
  -- Deliberately no FK cascade: an absent target is a forgotten outcome for this intent.
  target_id uuid not null
);
alter table public.console_devices enable row level security;
alter table public.console_device_requests enable row level security;
revoke all on public.console_devices, public.console_device_requests from public, anon, authenticated;
grant select, insert, update, delete on public.console_devices, public.console_device_requests to service_role;
create policy console_devices_service on public.console_devices to service_role using (true) with check (true);
create policy console_device_requests_service on public.console_device_requests to service_role using (true) with check (true);

create function public.console_device_list() returns jsonb language sql security invoker set search_path='' as $$
  select jsonb_build_object('items',coalesce((select jsonb_agg(to_jsonb(d) order by d.created_at,d.id) from public.console_devices d),'[]'::jsonb));
$$;

create function public.console_device_register(request_key uuid, intent_expires timestamptz, chosen_label text, chosen_category text, input_fingerprint text, current_id uuid default null)
returns jsonb language plpgsql security invoker set search_path='' as $$
declare d public.console_devices; r public.console_device_requests; moment timestamptz;
begin
  -- All admissions and Forget share one deployment-local lock. A count check cannot race.
  perform pg_advisory_xact_lock(763541,1);
  moment := clock_timestamp();
  if intent_expires is null or intent_expires <= moment or intent_expires > moment + interval '24 hours' then return jsonb_build_object('outcome','expired'); end if;
  if request_key is null or input_fingerprint is null or input_fingerprint !~ '^[0-9a-f]{64}$' or chosen_label is null or char_length(btrim(chosen_label)) not between 1 and 60 or octet_length(chosen_label)>240 or chosen_label ~ '[[:cntrl:]]' or (chosen_category is not null and chosen_category not in ('computer','phone','tablet','other')) then return jsonb_build_object('outcome','invalid'); end if;
  delete from public.console_device_requests where expires_at <= moment;
  select * into r from public.console_device_requests q where q.request_key=console_device_register.request_key;
  if found then
    if r.input_fingerprint <> input_fingerprint or r.expires_at <> intent_expires then return jsonb_build_object('outcome','key_conflict'); end if;
    select * into d from public.console_devices where id=r.target_id;
    if not found then return jsonb_build_object('outcome','forgotten'); end if;
    return jsonb_build_object('outcome','registered','item',to_jsonb(d));
  end if;
  if (select count(*) from public.console_device_requests)>=200 then return jsonb_build_object('outcome','recent_capacity'); end if;
  if current_id is not null then
    select * into d from public.console_devices where id=current_id;
  end if;
  -- A fresh explicit intent may replace a stale binding; passive reads/visits never clear it.
  -- Old intents were resolved above, so this cannot resurrect their forgotten targets.
  if d.id is null then
    if (select count(*) from public.console_devices)>=50 then return jsonb_build_object('outcome','capacity'); end if;
    insert into public.console_devices(id,label,category) values(request_key,btrim(chosen_label),chosen_category) returning * into d;
  end if;
  insert into public.console_device_requests values(request_key,input_fingerprint,intent_expires,d.id);
  return jsonb_build_object('outcome','registered','item',to_jsonb(d));
end;
$$;

create function public.console_device_rename(device_id uuid, expected_updated timestamptz, chosen_label text)
returns jsonb language plpgsql security invoker set search_path='' as $$
declare d public.console_devices;
begin
  if chosen_label is null or char_length(btrim(chosen_label)) not between 1 and 60 or octet_length(chosen_label)>240 or chosen_label ~ '[[:cntrl:]]' then return jsonb_build_object('outcome','invalid'); end if;
  select * into d from public.console_devices where id=device_id for update;
  if not found then return jsonb_build_object('outcome','missing'); end if;
  if expected_updated is null or d.updated_at <> expected_updated then return jsonb_build_object('outcome','conflict'); end if;
  update public.console_devices set label=btrim(chosen_label),updated_at=greatest(clock_timestamp(),d.updated_at+interval '1 microsecond') where id=device_id returning * into d;
  return jsonb_build_object('outcome','renamed','item',to_jsonb(d));
end;
$$;

create function public.console_device_forget(device_id uuid, expected_updated timestamptz)
returns jsonb language plpgsql security invoker set search_path='' as $$
declare d public.console_devices;
begin
  perform pg_advisory_xact_lock(763541,1);
  select * into d from public.console_devices where id=device_id for update;
  if found then
    if expected_updated is null or d.updated_at <> expected_updated then return jsonb_build_object('outcome','conflict'); end if;
    delete from public.console_devices where id=device_id;
  end if;
  return jsonb_build_object('outcome','forgotten','id',device_id);
end;
$$;

create function public.console_device_visit(device_id uuid) returns jsonb language plpgsql security invoker set search_path='' as $$
declare d public.console_devices;
begin
  select * into d from public.console_devices where id=device_id for update;
  if not found then return jsonb_build_object('outcome','missing'); end if;
  if d.last_seen_at is not null and d.last_seen_at > clock_timestamp()-interval '5 minutes' then return jsonb_build_object('outcome','throttled'); end if;
  update public.console_devices set last_seen_at=clock_timestamp() where id=device_id;
  return jsonb_build_object('outcome','visited');
end;
$$;

revoke all on function public.console_device_list(), public.console_device_register(uuid,timestamptz,text,text,text,uuid), public.console_device_rename(uuid,timestamptz,text), public.console_device_forget(uuid,timestamptz), public.console_device_visit(uuid) from public, anon, authenticated;
grant execute on function public.console_device_list(), public.console_device_register(uuid,timestamptz,text,text,text,uuid), public.console_device_rename(uuid,timestamptz,text), public.console_device_forget(uuid,timestamptz), public.console_device_visit(uuid) to service_role;

insert into public.schema_migrations(name,checksum) values('20260908130734_console_devices.sql','439d9e5a9b7e10cc32e03667a0cd62440b906b02442723b4a7e3c0301768b3a4');

-- IMMUTABLE FILE 20260908141154_learning_freshness.sql SHA256 b92af12e9032a91baf93f406e280b8188b67523362dc48691505239608b9cc73
-- Policy coaccess-v2-90d-closed-utc-6-2. Raw history and structural edges are retained.
-- A bounded mutation clock, not a second access log: at most 2161 UTC hour buckets.
create table public.edges_usage_hours (
  hour timestamptz primary key,
  revision bigint not null check (revision > 0)
);
alter table public.edges_usage_hours enable row level security;
revoke all on public.edges_usage_hours from public, anon, authenticated;
grant select, insert, update, delete on public.edges_usage_hours to service_role;
create policy edges_usage_service on public.edges_usage_hours for all to service_role using(true) with check(true);
create policy edges_state_service on public.edges_state for all to service_role using(true) with check(true);
create policy note_edges_service on public.note_edges for all to service_role using(true) with check(true);
alter table public.edges_state add column built_watermark text;
alter table public.edges_state add column built_cutoff timestamptz;
alter table public.edges_state add column built_policy text;
create index note_access_learning_at on public.note_access(at)
  where mode not in ('boot', 'handoff', 'maintenance');

create function public.edges_touch_hour(t timestamptz) returns void
language plpgsql security invoker set search_path = '' as $$
declare cutoff timestamptz := date_trunc('hour', statement_timestamp(), 'UTC');
begin
  if t >= cutoff - interval '2160 hours' and t < cutoff + interval '1 hour' then
    delete from public.edges_usage_hours where hour < cutoff - interval '2160 hours';
    insert into public.edges_usage_hours(hour,revision) values(date_trunc('hour',t,'UTC'),1)
      on conflict(hour) do update set revision=public.edges_usage_hours.revision+1;
  end if;
end $$;
create function public.edges_access_changed() returns trigger
language plpgsql security invoker set search_path = '' as $$
begin
  if tg_op = 'TRUNCATE' then
    perform public.edges_touch_hour(statement_timestamp()-interval '1 hour');
    return null;
  end if;
  if tg_op <> 'INSERT' and old.mode not in ('boot', 'handoff', 'maintenance') then
    perform public.edges_touch_hour(old.at);
  end if;
  if tg_op <> 'DELETE' and new.mode not in ('boot', 'handoff', 'maintenance') then
    perform public.edges_touch_hour(new.at);
  end if;
  return null;
end $$;
create trigger edges_access_mutation after insert or update or delete on public.note_access
  for each row execute function public.edges_access_changed();
create trigger edges_access_truncate after truncate on public.note_access
  for each statement execute function public.edges_access_changed();

create function public.edges_usage_identity() returns jsonb
language sql stable security invoker set search_path = '' as $$
  with boundary as (select date_trunc('hour',statement_timestamp(),'UTC') cutoff)
  select jsonb_build_object('policy','coaccess-v2-90d-closed-utc-6-2','cutoff',b.cutoff,
    'watermark',md5(coalesce((select string_agg(extract(epoch from h.hour)::text || ':' || h.revision::text,',' order by h.hour)
      from public.edges_usage_hours h where h.hour >= b.cutoff-interval '2160 hours' and h.hour < b.cutoff),'')))
  from boundary b
$$;
create function public.edges_freshness(new_head text) returns jsonb
language sql stable security invoker set search_path = '' set statement_timeout = '2s' as $$
  with input as (select public.edges_usage_identity() identity)
  select i.identity || jsonb_build_object('builtAt',(select built_at from public.edges_state where id is true),
    'structural',not exists(select 1 from public.edges_state s where s.id is true and s.built_head=new_head),'state',case
    when (select head_sha from public.sync_state where id is true) is distinct from new_head then 'stale-head'
    when exists(select 1 from public.edges_state s where s.id is true and s.built_head=new_head
      and s.built_watermark=i.identity->>'watermark' and s.built_cutoff=(i.identity->>'cutoff')::timestamptz
      and s.built_policy=i.identity->>'policy') then 'current' else 'stale' end)
  from input i
$$;

-- Nonblocking publication locks bound contention. A 100001-row probe refuses overload rather
-- than training on a silently truncated history. HTTP timeouts are NOT a rollback guarantee.
create function public.edges_rebuild_v2(new_head text, expected_watermark text,
  expected_cutoff timestamptz, edges jsonb, force boolean default false) returns text
language plpgsql security invoker set search_path = '' set statement_timeout = '5s' as $$
declare identity jsonb; samples jsonb; n bigint; mirror_head text;
begin
  if not pg_try_advisory_xact_lock(18462026,2) then return 'busy'; end if;
  lock table public.edges_usage_hours in share mode nowait;
  select head_sha into mirror_head from public.sync_state where id is true for share nowait;
  if mirror_head is distinct from new_head then return 'stale-head'; end if;
  identity := public.edges_usage_identity();
  if expected_watermark is distinct from identity->>'watermark'
    or expected_cutoff is distinct from (identity->>'cutoff')::timestamptz then return 'stale-input'; end if;
  if not force and public.edges_freshness(new_head)->>'state'='current' then return 'current'; end if;
  with bounded as materialized (
    select at,path from public.note_access where mode not in ('boot', 'handoff', 'maintenance')
      and at >= expected_cutoff-interval '2160 hours' and at < expected_cutoff limit 100001
  ) select count(*),jsonb_agg(jsonb_build_object('w',date_trunc('hour',at,'UTC'),'path',path)) into n,samples from bounded;
  if n > 100000 then return 'capacity'; end if;
  if edges is null and not exists(select 1 from public.edges_state where id is true and built_head=new_head) then return 'stale-input'; end if;
  if edges is not null and (jsonb_typeof(edges) is distinct from 'array' or jsonb_array_length(edges)>200000 or octet_length(edges::text)>16*1024*1024) then return 'capacity'; end if;
  if exists(select 1 from jsonb_to_recordset(edges) x(kind text) where x.kind='coaccess') then
    raise exception 'coaccess must be derived from eligible history';
  end if;
  delete from public.note_edges where edges is not null or kind='coaccess';
  insert into public.note_edges(src,dst,kind,weight,evidence,built_head)
    select x.src,x.dst,x.kind,x.weight,x.evidence,new_head from jsonb_to_recordset(edges)
      x(src text,dst text,kind text,weight real,evidence text);
  with reads as (
    select distinct x.w,x.path from jsonb_to_recordset(coalesce(samples,'[]'::jsonb)) x(w timestamptz,path text)
  ), focused as (select w from reads group by w having count(*)<=6), eligible as (
    select r.* from reads r join focused f using(w)
  ) insert into public.note_edges(src,dst,kind,weight,evidence,built_head)
    select a.path,b.path,'coaccess',count(*)::real,
      'co-read in ' || count(*) || ' shared UTC hours; coaccess-v2: last 90 days, completed hours, fanout <=6, >=2 windows; boot/handoff/maintenance excluded',new_head
    from eligible a join eligible b on a.w=b.w and a.path collate "C" < b.path collate "C"
    where exists(select 1 from public.notes n where n.path=a.path)
      and exists(select 1 from public.notes n where n.path=b.path)
    group by a.path,b.path having count(*)>=2;
  insert into public.edges_state(id,built_head,built_at,built_watermark,built_cutoff,built_policy)
    values(true,new_head,clock_timestamp(),expected_watermark,expected_cutoff,identity->>'policy')
    on conflict(id) do update set built_head=excluded.built_head,built_at=excluded.built_at,
      built_watermark=excluded.built_watermark,built_cutoff=excluded.built_cutoff,built_policy=excluded.built_policy;
  return 'rebuilt';
exception when lock_not_available then return 'busy';
end $$;

-- An old caller cannot publish a graph without the new identity contract.
drop function public.edges_rebuild(text,jsonb);
revoke execute on function public.edges_touch_hour(timestamptz),public.edges_access_changed(),
  public.edges_usage_identity(),public.edges_freshness(text),public.edges_rebuild_v2(text,text,timestamptz,jsonb,boolean)
  from public,anon,authenticated;
grant execute on function public.edges_touch_hour(timestamptz),public.edges_access_changed(),
  public.edges_usage_identity(),public.edges_freshness(text),public.edges_rebuild_v2(text,text,timestamptz,jsonb,boolean) to service_role;
grant select,insert,update on public.edges_state to service_role;
grant select,insert,delete on public.note_edges to service_role;
grant select on public.notes,public.note_access to service_role;
grant select,update on public.sync_state to service_role;

insert into public.schema_migrations(name,checksum) values('20260908141154_learning_freshness.sql','b92af12e9032a91baf93f406e280b8188b67523362dc48691505239608b9cc73');

-- IMMUTABLE FILE 20260908150350_ops_reliability.sql SHA256 322afcace9d01f1eb797cbb42437ee52ea7a897422d941997b72f2272e7a83c9
-- Ops-only coordination. Terminal execution evidence, visual state and transport acceptance
-- have separate identities. Invoker RPCs are service-only; no external call holds these locks.
alter table public.ops_runs add column terminal_outcome text
  check(terminal_outcome in ('succeeded','unverified','failed','crashed','needs_you'));

-- Historical reconstruction: prefer the actual finish receipt, not the sweep's mutable state.
update public.ops_runs r set terminal_outcome=coalesce(
  (select case when e.to_state in ('succeeded','unverified','failed','crashed','needs_you') then e.to_state end
   from public.ops_events e where e.run_id=r.id and e.kind='finish' order by e.id desc limit 1),
  case when r.exit_reason='question' then 'needs_you' when r.exit_reason='infra' then 'crashed'
       when r.exit_reason in ('code','timeout') then 'failed'
       when jsonb_array_length(r.evidence)>0 then 'succeeded' else 'unverified' end)
from public.ops_units u where u.id=r.unit_id and u.kind<>'machine' and r.ended_at is not null;

create table public.ops_monitor (
  unit_id text primary key references public.ops_units(id) on delete cascade,
  active_run_id bigint references public.ops_runs(id) on delete set null,
  failures integer not null default 0 check(failures>=0),
  visual text not null default 'scheduled',
  last_alert_key text,
  -- Acceptance receipt order, not outbox intent creation order. A delayed older intent
  -- accepted after a recovery creates new outstanding debt.
  accepted_alert bigint not null default 0,
  recovered_alert bigint not null default 0,
  last_recovery_key text,
  owed jsonb check(owed is null or octet_length(owed::text)<=2048),
  mail_status text,
  suppressed boolean not null default false,
  revision bigint not null default 0
);
alter table public.ops_monitor enable row level security;
create policy ops_monitor_service on public.ops_monitor to service_role using(true) with check(true);
insert into public.ops_monitor(unit_id,active_run_id,failures,visual,accepted_alert,recovered_alert)
select u.id,
 (select r.id from public.ops_runs r where r.unit_id=u.id and r.started_at is not null and r.ended_at is null order by r.started_at desc,r.id desc limit 1),
 (select count(*)::int from public.ops_runs r where r.unit_id=u.id and r.terminal_outcome='failed'
   and (r.ended_at,r.id)>coalesce((select row(x.ended_at,x.id) from public.ops_runs x where x.unit_id=u.id and x.terminal_outcome is not null and x.terminal_outcome<>'failed' order by x.ended_at desc,x.id desc limit 1),row('-infinity'::timestamptz,0::bigint))),
 coalesce((select e.to_state from public.ops_events e where e.unit_id=u.id and e.kind='transition' order by e.id desc limit 1),'scheduled'),
 coalesce((select max(e.id) from public.ops_events e where e.unit_id=u.id and e.kind='alert_sent' and e.to_state<>'succeeded'),0),
 -- Only a real recovery transport receipt answers a prior accepted alert. A transition does not.
 coalesce((select max(a.id) from public.ops_events a where a.unit_id=u.id and a.kind='alert_sent' and a.to_state<>'succeeded'
   and exists(select 1 from public.ops_events e where e.unit_id=u.id and e.kind='alert_sent' and e.to_state='succeeded' and e.id>a.id)),0)
from public.ops_units u;
update public.ops_monitor m set last_alert_key=(select 'alert:'||coalesce(e.run_id::text,'none')||':'||e.to_state from public.ops_events e where e.unit_id=m.unit_id and e.kind='alert_sent' and e.to_state<>'succeeded' order by e.id desc limit 1),
  last_recovery_key=case when recovered_alert>0 then 'recovery:'||recovered_alert else null end;

create function public.ops_report_atomic(report jsonb, observed_at timestamptz default clock_timestamp()) returns jsonb
language plpgsql security invoker set search_path=pg_catalog,public set statement_timeout='5s' as $$
declare u public.ops_units; r public.ops_runs; live public.ops_runs; m public.ops_monitor;
 v text:=report->>'verb'; k text:=report->>'run_key'; outcome text; reason text; v_evidence jsonb; t timestamptz:=observed_at;
begin
 if jsonb_typeof(report)<>'object' or octet_length(report::text)>65536 or t is null or not isfinite(t)
   or coalesce(length(report->>'unit'),0) not between 1 and 128 or coalesce(length(k),0) not between 1 and 256
   or v is null or v not in ('start','finish','heartbeat') then
   return jsonb_build_object('ok',false,'status',400,'error','invalid or oversized report');
 end if;
 if (report?'summary' and length(report->>'summary')>280) or (report?'error' and length(report->>'error')>4000)
   or (report?'facts' and (jsonb_typeof(report->'facts')<>'object' or octet_length((report->'facts')::text)>16384))
   or (report?'cost' and octet_length((report->'cost')::text)>4096)
   or (report?'ok' and jsonb_typeof(report->'ok')<>'boolean')
   or (report?'exit_reason' and report->>'exit_reason' not in ('code','infra','timeout','no_signal','question'))
   or (report?'trigger' and report->>'trigger' not in ('cron','manual','retry','webhook','heartbeat')) then
   return jsonb_build_object('ok',false,'status',400,'error','invalid report fields');
 end if;
 v_evidence:=coalesce(report->'evidence','[]');
 if jsonb_typeof(v_evidence)<>'array' then return jsonb_build_object('ok',false,'status',400,'error','invalid evidence');end if;
 if jsonb_array_length(v_evidence)>20 or exists(select 1 from jsonb_array_elements(v_evidence) x where jsonb_typeof(x)<>'string' or length(x#>>'{}')>2048) then
   return jsonb_build_object('ok',false,'status',400,'error','invalid evidence');
 end if;
 select * into u from public.ops_units where id=report->>'unit' for update;
 if not found then return jsonb_build_object('ok',false,'status',404,'error','unknown unit');end if;
 if u.max_run_s not between 0 and 86400 then return jsonb_build_object('ok',false,'status',400,'error','invalid unit lease bound');end if;
 insert into public.ops_monitor(unit_id) values(u.id) on conflict do nothing;
 select * into m from public.ops_monitor where unit_id=u.id;
 select * into r from public.ops_runs where unit_id=u.id and run_key=k;
 if v='start' then
   if r.started_at is not null then return jsonb_build_object('ok',true,'run',to_jsonb(r),'replay',true);end if;
   select * into live from public.ops_runs where id=m.active_run_id;
   if live.started_at is not null and live.ended_at is null and live.lease_until>=t then
     return jsonb_build_object('ok',false,'status',409,'error','unit has a live run','run',to_jsonb(live));
   end if;
   if r.id is null then
     insert into public.ops_runs(unit_id,run_key,trigger,started_at,lease_until,state,facts,updated_at)
       values(u.id,k,coalesce(report->>'trigger','cron'),t,t+u.max_run_s*interval '1 second','running',report->'facts',t) returning * into r;
   else
     update public.ops_runs set started_at=t,lease_until=t+u.max_run_s*interval '1 second',state='running',trigger=coalesce(report->>'trigger',trigger),updated_at=t where id=r.id returning * into r;
   end if;
   update public.ops_monitor set active_run_id=r.id,revision=revision+1 where unit_id=u.id;
   insert into public.ops_events(unit_id,run_id,at,actor,kind,to_state,body) values(u.id,r.id,t,'unit','start','running',jsonb_build_object('run_key',k));
 elsif v='heartbeat' and u.kind='machine' then
   -- Last-seen reporting is intentionally mutable, not an automation terminal outcome.
   if r.id is null then
     insert into public.ops_runs(unit_id,run_key,trigger,started_at,ended_at,state,facts,updated_at)
       values(u.id,k,'heartbeat',t,t,'seen',report->'facts',t) returning * into r;
   else
     update public.ops_runs set started_at=greatest(started_at,t),ended_at=greatest(ended_at,t),state='seen',lease_until=null,facts=coalesce(report->'facts',facts),updated_at=greatest(updated_at,t) where id=r.id returning * into r;
   end if;
   update public.ops_monitor set revision=revision+1 where unit_id=u.id;
   insert into public.ops_events(unit_id,run_id,at,actor,kind,to_state,body) values(u.id,r.id,t,'unit','heartbeat','seen',coalesce(report->'facts','{}'));
 else
   if r.id is null or r.started_at is null then return jsonb_build_object('ok',false,'status',404,'error','no started run for this key');end if;
   if v='finish' and r.terminal_outcome is not null then return jsonb_build_object('ok',true,'run',to_jsonb(r),'replay',true);end if;
   if r.ended_at is not null or m.active_run_id is distinct from r.id or r.lease_until is null or r.lease_until<t then
     return jsonb_build_object('ok',false,'status',409,'error','run no longer owns a live lease');
   end if;
   if v='heartbeat' then
     update public.ops_runs set lease_until=t+u.max_run_s*interval '1 second',facts=coalesce(report->'facts',facts),updated_at=t where id=r.id returning * into r;
     insert into public.ops_events(unit_id,run_id,at,actor,kind,body) values(u.id,r.id,t,'unit','heartbeat',jsonb_build_object('lease_until',r.lease_until));
   else
     reason:=case when coalesce((report->>'ok')::boolean,true) then null else coalesce(report->>'exit_reason','code') end;
     outcome:=case when reason='question' then 'needs_you' when reason='infra' then 'crashed' when reason is not null then 'failed'
       when jsonb_array_length(v_evidence)>0 then 'succeeded' else 'unverified' end;
     update public.ops_runs set ended_at=t,lease_until=null,state=outcome,terminal_outcome=outcome,exit_reason=reason,
       summary=report->>'summary',error=report->>'error',evidence=v_evidence,cost=report->'cost',updated_at=t where id=r.id returning * into r;
     update public.ops_monitor set active_run_id=null,failures=case when outcome='failed' then least(failures::bigint+1,2147483647)::integer else 0 end where unit_id=u.id;
     insert into public.ops_events(unit_id,run_id,at,actor,kind,from_state,to_state,body)
       values(u.id,r.id,t,'unit','finish','running',outcome,jsonb_build_object('evidence',v_evidence,'summary',r.summary,'error',r.error));
   end if;
   update public.ops_monitor set revision=revision+1 where unit_id=u.id;
 end if;
 return jsonb_build_object('ok',true,'run',to_jsonb(r),'replay',false);
end $$;

-- Older sweep writers cannot erase the terminal evidence after this migration.
create function public.ops_terminal_guard() returns trigger language plpgsql security invoker set search_path=pg_catalog,public as $$
begin
 if old.terminal_outcome is not null and
   (new.terminal_outcome,new.ended_at,new.exit_reason,new.evidence,new.summary,new.error,new.cost)
   is distinct from (old.terminal_outcome,old.ended_at,old.exit_reason,old.evidence,old.summary,old.error,old.cost) then
   raise exception 'terminal outcome is immutable' using errcode='23514';
 end if;
 return new;
end $$;
create trigger ops_terminal_immutable before update on public.ops_runs for each row execute function public.ops_terminal_guard();

revoke all on public.ops_monitor from public,anon,authenticated;
grant select,insert,update,delete on public.ops_monitor to service_role;
grant select,insert,update on public.ops_units,public.ops_runs,public.ops_events to service_role;
grant usage,select on sequence public.ops_runs_id_seq,public.ops_events_id_seq to service_role;
revoke all on function public.ops_report_atomic(jsonb,timestamptz),public.ops_terminal_guard() from public,anon,authenticated;
grant execute on function public.ops_report_atomic(jsonb,timestamptz),public.ops_terminal_guard() to service_role;

create function public.ops_monitor_init() returns trigger language plpgsql security invoker set search_path=pg_catalog,public as $$
begin insert into public.ops_monitor(unit_id) values(new.id);return new;end $$;
create trigger ops_monitor_init after insert on public.ops_units for each row execute function public.ops_monitor_init();

-- Acknowledgment admission shares the unit lock with snapshot commits. Pauses already UPDATE
-- that row. Reports, acknowledgments and mail completion cannot race a committed snapshot.
create function public.ops_ack_lock() returns trigger language plpgsql security invoker set search_path=pg_catalog,public as $$
begin
 if new.kind in ('ack','snooze') then perform 1 from public.ops_units where id=new.unit_id for update;end if;
 return new;
end $$;
create trigger ops_ack_lock before insert on public.ops_events for each row execute function public.ops_ack_lock();

create table public.ops_alert_outbox (
 id bigint primary key default nextval('public.ops_events_id_seq'),
 unit_id text not null references public.ops_units(id) on delete cascade,
 run_id bigint references public.ops_runs(id) on delete set null,
 logical_key text not null,
 provider_key text not null unique default ('cortex-ops/'||gen_random_uuid()::text),
 kind text not null check(kind in ('alert','recovery')),
 target_alert bigint not null default 0,
 to_state text not null,
 subject text not null check(length(subject)<=500),
 body text not null check(octet_length(body)<=16000),
 envelope jsonb,
 created_at timestamptz not null,
 state text not null default 'pending' check(state in ('pending','sending','accepted','terminal')),
 attempts integer not null default 0 check(attempts between 0 and 6),
 first_claim_at timestamptz,
 next_attempt_at timestamptz not null,
 lease_until timestamptz,
 claim_token uuid,
 finished_at timestamptz,
 provider_id text,
 last_error text,
 unique(unit_id,logical_key)
);
alter table public.ops_alert_outbox enable row level security;
create policy ops_outbox_service on public.ops_alert_outbox to service_role using(true) with check(true);
create index ops_outbox_due on public.ops_alert_outbox(next_attempt_at,id) where state in ('pending','sending');

create function public.ops_sweep_snapshot(unit_id text) returns jsonb
language sql stable security invoker set search_path=pg_catalog,public set statement_timeout='5s' as $$
 select data||jsonb_build_object('token',md5(data::text)) from (
 select jsonb_build_object('unit',to_jsonb(u),'run',
   (select to_jsonb(r) from public.ops_runs r where r.unit_id=u.id order by r.started_at desc nulls last,r.id desc limit 1),
   'ack',(select jsonb_build_object('at',e.at,'until',e.body->'until','id',e.id) from public.ops_events e where e.unit_id=u.id and e.kind in ('ack','snooze') order by e.at desc,e.id desc limit 1),
   'owed_run',(select to_jsonb(r) from public.ops_runs r where r.id=(m.owed->>'run_id')::bigint),
   'monitor',to_jsonb(m)) data
 from public.ops_units u join public.ops_monitor m on m.unit_id=u.id where u.id=$1) q;
$$;

create function public.ops_sweep_record(unit_id text, expected_token text, visual_state text, alert jsonb, observed_at timestamptz)
returns jsonb language plpgsql security invoker set search_path=pg_catalog,public set statement_timeout='5s' as $$
declare s jsonb;m public.ops_monitor; changed boolean; logical text; intent_id bigint; alert_kind text; d jsonb;t timestamptz:=observed_at;silenced boolean;
begin
 if t is null or not isfinite(t) or visual_state not in ('scheduled','late','missed','running','succeeded','unverified','failed','crashed','needs_you','acknowledged','paused','seen','quiet') then raise exception 'invalid sweep';end if;
 perform 1 from public.ops_units where id=unit_id for update;
 if not found then return jsonb_build_object('state','missing');end if;
 s:=public.ops_sweep_snapshot(unit_id);
 if s->>'token' is distinct from expected_token then return jsonb_build_object('state','conflict');end if;
 select * into m from public.ops_monitor where ops_monitor.unit_id=ops_sweep_record.unit_id;
 changed:=m.visual<>visual_state;
 silenced:=visual_state in ('acknowledged','paused') or not (s->'unit'->>'pages')::boolean or s->'unit'->>'kind'='machine';
 if m.suppressed is distinct from silenced then update public.ops_monitor set suppressed=silenced,revision=revision+1 where ops_monitor.unit_id=ops_sweep_record.unit_id;end if;
 if changed then
   insert into public.ops_events(unit_id,run_id,at,actor,kind,from_state,to_state,body)
     values(unit_id,(s->'run'->>'id')::bigint,t,'sweep','transition',m.visual,visual_state,'{}');
   update public.ops_monitor set visual=visual_state,revision=revision+1 where ops_monitor.unit_id=ops_sweep_record.unit_id;
 end if;
 if alert is not null and alert<>'null'::jsonb and not silenced then
   if jsonb_typeof(alert)<>'object' or octet_length(alert::text)>20000 or length(alert->>'subject')>500 or octet_length(alert->>'text')>16000 then raise exception 'invalid alert';end if;
   d:=m.owed;
   alert_kind:=coalesce(d->>'kind',alert->>'kind');
   if alert_kind='recovery' then
     if d is null and (m.accepted_alert<=m.recovered_alert or visual_state<>'succeeded') then return jsonb_build_object('state','recorded','transition',changed);end if;
     logical:='recovery:'||coalesce(d->>'target',m.accepted_alert::text);
     if logical=m.last_recovery_key then return jsonb_build_object('state','recorded','transition',changed);end if;
   elsif alert_kind='alert' then
     logical:='alert:'||coalesce(d->>'run_id',s->'run'->>'id','none')||':'||coalesce(d->>'to',visual_state);
     if logical=m.last_alert_key then return jsonb_build_object('state','recorded','transition',changed);end if;
   else raise exception 'invalid alert kind';end if;
   if d is null then
     d:=jsonb_build_object('kind',alert_kind,'run_id',s->'run'->'id','from',m.visual,'to',visual_state,'at',t,'target',m.accepted_alert);
     update public.ops_monitor set owed=d,revision=revision+1 where ops_monitor.unit_id=ops_sweep_record.unit_id;
   end if;
   -- Capacity and cleanup share one small Ops-only admission lock. Reporting never takes it.
   perform pg_advisory_xact_lock(18462026,3);
   delete from public.ops_alert_outbox where state in ('accepted','terminal') and finished_at<t-interval '30 days';
   if (select count(*) from public.ops_alert_outbox)>=200 then
     -- Do NOT advance the logical cursor: the unchanged visual state still owes this alert.
     update public.ops_monitor set mail_status='outbox_capacity' where ops_monitor.unit_id=ops_sweep_record.unit_id;
     if m.mail_status is distinct from 'outbox_capacity' then insert into public.ops_events(unit_id,run_id,at,actor,kind,body) values(unit_id,(d->>'run_id')::bigint,t,'sweep','alert_failed','{"error":"outbox_capacity: alert remains owed"}');end if;
     return jsonb_build_object('state','capacity','transition',changed);
   end if;
   insert into public.ops_alert_outbox(unit_id,run_id,logical_key,kind,target_alert,to_state,subject,body,created_at,next_attempt_at)
     values(unit_id,(d->>'run_id')::bigint,logical,alert_kind,case when alert_kind='recovery' then (d->>'target')::bigint else 0 end,d->>'to',alert->>'subject',alert->>'text',(d->>'at')::timestamptz,t)
     on conflict on constraint ops_alert_outbox_unit_id_logical_key_key do nothing returning id into intent_id;
   update public.ops_monitor set last_alert_key=case when alert_kind='alert' then logical else last_alert_key end,
     last_recovery_key=case when alert_kind='recovery' then logical else last_recovery_key end,owed=null,mail_status='pending',revision=revision+1 where ops_monitor.unit_id=ops_sweep_record.unit_id;
 end if;
 return jsonb_build_object('state','recorded','transition',changed,'intent',intent_id);
end $$;

-- Claims are one at a time. At most six claims, including lost responses/worker deaths.
-- The first claim begins the conservative 23-hour provider retry window, before any send.
create function public.ops_alert_claim(observed_at timestamptz, envelope jsonb) returns jsonb
language plpgsql security invoker set search_path=pg_catalog,public set statement_timeout='5s' as $$
declare a public.ops_alert_outbox; t timestamptz:=observed_at; bad text;
begin
 if t is null or not isfinite(t) then raise exception 'invalid claim time';end if;
 select * into a from public.ops_alert_outbox o where state in ('pending','sending') and next_attempt_at<=t
   -- Current pause/ack inputs, never a cached visual suppression bit: expiry can unblock
   -- delivery before this unit gets another observation turn.
   and (lease_until is null or lease_until<t)
   and exists(select 1 from public.ops_units u where u.id=o.unit_id and u.pages and u.kind<>'machine' and (u.paused_until is null or u.paused_until<=t))
   and not exists(select 1 from (select e.at,e.body from public.ops_events e where e.unit_id=o.unit_id and e.kind in ('ack','snooze') order by e.at desc,e.id desc limit 1) ack
     where (ack.body->>'until' is null or (ack.body->>'until')::timestamptz>t)
       -- A newer run spends this acknowledgment only for its own alert, never for an
       -- already queued alert belonging to an older acknowledged run.
       and ack.at>=coalesce((select r.started_at from public.ops_runs r where r.id=o.run_id),'-infinity'::timestamptz))
   order by next_attempt_at,id for update skip locked limit 1;
 if not found then return null;end if;
 if a.attempts>=6 then bad:='attempts_exhausted';
 elsif a.first_claim_at is not null and t>=a.first_claim_at+interval '23 hours' then bad:='provider_window_expired';
 end if;
 if bad is not null then
   update public.ops_alert_outbox set state='terminal',finished_at=t,lease_until=null,claim_token=null,last_error=bad where id=a.id;
   insert into public.ops_events(unit_id,run_id,at,actor,kind,to_state,body) values(a.unit_id,a.run_id,t,'sweep','alert_failed',a.to_state,jsonb_build_object('error',bad,'outbox',a.id,'terminal',true,'provider_key',a.provider_key,'first_claim_at',a.first_claim_at,'attempts',a.attempts));
   return jsonb_build_object('state','terminal','unit_id',a.unit_id);
 end if;
 if envelope is null or envelope='null'::jsonb then
   update public.ops_alert_outbox set next_attempt_at=t+interval '15 minutes',last_error='mail_unavailable' where id=a.id;
   if a.last_error is distinct from 'mail_unavailable' then
     insert into public.ops_events(unit_id,run_id,at,actor,kind,to_state,body) values(a.unit_id,a.run_id,t,'sweep','alert_failed',a.to_state,jsonb_build_object('error','mail_unavailable','outbox',a.id));
   end if;
   return jsonb_build_object('state','unavailable','unit_id',a.unit_id);
 end if;
 if jsonb_typeof(envelope)<>'object' or octet_length(envelope::text)>2048 or coalesce(length(envelope->>'from'),0) not between 1 and 512
   or coalesce(length(envelope->>'to'),0) not between 1 and 320 or coalesce(length(envelope->>'credential'),0)<>64 then raise exception 'invalid mail envelope';end if;
 if a.envelope is not null and a.envelope->>'credential' is distinct from envelope->>'credential' then
   update public.ops_alert_outbox set next_attempt_at=t+interval '15 minutes',last_error='mail_credentials_changed' where id=a.id;
   if a.last_error is distinct from 'mail_credentials_changed' then
     insert into public.ops_events(unit_id,run_id,at,actor,kind,to_state,body) values(a.unit_id,a.run_id,t,'sweep','alert_failed',a.to_state,jsonb_build_object('error','mail_credentials_changed','outbox',a.id));
   end if;
   return jsonb_build_object('state','unavailable','unit_id',a.unit_id);
 end if;
 update public.ops_alert_outbox set state='sending',envelope=coalesce(ops_alert_outbox.envelope,ops_alert_claim.envelope),
   first_claim_at=coalesce(first_claim_at,t),attempts=attempts+1,lease_until=t+interval '60 seconds',claim_token=gen_random_uuid()
   where id=a.id returning * into a;
 return to_jsonb(a);
end $$;

create function public.ops_alert_complete(alert_id bigint, token uuid, result jsonb, observed_at timestamptz) returns text
language plpgsql security invoker set search_path=pg_catalog,public set statement_timeout='5s' as $$
declare a public.ops_alert_outbox; t timestamptz:=observed_at; accepted boolean; terminal boolean; safe_error text; receipt_id bigint;
begin
 if t is null or not isfinite(t) or jsonb_typeof(result)<>'object' or octet_length(result::text)>1024 then raise exception 'invalid completion';end if;
 -- No row lock is held while acquiring the unit: the same order as sweep commits.
 select * into a from public.ops_alert_outbox where id=alert_id;
 if not found then return 'missing';end if;
 perform 1 from public.ops_units where id=a.unit_id for update;
 select * into a from public.ops_alert_outbox where id=alert_id for update;
 if a.state<>'sending' or a.claim_token is distinct from token or a.lease_until<t then return 'stale';end if;
 accepted:=coalesce((result->>'ok')::boolean,false) and coalesce(length(result->>'id'),0) between 1 and 256;
 terminal:=not coalesce((result->>'retryable')::boolean,true) or a.attempts>=6 or t>=a.first_claim_at+interval '23 hours';
 safe_error:=case when result->>'error' in ('transport_unavailable','invalid_response','response_too_large','request_too_large','invalid_idempotent_request','concurrent_idempotent_requests','provider_rejected','provider_unavailable','mail_unavailable','provider_window_expired') then result->>'error' else 'transport_unavailable' end;
 update public.ops_alert_outbox set state=case when accepted then 'accepted' when terminal then 'terminal' else 'pending' end,
   finished_at=case when accepted or terminal then t else null end,provider_id=case when accepted then result->>'id' else null end,
   last_error=case when accepted then null else safe_error end,lease_until=null,claim_token=null,
   next_attempt_at=t+make_interval(secs=>least(14400,60*power(4,a.attempts-1))::integer) where id=a.id;
 insert into public.ops_events(unit_id,run_id,at,actor,kind,to_state,body) values(a.unit_id,a.run_id,t,'sweep',case when accepted then 'alert_sent' else 'alert_failed' end,a.to_state,
   case when accepted then jsonb_build_object('id',result->>'id','outbox',a.id,'meaning','provider_accepted_not_inbox_delivery')
   else jsonb_build_object('status',coalesce((result->>'status')::integer,0),'error',safe_error,'terminal',terminal,'outbox',a.id,'provider_key',a.provider_key,'first_claim_at',a.first_claim_at,'attempts',a.attempts) end) returning id into receipt_id;
 if accepted then
   -- The unit lock serializes these receipts. The recovery target remains the acceptance
   -- observed when that recovery was enqueued, so it cannot cover a later acceptance.
   update public.ops_monitor set accepted_alert=case when a.kind='alert' then greatest(accepted_alert,receipt_id) else accepted_alert end,
     recovered_alert=case when a.kind='recovery' then greatest(recovered_alert,a.target_alert) else recovered_alert end,revision=revision+1 where unit_id=a.unit_id;
 end if;
 return case when accepted then 'accepted' when terminal then 'terminal' else 'pending' end;
end $$;

revoke all on public.ops_alert_outbox from public,anon,authenticated;
grant select,insert,update,delete on public.ops_alert_outbox to service_role;
revoke all on function public.ops_monitor_init(),public.ops_ack_lock(),public.ops_sweep_snapshot(text),public.ops_sweep_record(text,text,text,jsonb,timestamptz),public.ops_alert_claim(timestamptz,jsonb),public.ops_alert_complete(bigint,uuid,jsonb,timestamptz) from public,anon,authenticated;
grant execute on function public.ops_monitor_init(),public.ops_ack_lock(),public.ops_sweep_snapshot(text),public.ops_sweep_record(text,text,text,jsonb,timestamptz),public.ops_alert_claim(timestamptz,jsonb),public.ops_alert_complete(bigint,uuid,jsonb,timestamptz) to service_role;

create function public.ops_delivery_status(unit_id text) returns text
language sql stable security invoker set search_path=pg_catalog,public set statement_timeout='5s' as $$
 select case when m.owed is not null then 'outbox_capacity' else coalesce(
   (select case when a.state='terminal' then 'terminal:'||coalesce(a.last_error,'unknown')
                when a.state='accepted' then 'provider_accepted' else coalesce(a.last_error,'pending') end
    from public.ops_alert_outbox a where a.unit_id=m.unit_id
    order by (a.state in ('pending','sending')) desc,a.id desc limit 1),
   -- Payload pruning must not turn a completed receipt back into "pending".
   (select case when e.kind='alert_sent' then 'provider_accepted'
                when e.body->>'terminal'='true' then 'terminal:'||coalesce(e.body->>'error','unknown')
                else e.body->>'error' end
    from public.ops_events e where e.unit_id=m.unit_id and e.kind in ('alert_sent','alert_failed')
    order by e.at desc,e.id desc limit 1),m.mail_status) end
 from public.ops_monitor m where m.unit_id=$1;
$$;
revoke all on function public.ops_delivery_status(text) from public,anon,authenticated;
grant execute on function public.ops_delivery_status(text) to service_role;

insert into public.schema_migrations(name,checksum) values('20260908150350_ops_reliability.sql','322afcace9d01f1eb797cbb42437ee52ea7a897422d941997b72f2272e7a83c9');

-- IMMUTABLE FILE 20260908160000_console_jobs.sql SHA256 a395637ee1e91edd81064449a0261395819e53b0b26d83f0edf42e9473cdbd63
-- Durable console commands are separate from reporter runs, alerts and browser inventory.
-- Request bodies, credentials and note text have no column here; only bounded command receipts.
create table public.console_jobs (
  id uuid primary key default gen_random_uuid(),
  request_key uuid not null unique,
  input_fingerprint text not null check (input_fingerprint ~ '^[0-9a-f]{64}$'),
  operation text not null check (operation in ('diagnostics','checks','migrations.check','migrations.apply','deploy.preview','deploy.production')),
  target text not null check (char_length(btrim(target)) between 1 and 160 and octet_length(target) <= 640 and target !~ '[[:cntrl:]]'),
  source_sha text check (source_sha ~ '^[0-9a-f]{7,64}$'),
  state text not null default 'queued' check (state in ('queued','running','succeeded','failed','uncertain')),
  requested_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  dispatch_token uuid,
  result jsonb not null default '{"checks":[],"summary":"Queued"}'::jsonb check (jsonb_typeof(result)='object' and octet_length(result::text) <= 32768),
  summary text not null default 'Queued' check (char_length(summary)<=1000),
  check_count integer not null default 0 check (check_count between 0 and 64),
  provider_id text check (char_length(provider_id) <= 256 and octet_length(provider_id) <= 1024),
  unresolved_acknowledged_at timestamptz,
  check ((state='running' and dispatch_token is not null) or (state='uncertain') or (state not in ('running','uncertain') and dispatch_token is null))
);

-- The one-row guard is deliberately stronger than the per-operation/target uniqueness rule.
-- An uncertain mutation continues to own it until reconciliation or an explicit acknowledgment.
create table public.console_job_mutation_guard (
  singleton boolean primary key default true check (singleton),
  job_id uuid unique references public.console_jobs(id) on delete restrict
);
insert into public.console_job_mutation_guard(singleton,job_id) values(true,null);

create unique index console_jobs_active_target on public.console_jobs(operation,target) where state in ('queued','running');
create index console_jobs_page on public.console_jobs(requested_at desc,id desc);

alter table public.console_jobs enable row level security;
alter table public.console_job_mutation_guard enable row level security;
revoke all on public.console_jobs,public.console_job_mutation_guard from public,anon,authenticated;
grant select,insert,update,delete on public.console_jobs to service_role;
grant select,insert,update on public.console_job_mutation_guard to service_role;
create policy console_jobs_service on public.console_jobs to service_role using(true) with check(true);
create policy console_job_guard_service on public.console_job_mutation_guard to service_role using(true) with check(true);

create function public.console_job_enqueue(request_key uuid,input_fingerprint text,operation_name text,target_name text,source_sha text default null)
returns jsonb language plpgsql security invoker set search_path='' set statement_timeout='5s' as $$
declare current_job public.console_jobs; guard_job uuid; mutation boolean; moment timestamptz:=clock_timestamp();
begin
  if request_key is null or input_fingerprint is null or input_fingerprint !~ '^[0-9a-f]{64}$'
    or operation_name not in ('diagnostics','checks','migrations.check','migrations.apply','deploy.preview','deploy.production')
    or target_name is null or char_length(btrim(target_name)) not between 1 and 160 or octet_length(target_name)>640 or target_name ~ '[[:cntrl:]]'
    or (source_sha is not null and source_sha !~ '^[0-9a-f]{7,64}$') then
    return jsonb_build_object('outcome','invalid');
  end if;
  perform pg_advisory_xact_lock(763541,2);
  insert into public.console_job_mutation_guard(singleton,job_id) values(true,null) on conflict(singleton) do nothing;
  -- Retention is intentionally narrow: only terminal diagnostics/tests, never uncertain or
  -- migration/deployment receipts. Inactive deployments may retain these longer than 30 days.
  delete from public.console_jobs where operation in ('diagnostics','checks') and state in ('succeeded','failed') and updated_at < moment-interval '30 days';
  select * into current_job from public.console_jobs j where j.request_key=console_job_enqueue.request_key;
  if found then
    if current_job.input_fingerprint<>input_fingerprint then return jsonb_build_object('outcome','key_conflict');end if;
    return jsonb_build_object('outcome','replay','job',to_jsonb(current_job));
  end if;
  if exists(select 1 from public.console_jobs j where j.operation=operation_name and j.target=btrim(target_name) and j.state in ('queued','running')) then
    return jsonb_build_object('outcome','active');
  end if;
  if (select count(*) from public.console_jobs where state in ('queued','running'))>=20 then return jsonb_build_object('outcome','capacity');end if;
  mutation:=operation_name in ('migrations.apply','deploy.preview','deploy.production');
  if mutation then
    select job_id into guard_job from public.console_job_mutation_guard where singleton for update;
    if guard_job is not null then return jsonb_build_object('outcome','mutation_busy');end if;
  end if;
  insert into public.console_jobs(request_key,input_fingerprint,operation,target,source_sha)
    values(request_key,input_fingerprint,operation_name,btrim(target_name),source_sha) returning * into current_job;
  if mutation then update public.console_job_mutation_guard set job_id=current_job.id where singleton;end if;
  return jsonb_build_object('outcome','enqueued','job',to_jsonb(current_job));
end;
$$;

create function public.console_job_claim(job_id uuid) returns jsonb
language plpgsql security invoker set search_path='' set statement_timeout='5s' as $$
declare current_job public.console_jobs;
begin
  select * into current_job from public.console_jobs j where j.id=console_job_claim.job_id for update;
  if not found then return jsonb_build_object('outcome','missing');end if;
  if current_job.state<>'queued' then return jsonb_build_object('outcome','not_claimed','job',to_jsonb(current_job));end if;
  update public.console_jobs set state='running',dispatch_token=gen_random_uuid(),updated_at=clock_timestamp()
    where id=current_job.id returning * into current_job;
  return jsonb_build_object('outcome','claimed','token',current_job.dispatch_token,'job',to_jsonb(current_job));
end;
$$;

create function public.console_job_publish(job_id uuid,claim_token uuid,completion_state text,result_value jsonb,provider_identity text default null,source_sha text default null)
returns jsonb language plpgsql security invoker set search_path='' set statement_timeout='5s' as $$
declare current_job public.console_jobs; mutation boolean;
begin
  if completion_state is null or completion_state not in ('succeeded','failed','uncertain') or result_value is null or jsonb_typeof(result_value)<>'object'
    or jsonb_typeof(result_value->'checks')<>'array' or jsonb_typeof(result_value->'summary')<>'string'
    or char_length(result_value->>'summary')>1000 or octet_length(result_value::text)>32768
    or (provider_identity is not null and (char_length(provider_identity)>256 or octet_length(provider_identity)>1024))
    or (source_sha is not null and source_sha !~ '^[0-9a-f]{7,64}$') then return jsonb_build_object('outcome','invalid');end if;
  if jsonb_array_length(result_value->'checks')>64 or exists(select 1 from jsonb_array_elements(result_value->'checks') c
    where jsonb_typeof(c)<>'object' or not (c ? 'name' and c ? 'state' and c ? 'detail') or (select count(*) from jsonb_object_keys(c))<>3
      or jsonb_typeof(c->'name')<>'string' or char_length(c->>'name') not between 1 and 120 or c->>'state' not in ('passed','failed','skipped','unavailable')
      or jsonb_typeof(c->'detail')<>'string' or char_length(c->>'detail')>500) then return jsonb_build_object('outcome','invalid');end if;
  select * into current_job from public.console_jobs j where j.id=console_job_publish.job_id for update;
  if not found then return jsonb_build_object('outcome','missing');end if;
  -- The original claim token can reconcile an uncertain provider result, but claim() can never
  -- redispatch it. No other token can publish or release its mutation guard.
  if current_job.state not in ('running','uncertain') or current_job.dispatch_token is distinct from claim_token then
    return jsonb_build_object('outcome','stale','job',to_jsonb(current_job));
  end if;
  update public.console_jobs set state=completion_state,dispatch_token=case when completion_state='uncertain' then current_job.dispatch_token else null end,result=result_value,summary=result_value->>'summary',check_count=jsonb_array_length(result_value->'checks'),provider_id=coalesce(provider_identity,current_job.provider_id),
    source_sha=coalesce(console_job_publish.source_sha,console_jobs.source_sha),updated_at=clock_timestamp()
    where id=current_job.id returning * into current_job;
  mutation:=current_job.operation in ('migrations.apply','deploy.preview','deploy.production');
  if mutation and completion_state<>'uncertain' then
    update public.console_job_mutation_guard set job_id=null where singleton and console_job_mutation_guard.job_id=current_job.id;
  end if;
  return jsonb_build_object('outcome','published','job',to_jsonb(current_job));
end;
$$;

create function public.console_job_acknowledge_uncertain(job_id uuid) returns jsonb
language plpgsql security invoker set search_path='' set statement_timeout='5s' as $$
declare current_job public.console_jobs;
begin
  perform pg_advisory_xact_lock(763541,2);
  select * into current_job from public.console_jobs j where j.id=console_job_acknowledge_uncertain.job_id for update;
  if not found then return jsonb_build_object('outcome','missing');end if;
  if current_job.state<>'uncertain' or current_job.operation not in ('migrations.apply','deploy.preview','deploy.production') then
    return jsonb_build_object('outcome','not_uncertain','job',to_jsonb(current_job));
  end if;
  update public.console_jobs set unresolved_acknowledged_at=clock_timestamp(),updated_at=clock_timestamp() where id=current_job.id returning * into current_job;
  update public.console_job_mutation_guard set job_id=null where singleton and console_job_mutation_guard.job_id=current_job.id;
  return jsonb_build_object('outcome','acknowledged','job',to_jsonb(current_job));
end;
$$;

revoke all on function public.console_job_enqueue(uuid,text,text,text,text),public.console_job_claim(uuid),public.console_job_publish(uuid,uuid,text,jsonb,text,text),public.console_job_acknowledge_uncertain(uuid) from public,anon,authenticated;
grant execute on function public.console_job_enqueue(uuid,text,text,text,text),public.console_job_claim(uuid),public.console_job_publish(uuid,uuid,text,jsonb,text,text),public.console_job_acknowledge_uncertain(uuid) to service_role;

insert into public.schema_migrations(name,checksum) values('20260908160000_console_jobs.sql','a395637ee1e91edd81064449a0261395819e53b0b26d83f0edf42e9473cdbd63');

-- IMMUTABLE FILE 20260908163000_console_job_claim_recovery.sql SHA256 8f2c165f68c90b95feed3b177f0ed8dc3e060d4af1570ad141095b2200106351
-- Bind an execution claim to the request that received it. This is a forward migration:
-- installations that already applied 20260908160000_console_jobs.sql keep every receipt.
alter table public.console_jobs add column if not exists claim_owner uuid;

create function public.console_job_claim(job_id uuid, owner_token uuid) returns jsonb
language plpgsql security invoker set search_path='' set statement_timeout='5s' as $$
declare current_job public.console_jobs;
begin
  if owner_token is null then return jsonb_build_object('outcome','invalid'); end if;
  select * into current_job from public.console_jobs j where j.id=console_job_claim.job_id for update;
  if not found then return jsonb_build_object('outcome','missing'); end if;

  if current_job.state='queued' then
    update public.console_jobs
      set state='running',dispatch_token=gen_random_uuid(),claim_owner=owner_token,updated_at=clock_timestamp()
      where id=current_job.id returning * into current_job;
    return jsonb_build_object('outcome','claimed','token',current_job.dispatch_token,'job',to_jsonb(current_job));
  end if;

  -- Retrying a claim whose response was lost returns the original token only to the same
  -- request owner. It does not dispatch a second worker.
  if current_job.state='running' and current_job.claim_owner=owner_token then
    return jsonb_build_object('outcome','claimed','token',current_job.dispatch_token,'job',to_jsonb(current_job));
  end if;

  return jsonb_build_object('outcome','not_claimed','job',to_jsonb(current_job));
end;
$$;

-- Explicit operator recovery for a caller that vanished after its claim committed. There is no
-- age inference. Local diagnostics fence late publication; provider tokens stay available for
-- reconciliation, and mutation guards remain untouched until reconciliation or acknowledgement.
create function public.console_job_mark_uncertain(job_id uuid) returns jsonb
language plpgsql security invoker set search_path='' set statement_timeout='5s' as $$
declare current_job public.console_jobs; local_diagnostic boolean;
begin
  select * into current_job from public.console_jobs j where j.id=console_job_mark_uncertain.job_id for update;
  if not found then return jsonb_build_object('outcome','missing'); end if;
  if current_job.state<>'running' then
    return jsonb_build_object('outcome','not_running','job',to_jsonb(current_job));
  end if;
  local_diagnostic:=current_job.operation='diagnostics';
  update public.console_jobs
    set state='uncertain',
        -- A local diagnostic has no external completion to reconcile, so fence any late
        -- publisher. Provider work retains its claim token and the mutation guard.
        dispatch_token=case when local_diagnostic then null else current_job.dispatch_token end,
        claim_owner=case when local_diagnostic then null else current_job.claim_owner end,
        result=jsonb_build_object(
          'checks',jsonb_build_array(jsonb_build_object(
            'name',case when local_diagnostic then 'diagnostic execution' else current_job.operation end,
            'state','unavailable',
            'detail',case when local_diagnostic
              then 'The diagnostic worker response was lost; no external operation was dispatched.'
              else 'The worker response was lost; reconcile the provider before retrying.' end
          )),
          'summary',case when local_diagnostic
            then 'Diagnostic outcome uncertain · run a new explicitly labeled diagnostic if needed'
            else 'Outcome uncertain · reconcile the provider before retrying' end
        ),
        summary=case when local_diagnostic
          then 'Diagnostic outcome uncertain · run a new explicitly labeled diagnostic if needed'
          else 'Outcome uncertain · reconcile the provider before retrying' end,
        check_count=1,updated_at=clock_timestamp()
    where id=current_job.id returning * into current_job;
  return jsonb_build_object('outcome','marked_uncertain','job',to_jsonb(current_job));
end;
$$;

revoke all on function public.console_job_claim(uuid,uuid),public.console_job_mark_uncertain(uuid) from public,anon,authenticated;
grant execute on function public.console_job_claim(uuid,uuid),public.console_job_mark_uncertain(uuid) to service_role;

insert into public.schema_migrations(name,checksum) values('20260908163000_console_job_claim_recovery.sql','8f2c165f68c90b95feed3b177f0ed8dc3e060d4af1570ad141095b2200106351');

-- IMMUTABLE FILE 20260908205956_console_job_providers.sql SHA256 4cd364f8666b8fc04500ad360100b2c4107cc2ad27865a0c2a16b576ea55b1b4
-- Optional provider execution. Existing receipts, owner claims and global mutation guard survive.
alter table public.console_jobs add column execution_context jsonb check(execution_context is null or (jsonb_typeof(execution_context)='object' and octet_length(execution_context::text)<=2048));
alter table public.console_jobs add column last_polled_at timestamptz;
alter table public.console_jobs add column poll_token uuid;
alter table public.console_job_mutation_guard add column last_unresolved_id uuid references public.console_jobs(id) on delete restrict;

create function public.console_job_enqueue_provider(request_key uuid,input_fingerprint text,operation_name text,target_name text,source_sha text,execution_value jsonb,expires_at timestamptz,unresolved_id uuid default null)
returns jsonb language plpgsql security invoker set search_path='' set statement_timeout='5s' as $$
declare prior public.console_jobs; admission_result jsonb; previous_id uuid;
begin
  perform pg_advisory_xact_lock(763541,2);
  select * into prior from public.console_jobs j where j.request_key=console_job_enqueue_provider.request_key;
  if found then
    if prior.input_fingerprint<>input_fingerprint then return jsonb_build_object('outcome','key_conflict');end if;
    return jsonb_build_object('outcome','replay','job',to_jsonb(prior));
  end if;
  if expires_at is null or expires_at<=clock_timestamp() or expires_at>clock_timestamp()+interval '5 minutes'
    or source_sha is null or source_sha !~ '^[a-f0-9]{40}$' or operation_name='diagnostics'
    or execution_value is null or jsonb_typeof(execution_value)<>'object' or octet_length(execution_value::text)>2048
    or not(execution_value ?& array['provider','repository','branch','project','team','pendingDigest'])
    or (select count(*) from jsonb_object_keys(execution_value))<>6
    or execution_value->>'provider' not in ('github','vercel')
    or jsonb_typeof(execution_value->'repository')<>'string' or jsonb_typeof(execution_value->'branch')<>'string'
    then return jsonb_build_object('outcome','conflict');end if;
  if operation_name in ('migrations.apply','deploy.preview','deploy.production') then
    select last_unresolved_id into previous_id from public.console_job_mutation_guard where singleton;
    if previous_id is distinct from unresolved_id then return jsonb_build_object('outcome','conflict');end if;
  end if;
  admission_result:=public.console_job_enqueue(request_key,input_fingerprint,operation_name,target_name,source_sha);
  if admission_result->>'outcome'='enqueued' then
    update public.console_jobs set execution_context=execution_value where id=(admission_result->'job'->>'id')::uuid returning * into prior;
    return jsonb_build_object('outcome','enqueued','job',to_jsonb(prior));
  end if;
  return admission_result;
end;$$;

-- Reuse the reviewed envelope validation and terminal guard release. Running acceptance keeps
-- the dispatch token; provider identity/source cannot change under a stored execution context.
alter function public.console_job_publish(uuid,uuid,text,jsonb,text,text) rename to console_job_publish_v1;
-- PL/pgSQL's parameter qualification follows the function name, not its OID.
do $$ begin execute replace(pg_get_functiondef('public.console_job_publish_v1(uuid,uuid,text,jsonb,text,text)'::regprocedure),'console_job_publish.','console_job_publish_v1.');end $$;
create function public.console_job_publish(job_id uuid,claim_token uuid,completion_state text,result_value jsonb,provider_identity text default null,source_sha text default null)
returns jsonb language plpgsql security invoker set search_path='' set statement_timeout='5s' as $$
declare current_job public.console_jobs; result jsonb;
begin
  select * into current_job from public.console_jobs j where j.id=console_job_publish.job_id for update;
  if not found then return jsonb_build_object('outcome','missing');end if;
  if (current_job.provider_id is not null and provider_identity is not null and current_job.provider_id<>provider_identity)
    or (current_job.execution_context is not null and source_sha is not null and current_job.source_sha<>source_sha)
    or (completion_state='running' and provider_identity is null) then return jsonb_build_object('outcome','invalid');end if;
  result:=public.console_job_publish_v1(job_id,claim_token,case when completion_state='running' then 'uncertain' else completion_state end,result_value,provider_identity,source_sha);
  if result->>'outcome'='published' and completion_state='running' then
    update public.console_jobs set state='running' where id=job_id returning * into current_job;
    return jsonb_build_object('outcome','published','job',to_jsonb(current_job));
  end if;
  return result;
end;$$;

-- Explicit recovery also fences an admitted request whose caller died before claim. The same
-- row lock decides the race: a claim that already won keeps its original reconciliation token.
alter function public.console_job_mark_uncertain(uuid) rename to console_job_mark_uncertain_v1;
do $$ begin execute replace(pg_get_functiondef('public.console_job_mark_uncertain_v1(uuid)'::regprocedure),'console_job_mark_uncertain.','console_job_mark_uncertain_v1.');end $$;
create function public.console_job_mark_uncertain(job_id uuid) returns jsonb
language plpgsql security invoker set search_path='' set statement_timeout='5s' as $$
declare current_job public.console_jobs;
begin
  select * into current_job from public.console_jobs j where j.id=console_job_mark_uncertain.job_id for update;
  if found and current_job.state='queued' and current_job.execution_context is not null then
    update public.console_jobs set state='uncertain',updated_at=clock_timestamp(),check_count=1,
      summary='Unclaimed request explicitly fenced · unresolved acknowledgment required for another mutation',
      result=jsonb_build_object('summary','Unclaimed request explicitly fenced · unresolved acknowledgment required for another mutation',
        'checks',jsonb_build_array(jsonb_build_object('name','provider execution','state','unavailable',
          'detail','No dispatch claim won before explicit recovery. The immutable receipt and mutation guard remain; this is not provider cancellation.')))
      where id=current_job.id returning * into current_job;
    return jsonb_build_object('outcome','marked_uncertain','job',to_jsonb(current_job));
  end if;
  return public.console_job_mark_uncertain_v1(job_id);
end;$$;
revoke all on function public.console_job_mark_uncertain(uuid) from public,anon,authenticated;
grant execute on function public.console_job_mark_uncertain(uuid) to service_role;

create function public.console_job_reconcile_claim(job_id uuid) returns jsonb
language plpgsql security invoker set search_path='' set statement_timeout='5s' as $$
declare current_job public.console_jobs;
begin
  select * into current_job from public.console_jobs j where j.id=console_job_reconcile_claim.job_id for update;
  if not found or current_job.execution_context is null or (current_job.dispatch_token is null and current_job.provider_id is null) or current_job.state='queued'
    or current_job.last_polled_at>clock_timestamp()-interval '5 seconds' then return jsonb_build_object('outcome','not_claimed');end if;
  update public.console_jobs set last_polled_at=clock_timestamp(),poll_token=gen_random_uuid() where id=current_job.id returning * into current_job;
  return jsonb_build_object('outcome','claimed','job',to_jsonb(current_job),'token',current_job.dispatch_token,'pollToken',current_job.poll_token,'execution',current_job.execution_context);
end;$$;

create function public.console_job_reconcile_publish(job_id uuid,claim_token uuid,poll_owner uuid,completion_state text,result_value jsonb,provider_identity text default null)
returns jsonb language plpgsql security invoker set search_path='' set statement_timeout='5s' as $$
declare current_job public.console_jobs;
begin
  select * into current_job from public.console_jobs j where j.id=console_job_reconcile_publish.job_id for update;
  if not found then return jsonb_build_object('outcome','missing');end if;
  if poll_owner is null or current_job.poll_token is distinct from poll_owner then return jsonb_build_object('outcome','stale','job',to_jsonb(current_job));end if;
  return public.console_job_publish(job_id,claim_token,completion_state,result_value,provider_identity,null);
end;$$;

alter function public.console_job_acknowledge_uncertain(uuid) rename to console_job_acknowledge_uncertain_v1;
do $$ begin execute replace(pg_get_functiondef('public.console_job_acknowledge_uncertain_v1(uuid)'::regprocedure),'console_job_acknowledge_uncertain.','console_job_acknowledge_uncertain_v1.');end $$;
create function public.console_job_acknowledge_uncertain(job_id uuid) returns jsonb
language plpgsql security invoker set search_path='' set statement_timeout='5s' as $$
declare result jsonb;
begin
  perform pg_advisory_xact_lock(763541,2);
  result:=public.console_job_acknowledge_uncertain_v1(job_id);
  if result->>'outcome'='acknowledged' then update public.console_job_mutation_guard set last_unresolved_id=console_job_acknowledge_uncertain.job_id where singleton;end if;
  return result;
end;$$;

-- A bounded scalar envelope avoids gateway row caps. Reading never creates/upgrades a ledger.
create function public.console_job_migration_ledger() returns jsonb
language plpgsql stable security invoker set search_path='' set statement_timeout='5s' as $$
declare result jsonb; row_count integer; invalid boolean;
begin
  if to_regclass('public.schema_migrations') is null then return jsonb_build_object('state','absent','rows','[]'::jsonb);end if;
  if not exists(select 1 from information_schema.columns where table_schema='public' and table_name='schema_migrations' and column_name='checksum') then return jsonb_build_object('state','legacy','rows','[]'::jsonb);end if;
  execute 'select count(*),coalesce(bool_or(char_length(name)>255 or char_length(checksum)>64),false) from (select name,checksum from public.schema_migrations order by name limit 2001) s' into row_count,invalid;
  if row_count>2000 or invalid then raise exception 'migration ledger unavailable';end if;
  execute 'select coalesce(jsonb_agg(jsonb_build_object(''name'',name,''checksum'',checksum) order by name),''[]''::jsonb) from public.schema_migrations' into result;
  if octet_length(result::text)>524288 then raise exception 'migration ledger unavailable';end if;
  return jsonb_build_object('state','present','rows',result);
end;$$;

revoke all on function public.console_job_enqueue_provider(uuid,text,text,text,text,jsonb,timestamptz,uuid),public.console_job_publish(uuid,uuid,text,jsonb,text,text),public.console_job_reconcile_claim(uuid),public.console_job_reconcile_publish(uuid,uuid,uuid,text,jsonb,text),public.console_job_acknowledge_uncertain(uuid),public.console_job_migration_ledger() from public,anon,authenticated;
grant execute on function public.console_job_enqueue_provider(uuid,text,text,text,text,jsonb,timestamptz,uuid),public.console_job_publish(uuid,uuid,text,jsonb,text,text),public.console_job_reconcile_claim(uuid),public.console_job_reconcile_publish(uuid,uuid,uuid,text,jsonb,text),public.console_job_acknowledge_uncertain(uuid),public.console_job_migration_ledger() to service_role;

insert into public.schema_migrations(name,checksum) values('20260908205956_console_job_providers.sql','4cd364f8666b8fc04500ad360100b2c4107cc2ad27865a0c2a16b576ea55b1b4');

-- IMMUTABLE FILE 20260908221155_console_job_provider_fences.sql SHA256 f6538e34f2ef11e2f48db66fe7ec5a7f87dd2727273e67578385ce1fddd354fe
-- Forward repair: retain immutable intent expiry and protect an active read-only observer.
-- Unknown legacy queued provider expiry is deliberately not backfilled from a guessed time.
alter table public.console_jobs add column intent_expires_at timestamptz;
alter table public.console_jobs add column poll_expires_at timestamptz;

create or replace function public.console_job_enqueue_provider(request_key uuid,input_fingerprint text,operation_name text,target_name text,source_sha text,execution_value jsonb,expires_at timestamptz,unresolved_id uuid default null)
returns jsonb language plpgsql security invoker set search_path='' set statement_timeout='5s' as $$
declare prior public.console_jobs; admission_result jsonb; previous_id uuid;
begin
  perform pg_advisory_xact_lock(763541,2);
  select * into prior from public.console_jobs j where j.request_key=console_job_enqueue_provider.request_key;
  if found then
    if prior.input_fingerprint<>input_fingerprint then return jsonb_build_object('outcome','key_conflict');end if;
    return jsonb_build_object('outcome','replay','job',to_jsonb(prior));
  end if;
  if expires_at is null or expires_at<=clock_timestamp() or expires_at>clock_timestamp()+interval '5 minutes'
    or source_sha is null or source_sha !~ '^[a-f0-9]{40}$' or operation_name='diagnostics'
    or execution_value is null or jsonb_typeof(execution_value)<>'object' or octet_length(execution_value::text)>2048
    or not(execution_value ?& array['provider','repository','branch','project','team','pendingDigest'])
    or (select count(*) from jsonb_object_keys(execution_value))<>6
    or execution_value->>'provider' not in ('github','vercel')
    or jsonb_typeof(execution_value->'repository')<>'string' or jsonb_typeof(execution_value->'branch')<>'string'
    then return jsonb_build_object('outcome','conflict');end if;
  if operation_name in ('migrations.apply','deploy.preview','deploy.production') then
    select last_unresolved_id into previous_id from public.console_job_mutation_guard where singleton;
    if previous_id is distinct from unresolved_id then return jsonb_build_object('outcome','conflict');end if;
  end if;
  admission_result:=public.console_job_enqueue(request_key,input_fingerprint,operation_name,target_name,source_sha);
  if admission_result->>'outcome'='enqueued' then
    update public.console_jobs set execution_context=execution_value,intent_expires_at=expires_at
      where id=(admission_result->'job'->>'id')::uuid returning * into prior;
    return jsonb_build_object('outcome','enqueued','job',to_jsonb(prior));
  end if;
  return admission_result;
end;$$;

-- Both public claim signatures enforce the saved expiry after acquiring the row lock.
create or replace function public.console_job_claim(job_id uuid) returns jsonb
language plpgsql security invoker set search_path='' set statement_timeout='5s' as $$
declare current_job public.console_jobs;
begin
  select * into current_job from public.console_jobs j where j.id=console_job_claim.job_id for update;
  if not found then return jsonb_build_object('outcome','missing');end if;
  if current_job.state<>'queued' or (current_job.execution_context is not null and
    (current_job.intent_expires_at is null or current_job.intent_expires_at<=clock_timestamp())) then
    return jsonb_build_object('outcome','not_claimed','job',to_jsonb(current_job));
  end if;
  update public.console_jobs set state='running',dispatch_token=gen_random_uuid(),updated_at=clock_timestamp()
    where id=current_job.id returning * into current_job;
  return jsonb_build_object('outcome','claimed','token',current_job.dispatch_token,'job',to_jsonb(current_job));
end;$$;

create or replace function public.console_job_claim(job_id uuid,owner_token uuid) returns jsonb
language plpgsql security invoker set search_path='' set statement_timeout='5s' as $$
declare current_job public.console_jobs;
begin
  if owner_token is null then return jsonb_build_object('outcome','invalid');end if;
  select * into current_job from public.console_jobs j where j.id=console_job_claim.job_id for update;
  if not found then return jsonb_build_object('outcome','missing');end if;
  if current_job.state='queued' then
    if current_job.execution_context is not null and (current_job.intent_expires_at is null or current_job.intent_expires_at<=clock_timestamp()) then
      return jsonb_build_object('outcome','not_claimed','job',to_jsonb(current_job));
    end if;
    update public.console_jobs set state='running',dispatch_token=gen_random_uuid(),claim_owner=owner_token,updated_at=clock_timestamp()
      where id=current_job.id returning * into current_job;
    return jsonb_build_object('outcome','claimed','token',current_job.dispatch_token,'job',to_jsonb(current_job));
  end if;
  -- A claim that already won may recover its original token, even after intent expiry.
  if current_job.state='running' and current_job.claim_owner=owner_token then
    return jsonb_build_object('outcome','claimed','token',current_job.dispatch_token,'job',to_jsonb(current_job));
  end if;
  return jsonb_build_object('outcome','not_claimed','job',to_jsonb(current_job));
end;$$;

create or replace function public.console_job_reconcile_claim(job_id uuid) returns jsonb
language plpgsql security invoker set search_path='' set statement_timeout='5s' as $$
declare current_job public.console_jobs;
begin
  select * into current_job from public.console_jobs j where j.id=console_job_reconcile_claim.job_id for update;
  if not found or current_job.execution_context is null or (current_job.dispatch_token is null and current_job.provider_id is null) or current_job.state='queued'
    or current_job.last_polled_at>clock_timestamp()-interval '5 seconds'
    or (current_job.poll_token is not null and current_job.poll_expires_at>clock_timestamp()) then
    return jsonb_build_object('outcome','not_claimed');
  end if;
  update public.console_jobs set last_polled_at=clock_timestamp(),poll_token=gen_random_uuid(),poll_expires_at=clock_timestamp()+interval '100 seconds'
    where id=current_job.id returning * into current_job;
  return jsonb_build_object('outcome','claimed','job',to_jsonb(current_job),'token',current_job.dispatch_token,'pollToken',current_job.poll_token,'execution',current_job.execution_context);
end;$$;

create or replace function public.console_job_reconcile_publish(job_id uuid,claim_token uuid,poll_owner uuid,completion_state text,result_value jsonb,provider_identity text default null)
returns jsonb language plpgsql security invoker set search_path='' set statement_timeout='5s' as $$
declare current_job public.console_jobs;
begin
  select * into current_job from public.console_jobs j where j.id=console_job_reconcile_publish.job_id for update;
  if not found then return jsonb_build_object('outcome','missing');end if;
  if poll_owner is null or current_job.poll_token is distinct from poll_owner or current_job.poll_expires_at is null or current_job.poll_expires_at<=clock_timestamp() then
    return jsonb_build_object('outcome','stale','job',to_jsonb(current_job));
  end if;
  return public.console_job_publish(job_id,claim_token,completion_state,result_value,provider_identity,null);
end;$$;

create function public.console_job_reconcile_release(job_id uuid,poll_owner uuid) returns jsonb
language plpgsql security invoker set search_path='' set statement_timeout='5s' as $$
begin
  update public.console_jobs set poll_token=null,poll_expires_at=null
    where id=console_job_reconcile_release.job_id and poll_token=poll_owner;
  return jsonb_build_object('released',found);
end;$$;

revoke all on function public.console_job_enqueue_provider(uuid,text,text,text,text,jsonb,timestamptz,uuid),public.console_job_claim(uuid),public.console_job_claim(uuid,uuid),public.console_job_reconcile_claim(uuid),public.console_job_reconcile_publish(uuid,uuid,uuid,text,jsonb,text),public.console_job_reconcile_release(uuid,uuid) from public,anon,authenticated;
grant execute on function public.console_job_enqueue_provider(uuid,text,text,text,text,jsonb,timestamptz,uuid),public.console_job_claim(uuid),public.console_job_claim(uuid,uuid),public.console_job_reconcile_claim(uuid),public.console_job_reconcile_publish(uuid,uuid,uuid,text,jsonb,text),public.console_job_reconcile_release(uuid,uuid) to service_role;

insert into public.schema_migrations(name,checksum) values('20260908221155_console_job_provider_fences.sql','f6538e34f2ef11e2f48db66fe7ec5a7f87dd2727273e67578385ce1fddd354fe');

-- IMMUTABLE FILE 20260908225927_console_configuration.sql SHA256 88a94251889b65e6fb9025a060c5e0ec16e634d25e3d91e7c738b0dec4d400e1
-- Value-free, service-only configuration admission ledger.
-- Provider values and unkeyed hashes never enter this schema.

create table public.console_configuration_requests (
  request_key uuid primary key,
  input_fingerprint text not null check (input_fingerprint ~ '^[0-9a-f]{64}$'),
  capability text not null check (capability in (
    'notes', 'reader-anthropic', 'reader-openai', 'reader-google', 'mirror', 'cache', 'alerts'
  )),
  target text not null check (
    length(target) <= 300
    and target ~ '^vercel:prj_[A-Za-z0-9]{1,100}:(personal|team_[A-Za-z0-9]{1,100}):(production|preview)$'
  ),
  starting_revision bigint not null check (starting_revision >= 0),
  completed_revision bigint check (completed_revision >= 1),
  acknowledged_revision bigint check (acknowledged_revision >= 1),
  state text not null check (state in ('running', 'finished', 'uncertain')),
  claim_token uuid not null,
  result jsonb,
  acknowledged_at timestamptz,
  requested_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  check ((state = 'finished') = (completed_revision is not null)),
  check ((acknowledged_at is null) = (acknowledged_revision is null)),
  check (octet_length(coalesce(result::text, 'null')) <= 4096)
);

create table public.console_configuration_state (
  capability text not null check (capability in (
    'notes', 'reader-anthropic', 'reader-openai', 'reader-google', 'mirror', 'cache', 'alerts'
  )),
  target text not null check (
    length(target) <= 300
    and target ~ '^vercel:prj_[A-Za-z0-9]{1,100}:(personal|team_[A-Za-z0-9]{1,100}):(production|preview)$'
  ),
  revision bigint not null default 0 check (revision >= 0),
  current_request uuid not null references public.console_configuration_requests(request_key) on delete restrict,
  updated_at timestamptz not null default clock_timestamp(),
  primary key (capability, target)
);

create index console_configuration_requests_retention_idx
  on public.console_configuration_requests (updated_at)
  where state = 'finished' or (state = 'uncertain' and acknowledged_at is not null);

alter table public.console_configuration_requests enable row level security;
alter table public.console_configuration_state enable row level security;
revoke all on table public.console_configuration_requests from public, anon, authenticated, service_role;
revoke all on table public.console_configuration_state from public, anon, authenticated, service_role;
grant select, insert, update, delete on table public.console_configuration_requests to service_role;
grant select, insert, update, delete on table public.console_configuration_state to service_role;
create policy console_configuration_requests_service_only on public.console_configuration_requests
  for all to service_role using (true) with check (true);
create policy console_configuration_state_service_only on public.console_configuration_state
  for all to service_role using (true) with check (true);

create function public.console_configuration_record(
  request_row public.console_configuration_requests,
  visible_revision bigint
)
returns jsonb
language sql
stable
security invoker
set search_path = ''
set statement_timeout = '5s'
as $$
  select jsonb_build_object(
    'capability', request_row.capability,
    'target', request_row.target,
    'revision', visible_revision,
    'status', request_row.state,
    'request_key', request_row.request_key,
    'result', request_row.result,
    'acknowledged', request_row.acknowledged_at is not null,
    'updated_at', to_char(request_row.updated_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
  )
$$;

create function public.console_configuration_result_valid(
  capability_name text,
  completion_state text,
  result_value jsonb
)
returns boolean
language plpgsql
immutable
security invoker
set search_path = ''
set statement_timeout = '5s'
as $$
declare
  allowed text[];
  accepted text[];
  failed_names text[];
  result_keys text[];
begin
  allowed := case capability_name
    when 'notes' then array['BRAIN_REPO', 'GITHUB_TOKEN']
    when 'reader-anthropic' then array['ANTHROPIC_API_KEY']
    when 'reader-openai' then array['OPENAI_API_KEY']
    when 'reader-google' then array['GEMINI_API_KEY']
    when 'mirror' then array['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY']
    when 'cache' then array['KV_REST_API_URL', 'KV_REST_API_TOKEN']
    when 'alerts' then array['RESEND_API_KEY', 'OPS_ALERT_TO', 'OPS_ALERT_FROM']
    else null
  end;
  if allowed is null or completion_state is null or completion_state not in ('finished', 'uncertain')
    or result_value is null or jsonb_typeof(result_value) is distinct from 'object'
    or octet_length(result_value::text) > 4096 then
    return false;
  end if;
  select array_agg(key order by key) into result_keys from jsonb_object_keys(result_value) key;
  if result_keys is distinct from array['accepted', 'failed', 'state'] then return false; end if;
  if jsonb_typeof(result_value->'accepted') is distinct from 'array' or jsonb_array_length(result_value->'accepted') > 8
    or jsonb_typeof(result_value->'failed') is distinct from 'array' or jsonb_array_length(result_value->'failed') > 8 then
    return false;
  end if;
  if exists (
    select 1 from jsonb_array_elements(result_value->'accepted') item
    where jsonb_typeof(item) is distinct from 'string'
  ) or exists (
    select 1 from jsonb_array_elements(result_value->'failed') item
    where jsonb_typeof(item) is distinct from 'object'
      or (select array_agg(key order by key) from jsonb_object_keys(item) key) is distinct from array['code', 'name']
      or jsonb_typeof(item->'name') is distinct from 'string'
      or jsonb_typeof(item->'code') is distinct from 'string'
      or item->>'code' not in ('provider_rejected', 'completion_unconfirmed')
      or not ((item->>'name') = any(allowed))
  ) then return false; end if;
  select coalesce(array_agg(value order by value), array[]::text[]) into accepted
    from jsonb_array_elements_text(result_value->'accepted') value;
  select coalesce(array_agg(item->>'name' order by item->>'name'), array[]::text[]) into failed_names
    from jsonb_array_elements(result_value->'failed') item;
  if exists (select 1 from unnest(accepted) name where not (name = any(allowed)))
    or cardinality(accepted) + cardinality(failed_names) <> cardinality(allowed)
    or cardinality(array(select distinct name from unnest(accepted || failed_names) name)) <> cardinality(allowed)
    or exists (select 1 from unnest(allowed) name where not (name = any(accepted || failed_names))) then
    return false;
  end if;
  if completion_state = 'uncertain' then
    return coalesce(result_value->>'state' = 'uncertain'
      and cardinality(accepted) = 0
      and not exists (
        select 1 from jsonb_array_elements(result_value->'failed') item
        where item->>'code' <> 'completion_unconfirmed'
      ), false);
  end if;
  return coalesce(result_value->>'state' in ('saved-pending-deployment', 'partial')
    and ((result_value->>'state' = 'saved-pending-deployment') = (cardinality(failed_names) = 0))
    and not exists (
      select 1 from jsonb_array_elements(result_value->'failed') item
      where item->>'code' <> 'provider_rejected'
    ), false);
exception when others then
  return false;
end
$$;

alter table public.console_configuration_requests
  add constraint console_configuration_requests_result_shape check (
    (state = 'running' and result is null and acknowledged_at is null)
    or (state = 'finished' and result is not null and acknowledged_at is null
      and public.console_configuration_result_valid(capability, 'finished', result))
    or (state = 'uncertain' and (result is null
      or public.console_configuration_result_valid(capability, 'uncertain', result)))
  );

create function public.console_configuration_admit(
  request_key uuid,
  input_fingerprint text,
  capability_name text,
  target_name text,
  expected_revision bigint
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
set statement_timeout = '5s'
as $$
#variable_conflict use_variable
declare
  v_request_key uuid := request_key;
  v_fingerprint text := input_fingerprint;
  v_capability text := capability_name;
  v_target text := target_name;
  v_expected bigint := expected_revision;
  existing public.console_configuration_requests;
  state_row public.console_configuration_state;
  active_row public.console_configuration_requests;
  inserted public.console_configuration_requests;
  token uuid;
  key_millis bigint;
  key_time timestamptz;
begin
  perform pg_catalog.pg_advisory_xact_lock(785423771);

  select * into existing from public.console_configuration_requests r where r.request_key = v_request_key;
  if found then
    if existing.input_fingerprint is distinct from v_fingerprint
      or existing.capability is distinct from v_capability
      or existing.target is distinct from v_target
      or existing.starting_revision is distinct from v_expected then
      return jsonb_build_object('outcome', 'key_conflict');
    end if;
    return jsonb_build_object(
      'outcome', 'replay',
      'record', public.console_configuration_record(existing, coalesce(existing.completed_revision, existing.acknowledged_revision, existing.starting_revision))
    );
  end if;

  if v_request_key is null or v_fingerprint is null or v_fingerprint !~ '^[0-9a-f]{64}$'
    or v_capability is null or v_capability not in ('notes', 'reader-anthropic', 'reader-openai', 'reader-google', 'mirror', 'cache', 'alerts')
    or v_target is null
    or length(v_target) > 300
    or v_target !~ '^vercel:prj_[A-Za-z0-9]{1,100}:(personal|team_[A-Za-z0-9]{1,100}):(production|preview)$'
    or v_expected is null or v_expected < 0
    or substring(v_request_key::text, 15, 1) <> '7'
    or substring(v_request_key::text, 20, 1) not in ('8', '9', 'a', 'b') then
    return jsonb_build_object('outcome', 'invalid');
  end if;

  key_millis := (('x' || substring(v_request_key::text, 1, 8) || substring(v_request_key::text, 10, 4))::bit(48)::bigint);
  key_time := pg_catalog.to_timestamp(key_millis::double precision / 1000.0);
  if key_time < pg_catalog.clock_timestamp() - interval '5 minutes'
    or key_time > pg_catalog.clock_timestamp() + interval '1 minute' then
    return jsonb_build_object('outcome', 'expired');
  end if;

  delete from public.console_configuration_requests r
   where r.updated_at < pg_catalog.clock_timestamp() - interval '30 days'
     and (r.state = 'finished' or (r.state = 'uncertain' and r.acknowledged_at is not null))
     and not exists (
       select 1 from public.console_configuration_state s where s.current_request = r.request_key
     );
  if (select count(*) from public.console_configuration_requests) >= 2000 then
    return jsonb_build_object('outcome', 'capacity');
  end if;

  select * into state_row from public.console_configuration_state s
    where s.capability = v_capability and s.target = v_target for update;
  if found then
    if state_row.revision <> v_expected then return jsonb_build_object('outcome', 'stale'); end if;
    select * into active_row from public.console_configuration_requests r where r.request_key = state_row.current_request;
    if active_row.state = 'running' or (active_row.state = 'uncertain' and active_row.acknowledged_at is null) then
      return jsonb_build_object('outcome', 'active');
    end if;
  elsif v_expected <> 0 then
    return jsonb_build_object('outcome', 'stale');
  end if;

  token := gen_random_uuid();
  insert into public.console_configuration_requests(
    request_key, input_fingerprint, capability, target, starting_revision, state, claim_token
  ) values (v_request_key, v_fingerprint, v_capability, v_target, v_expected, 'running', token)
  returning * into inserted;
  insert into public.console_configuration_state(capability, target, revision, current_request)
    values(v_capability, v_target, v_expected, v_request_key)
    on conflict(capability, target) do update
      set current_request = excluded.current_request, updated_at = pg_catalog.clock_timestamp();
  return jsonb_build_object(
    'outcome', 'admitted',
    'record', public.console_configuration_record(inserted, v_expected),
    'claimToken', token
  );
end
$$;

create function public.console_configuration_publish(
  capability_name text,
  target_name text,
  request_key uuid,
  claim_token uuid,
  completion_state text,
  result_value jsonb
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
set statement_timeout = '5s'
as $$
#variable_conflict use_variable
declare
  v_capability text := capability_name;
  v_target text := target_name;
  v_key uuid := request_key;
  v_token uuid := claim_token;
  v_completion text := completion_state;
  v_result jsonb := result_value;
  receipt public.console_configuration_requests;
  state_row public.console_configuration_state;
begin
  select * into receipt from public.console_configuration_requests r where r.request_key = v_key for update;
  if not found or v_capability is null or v_target is null or v_key is null or v_token is null
    or v_completion is null or v_result is null then
    return jsonb_build_object('outcome', 'stale', 'record', null);
  end if;
  select * into state_row from public.console_configuration_state s
    where s.capability = receipt.capability and s.target = receipt.target for update;
  if receipt.capability is distinct from v_capability or receipt.target is distinct from v_target
    or receipt.claim_token is distinct from v_token or receipt.state is distinct from 'running'
    or state_row.current_request is distinct from receipt.request_key then
    return jsonb_build_object(
      'outcome', 'stale',
      'record', public.console_configuration_record(receipt, coalesce(receipt.completed_revision, receipt.acknowledged_revision, receipt.starting_revision))
    );
  end if;
  if not public.console_configuration_result_valid(v_capability, v_completion, v_result) then
    return jsonb_build_object(
      'outcome', 'invalid',
      'record', public.console_configuration_record(receipt, receipt.starting_revision)
    );
  end if;
  if v_completion = 'finished' then
    update public.console_configuration_state s
      set revision = s.revision + 1, updated_at = pg_catalog.clock_timestamp()
      where s.capability = v_capability and s.target = v_target
      returning * into state_row;
    update public.console_configuration_requests r
      set state = 'finished', completed_revision = state_row.revision, result = v_result, updated_at = pg_catalog.clock_timestamp()
      where r.request_key = v_key returning * into receipt;
  else
    update public.console_configuration_requests r
      set state = 'uncertain', result = v_result, updated_at = pg_catalog.clock_timestamp()
      where r.request_key = v_key returning * into receipt;
  end if;
  return jsonb_build_object(
    'outcome', 'published',
    'record', public.console_configuration_record(receipt, coalesce(receipt.completed_revision, receipt.acknowledged_revision, receipt.starting_revision))
  );
end
$$;

create function public.console_configuration_acknowledge(
  capability_name text,
  target_name text,
  request_key uuid
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
set statement_timeout = '5s'
as $$
#variable_conflict use_variable
declare
  v_capability text := capability_name;
  v_target text := target_name;
  v_key uuid := request_key;
  receipt public.console_configuration_requests;
  state_row public.console_configuration_state;
begin
  select * into receipt from public.console_configuration_requests r where r.request_key = v_key for update;
  if not found or v_capability is null or v_target is null or v_key is null then
    return jsonb_build_object('outcome', 'not_unresolved');
  end if;
  select * into state_row from public.console_configuration_state s
    where s.capability = receipt.capability and s.target = receipt.target for update;
  if receipt.capability is distinct from v_capability or receipt.target is distinct from v_target
    or state_row.current_request is distinct from receipt.request_key
    or receipt.state not in ('running', 'uncertain') or receipt.acknowledged_at is not null then
    return jsonb_build_object('outcome', 'not_unresolved');
  end if;
  update public.console_configuration_state s
    set revision = s.revision + 1, updated_at = pg_catalog.clock_timestamp()
    where s.capability = v_capability and s.target = v_target returning * into state_row;
  update public.console_configuration_requests r
    set state = 'uncertain', acknowledged_at = pg_catalog.clock_timestamp(),
      acknowledged_revision = state_row.revision, updated_at = pg_catalog.clock_timestamp()
    where r.request_key = v_key returning * into receipt;
  return jsonb_build_object(
    'outcome', 'acknowledged',
    'record', public.console_configuration_record(receipt, state_row.revision)
  );
end
$$;

create function public.console_configuration_get(
  request_key uuid default null,
  capability_name text default null,
  target_name text default null
)
returns setof jsonb
language sql
stable
security invoker
set search_path = ''
set statement_timeout = '5s'
as $$
  select rows.value from (
    select public.console_configuration_record(r, coalesce(r.completed_revision, r.acknowledged_revision, r.starting_revision)) as value
      from public.console_configuration_requests r
     where request_key is not null and r.request_key = request_key
    union all
    select public.console_configuration_record(r, s.revision) as value
      from public.console_configuration_state s
      join public.console_configuration_requests r on r.request_key = s.current_request
     where request_key is null
       and (capability_name is null or s.capability = capability_name)
       and (target_name is null or s.target = target_name)
  ) rows
  order by rows.value->>'updated_at' desc
  limit 32
$$;

revoke all on function public.console_configuration_record(public.console_configuration_requests, bigint) from public, anon, authenticated;
revoke all on function public.console_configuration_result_valid(text, text, jsonb) from public, anon, authenticated;
revoke all on function public.console_configuration_admit(uuid, text, text, text, bigint) from public, anon, authenticated;
revoke all on function public.console_configuration_publish(text, text, uuid, uuid, text, jsonb) from public, anon, authenticated;
revoke all on function public.console_configuration_acknowledge(text, text, uuid) from public, anon, authenticated;
revoke all on function public.console_configuration_get(uuid, text, text) from public, anon, authenticated;
grant execute on function public.console_configuration_admit(uuid, text, text, text, bigint) to service_role;
grant execute on function public.console_configuration_publish(text, text, uuid, uuid, text, jsonb) to service_role;
grant execute on function public.console_configuration_acknowledge(text, text, uuid) to service_role;
grant execute on function public.console_configuration_get(uuid, text, text) to service_role;
grant execute on function public.console_configuration_record(public.console_configuration_requests, bigint) to service_role;
grant execute on function public.console_configuration_result_valid(text, text, jsonb) to service_role;

insert into public.schema_migrations(name,checksum) values('20260908225927_console_configuration.sql','88a94251889b65e6fb9025a060c5e0ec16e634d25e3d91e7c738b0dec4d400e1');

-- IMMUTABLE FILE 20260909001059_console_configuration_exact_reads.sql SHA256 b6a1d9e2179e0fae90e33cb0afb295854add296b8a05ffce7e1c3a7f73a92fe9
-- Correct the read function's parameter/column ambiguity without changing its public signature.
-- The historical migration may already be applied, so this is intentionally forward-only.

create or replace function public.console_configuration_get(
  request_key uuid default null,
  capability_name text default null,
  target_name text default null
)
returns setof jsonb
language sql
stable
security invoker
set search_path = ''
set statement_timeout = '5s'
as $$
  select rows.value from (
    select public.console_configuration_record(r, coalesce(r.completed_revision, r.acknowledged_revision, r.starting_revision)) as value,
      r.updated_at as sort_at
      from public.console_configuration_requests r
     where $1 is not null and r.request_key = $1
    union all
    select public.console_configuration_record(r, s.revision) as value,
      r.updated_at as sort_at
      from public.console_configuration_state s
      join public.console_configuration_requests r on r.request_key = s.current_request
     where $1 is null
       and ($2 is null or s.capability = $2)
       and ($3 is null or s.target = $3)
  ) rows
  order by rows.sort_at desc
  limit 32
$$;

revoke all on function public.console_configuration_get(uuid, text, text) from public, anon, authenticated;
grant execute on function public.console_configuration_get(uuid, text, text) to service_role;

insert into public.schema_migrations(name,checksum) values('20260909001059_console_configuration_exact_reads.sql','b6a1d9e2179e0fae90e33cb0afb295854add296b8a05ffce7e1c3a7f73a92fe9');

-- IMMUTABLE FILE 20260909032009_live_corpus_snapshot.sql SHA256 0ace8f6a0b14e7558dfe73e30a43a970665d723f275cd562422813737f55f80d
-- Forward repair: match corpus.ts isLive BEFORE measurement and aggregation. The native
-- parity test enumerates every application exclusion; excluded customer rows remain untouched.
-- One coherent, bounded corpus read for PostgREST. A STABLE function uses the snapshot of its
-- calling query for every SELECT it executes, so head and rows cannot straddle a concurrent
-- sync_apply transaction. The per-row JSON is measured before jsonb_agg is allowed to allocate
-- the array. Row bytes, array separators and the complete serialized envelope are counted exactly
-- inside the same 64 MiB ceiling used by the decompressed archive reader.
create or replace function public.corpus_snapshot()
returns jsonb
language plpgsql
stable
security invoker
set search_path = public, pg_catalog
as $$
declare
  snapshot_head text;
  row_count bigint;
  row_bytes bigint;
  payload_bytes bigint;
  max_payload_bytes constant bigint := 67108864;
begin
  select s.head_sha
    into snapshot_head
    from public.sync_state as s
    where s.id is true;

  select pg_catalog.count(*),
         coalesce(
           pg_catalog.sum(pg_catalog.octet_length(encoded.row_json::text)),
           0
         )
    into row_count, row_bytes
    from (
      select pg_catalog.jsonb_build_object(
               'path', n.path,
               'content', n.content,
               'commit_sha', n.commit_sha
             ) as row_json
        from public.notes as n
          where n.path ~* '\.md$'
            and not (n.path ^@ any(array['.git/','.claude/','tools/','archive/','brain-v2/','.github/']))
            and regexp_replace(n.path, '^.*/', '') <> all(array['brain-index.md','INDEX.md','README.md'])
    ) as encoded;

  -- jsonb text renders array elements with a comma-and-space separator. The empty envelope
  -- already contributes both brackets, so replacing its empty array contents requires exactly
  -- the serialized row bytes plus two bytes between each adjacent pair.
  payload_bytes :=
    pg_catalog.octet_length(
      pg_catalog.jsonb_build_object(
        'head', snapshot_head,
        'rows', '[]'::jsonb
      )::text
    )::bigint
    + row_bytes
    + 2 * greatest(row_count - 1, 0);

  if payload_bytes > max_payload_bytes then
    raise exception using
      errcode = '54000',
      message = 'corpus snapshot exceeds 64 MiB safety limit';
  end if;

  return (
    select pg_catalog.jsonb_build_object(
             'head', snapshot_head,
             'rows', coalesce(
               pg_catalog.jsonb_agg(encoded.row_json order by encoded.path),
               '[]'::jsonb
             )
           )
      from (
        select n.path,
               pg_catalog.jsonb_build_object(
                 'path', n.path,
                 'content', n.content,
                 'commit_sha', n.commit_sha
               ) as row_json
          from public.notes as n
          where n.path ~* '\.md$'
            and not (n.path ^@ any(array['.git/','.claude/','tools/','archive/','brain-v2/','.github/']))
            and regexp_replace(n.path, '^.*/', '') <> all(array['brain-index.md','INDEX.md','README.md'])
      ) as encoded
  );
end
$$;

revoke execute on function public.corpus_snapshot() from public, anon, authenticated;
grant execute on function public.corpus_snapshot() to service_role;

insert into public.schema_migrations(name,checksum) values('20260909032009_live_corpus_snapshot.sql','0ace8f6a0b14e7558dfe73e30a43a970665d723f275cd562422813737f55f80d');

-- IMMUTABLE FILE 20260909032252_structural_edge_identity.sql SHA256 19d157f9466c1cbe870ee41974e74923dc0740ce095075045377fe425e016f8e
-- Algorithm identity is independent of corpus SHA and coaccess usage policy. Existing rows
-- deliberately remain unstamped and stale until the bounded current deriver publishes them.
alter table public.edges_state add column built_structure text;
create or replace function public.edges_freshness(new_head text) returns jsonb
language sql stable security invoker set search_path = '' set statement_timeout = '2s' as $$
  with input as (select public.edges_usage_identity() identity)
  select i.identity || jsonb_build_object('structure','structural-v2-unicode-bm25-1.5-1','builtStructure',(select built_structure from public.edges_state where id is true),'builtAt',(select built_at from public.edges_state where id is true),
    'structural',not exists(select 1 from public.edges_state s where s.id is true and s.built_head=new_head and s.built_structure='structural-v2-unicode-bm25-1.5-1'),'state',case
    when (select head_sha from public.sync_state where id is true) is distinct from new_head then 'stale-head'
    when exists(select 1 from public.edges_state s where s.id is true and s.built_head=new_head and s.built_structure='structural-v2-unicode-bm25-1.5-1'
      and s.built_watermark=i.identity->>'watermark' and s.built_cutoff=(i.identity->>'cutoff')::timestamptz
      and s.built_policy=i.identity->>'policy') then 'current' else 'stale' end)
  from input i
$$;

-- Nonblocking publication locks bound contention. A 100001-row probe refuses overload rather
-- than training on a silently truncated history. HTTP timeouts are NOT a rollback guarantee.
create function public.edges_rebuild_v3(new_head text, expected_watermark text,
  expected_cutoff timestamptz, expected_structure text, edges jsonb, force boolean default false) returns text
language plpgsql security invoker set search_path = '' set statement_timeout = '5s' as $$
declare identity jsonb; samples jsonb; n bigint; mirror_head text;
begin
  if expected_structure is distinct from 'structural-v2-unicode-bm25-1.5-1' then return 'stale-input'; end if;
  if not pg_try_advisory_xact_lock(18462026,2) then return 'busy'; end if;
  lock table public.edges_usage_hours in share mode nowait;
  select head_sha into mirror_head from public.sync_state where id is true for share nowait;
  if mirror_head is distinct from new_head then return 'stale-head'; end if;
  identity := public.edges_usage_identity();
  if expected_watermark is distinct from identity->>'watermark'
    or expected_cutoff is distinct from (identity->>'cutoff')::timestamptz then return 'stale-input'; end if;
  if not force and public.edges_freshness(new_head)->>'state'='current' then return 'current'; end if;
  with bounded as materialized (
    select at,path from public.note_access where mode not in ('boot', 'handoff', 'maintenance')
      and at >= expected_cutoff-interval '2160 hours' and at < expected_cutoff limit 100001
  ) select count(*),jsonb_agg(jsonb_build_object('w',date_trunc('hour',at,'UTC'),'path',path)) into n,samples from bounded;
  if n > 100000 then return 'capacity'; end if;
  if edges is null and not exists(select 1 from public.edges_state where id is true and built_head=new_head and built_structure=expected_structure) then return 'stale-input'; end if;
  if edges is not null and (jsonb_typeof(edges) is distinct from 'array' or jsonb_array_length(edges)>200000 or octet_length(edges::text)>16*1024*1024) then return 'capacity'; end if;
  if exists(select 1 from jsonb_to_recordset(edges) x(kind text) where x.kind='coaccess') then
    raise exception 'coaccess must be derived from eligible history';
  end if;
  delete from public.note_edges where edges is not null or kind='coaccess';
  insert into public.note_edges(src,dst,kind,weight,evidence,built_head)
    select x.src,x.dst,x.kind,x.weight,x.evidence,new_head from jsonb_to_recordset(edges)
      x(src text,dst text,kind text,weight real,evidence text);
  with reads as (
    select distinct x.w,x.path from jsonb_to_recordset(coalesce(samples,'[]'::jsonb)) x(w timestamptz,path text)
  ), focused as (select w from reads group by w having count(*)<=6), eligible as (
    select r.* from reads r join focused f using(w)
  ) insert into public.note_edges(src,dst,kind,weight,evidence,built_head)
    select a.path,b.path,'coaccess',count(*)::real,
      'co-read in ' || count(*) || ' shared UTC hours; coaccess-v2: last 90 days, completed hours, fanout <=6, >=2 windows; boot/handoff/maintenance excluded',new_head
    from eligible a join eligible b on a.w=b.w and a.path collate "C" < b.path collate "C"
    where exists(select 1 from public.notes n where n.path=a.path)
      and exists(select 1 from public.notes n where n.path=b.path)
    group by a.path,b.path having count(*)>=2;
  insert into public.edges_state(id,built_head,built_at,built_watermark,built_cutoff,built_policy,built_structure)
    values(true,new_head,clock_timestamp(),expected_watermark,expected_cutoff,identity->>'policy',expected_structure)
    on conflict(id) do update set built_head=excluded.built_head,built_at=excluded.built_at,
      built_watermark=excluded.built_watermark,built_cutoff=excluded.built_cutoff,built_policy=excluded.built_policy,built_structure=excluded.built_structure;
  return 'rebuilt';
exception when lock_not_available then return 'busy';
end $$;


-- Old deployments cannot falsely certify their old lexical output as the new algorithm.
create or replace function public.edges_rebuild_v2(new_head text,expected_watermark text,
 expected_cutoff timestamptz,edges jsonb,force boolean default false) returns text
language sql security invoker set search_path='' as $$ select 'stale-input'::text $$;
revoke execute on function public.edges_rebuild_v3(text,text,timestamptz,text,jsonb,boolean) from public,anon,authenticated;
grant execute on function public.edges_rebuild_v3(text,text,timestamptz,text,jsonb,boolean) to service_role;

insert into public.schema_migrations(name,checksum) values('20260909032252_structural_edge_identity.sql','19d157f9466c1cbe870ee41974e74923dc0740ce095075045377fe425e016f8e');

-- IMMUTABLE FILE 20260909032839_neutral_console_installation.sql SHA256 1fba918bc766ba8a827c586a3d4506e5967f0f5195b921683e9155fb49c456ef
-- Keep every actor installation-neutral, including new console actions.
alter table public.ops_events drop constraint ops_events_actor_check;
alter table public.ops_events add constraint ops_events_actor_check
  check(actor in ('unit','sweep','operator','guest','console'));

-- This empty table does not mark an existing installation pristine. Only the explicit,
-- proven-empty administrator bootstrap inserts the one marker inside its transaction.
create table public.cortex_installation (
  id boolean primary key default true check(id),
  mode text not null check(mode='pristine'),
  installed_at timestamptz not null default now()
);
alter table public.cortex_installation enable row level security;
revoke all on public.cortex_installation from public,anon,authenticated;
grant select on public.cortex_installation to service_role;

-- Supabase projects no longer share one implicit public-schema privilege baseline. Cortex is
-- service-only, so make both sides explicit for every object created by the migration chain.
revoke usage on schema public from public,anon,authenticated;
grant usage on schema public to service_role;
revoke all on all tables in schema public from public,anon,authenticated;
grant select,insert,update,delete on all tables in schema public to service_role;
revoke insert,update,delete on public.schema_migrations,public.cortex_installation from service_role;
revoke all on all sequences in schema public from public,anon,authenticated;
grant usage,select on all sequences in schema public to service_role;
revoke execute on all functions in schema public from public,anon,authenticated;
grant execute on all functions in schema public to service_role;

insert into public.schema_migrations(name,checksum) values('20260909032839_neutral_console_installation.sql','1fba918bc766ba8a827c586a3d4506e5967f0f5195b921683e9155fb49c456ef');

-- IMMUTABLE FILE 20260909041000_console_job_recovery_exits.sql SHA256 69fc6866e68b0d1e518e9904e56fbdd899a9e3cb9fedc5c4666745ac5b616b8f
-- Forward repair for console job recovery. Every function keeps its signature, invoker security,
-- empty search path and 5-second statement timeout. Applied bytes are never rewritten.
--
-- 1. A queued receipt without an execution context (the local diagnostic, or a legacy mutation
--    admitted through the plain path) had no operator exit: mark_uncertain answered not_running,
--    and the row held its (operation,target) slot for good. Any queued row can now be fenced.
-- 2. Acknowledgment accepts any uncertain receipt. Only a mutation touches the guard, and
--    last_unresolved_id records the job whose guard this acknowledgment actually released.
-- 3. A terminal publication clears last_unresolved_id when it names the job that reconciled.
-- 4. A NULL claim token never publishes: "is distinct from" treats NULL and NULL as equal.
-- 5. A late provider "running" for an acknowledged receipt whose target a later command holds
--    answers conflict on the still-uncertain row instead of raising unique_violation.
-- 6. The active admission refusal names the receipt that holds the slot.

-- (6) Same admission rules; the active refusal carries the blocking receipt.
create or replace function public.console_job_enqueue(request_key uuid,input_fingerprint text,operation_name text,target_name text,source_sha text default null)
returns jsonb language plpgsql security invoker set search_path='' set statement_timeout='5s' as $$
declare current_job public.console_jobs; guard_job uuid; mutation boolean; moment timestamptz:=clock_timestamp();
begin
  if request_key is null or input_fingerprint is null or input_fingerprint !~ '^[0-9a-f]{64}$'
    or operation_name not in ('diagnostics','checks','migrations.check','migrations.apply','deploy.preview','deploy.production')
    or target_name is null or char_length(btrim(target_name)) not between 1 and 160 or octet_length(target_name)>640 or target_name ~ '[[:cntrl:]]'
    or (source_sha is not null and source_sha !~ '^[0-9a-f]{7,64}$') then
    return jsonb_build_object('outcome','invalid');
  end if;
  perform pg_advisory_xact_lock(763541,2);
  insert into public.console_job_mutation_guard(singleton,job_id) values(true,null) on conflict(singleton) do nothing;
  -- Retention is intentionally narrow: only terminal diagnostics/tests, never uncertain or
  -- migration/deployment receipts. Inactive deployments may retain these longer than 30 days.
  delete from public.console_jobs where operation in ('diagnostics','checks') and state in ('succeeded','failed') and updated_at < moment-interval '30 days';
  select * into current_job from public.console_jobs j where j.request_key=console_job_enqueue.request_key;
  if found then
    if current_job.input_fingerprint<>input_fingerprint then return jsonb_build_object('outcome','key_conflict');end if;
    return jsonb_build_object('outcome','replay','job',to_jsonb(current_job));
  end if;
  -- Name the receipt holding the slot so an operator can open it and, when the request that
  -- queued it never claimed it, fence it explicitly instead of clicking into the same refusal.
  select * into current_job from public.console_jobs j where j.operation=operation_name and j.target=btrim(target_name) and j.state in ('queued','running') limit 1;
  if found then return jsonb_build_object('outcome','active','job',to_jsonb(current_job));end if;
  if (select count(*) from public.console_jobs where state in ('queued','running'))>=20 then return jsonb_build_object('outcome','capacity');end if;
  mutation:=operation_name in ('migrations.apply','deploy.preview','deploy.production');
  if mutation then
    select job_id into guard_job from public.console_job_mutation_guard where singleton for update;
    if guard_job is not null then return jsonb_build_object('outcome','mutation_busy');end if;
  end if;
  insert into public.console_jobs(request_key,input_fingerprint,operation,target,source_sha)
    values(request_key,input_fingerprint,operation_name,btrim(target_name),source_sha) returning * into current_job;
  if mutation then update public.console_job_mutation_guard set job_id=current_job.id where singleton;end if;
  return jsonb_build_object('outcome','enqueued','job',to_jsonb(current_job));
end;
$$;

-- (1) Any queued row can be fenced. A queued row never carries claim material, so clearing the
-- dispatch token and owner on a local row is explicit rather than consequential; a running row
-- still goes through the v1 rules (local diagnostics fence their token, provider work keeps it).
create or replace function public.console_job_mark_uncertain(job_id uuid) returns jsonb
language plpgsql security invoker set search_path='' set statement_timeout='5s' as $$
declare current_job public.console_jobs; mutation boolean; provider_request boolean; message text; detail text;
begin
  select * into current_job from public.console_jobs j where j.id=console_job_mark_uncertain.job_id for update;
  if not found then return jsonb_build_object('outcome','missing'); end if;
  if current_job.state<>'queued' then return public.console_job_mark_uncertain_v1(job_id); end if;
  mutation:=current_job.operation in ('migrations.apply','deploy.preview','deploy.production');
  provider_request:=current_job.execution_context is not null;
  message:=case when mutation
    then 'The request that queued this job never claimed it · nothing was dispatched · acknowledge to release the mutation slot'
    else 'The request that queued this job never claimed it · nothing was dispatched · a new request can proceed' end;
  detail:='No dispatch claim was recorded before explicit recovery: the request that queued this job never claimed it, so nothing was sent to a worker or provider. The receipt is retained; this is not cancellation or success.'
    ||case when mutation then ' The mutation guard remains until explicit unresolved acknowledgment.' else '' end;
  update public.console_jobs
    set state='uncertain',
        dispatch_token=case when provider_request then current_job.dispatch_token else null end,
        claim_owner=case when provider_request then current_job.claim_owner else null end,
        result=jsonb_build_object('summary',message,'checks',jsonb_build_array(jsonb_build_object(
          'name',case when current_job.operation='diagnostics' then 'diagnostic execution' when provider_request then 'provider execution' else current_job.operation end,
          'state','unavailable','detail',detail))),
        summary=message,check_count=1,updated_at=clock_timestamp()
    where id=current_job.id returning * into current_job;
  return jsonb_build_object('outcome','marked_uncertain','job',to_jsonb(current_job));
end;$$;

-- (2) Acknowledgment stamps any uncertain receipt. The guard is released only when this receipt
-- holds it, and last_unresolved_id is set by that release, so acknowledging an older receipt
-- again cannot displace a newer unresolved mutation. Diagnostics never enter the guard.
create or replace function public.console_job_acknowledge_uncertain(job_id uuid) returns jsonb
language plpgsql security invoker set search_path='' set statement_timeout='5s' as $$
declare current_job public.console_jobs;
begin
  perform pg_advisory_xact_lock(763541,2);
  select * into current_job from public.console_jobs j where j.id=console_job_acknowledge_uncertain.job_id for update;
  if not found then return jsonb_build_object('outcome','missing');end if;
  if current_job.state<>'uncertain' then return jsonb_build_object('outcome','not_uncertain','job',to_jsonb(current_job));end if;
  update public.console_jobs set unresolved_acknowledged_at=clock_timestamp(),updated_at=clock_timestamp() where id=current_job.id returning * into current_job;
  if current_job.operation in ('migrations.apply','deploy.preview','deploy.production') then
    update public.console_job_mutation_guard set job_id=null,last_unresolved_id=current_job.id
      where singleton and console_job_mutation_guard.job_id=current_job.id;
  end if;
  return jsonb_build_object('outcome','acknowledged','job',to_jsonb(current_job));
end;$$;

-- (3)(4) Same envelope validation and token fence as before, plus: a NULL token is invalid, and a
-- terminal result clears last_unresolved_id when it names this job. Parameter references are
-- qualified with the v1 name this function has carried since 20260908205956.
create or replace function public.console_job_publish_v1(job_id uuid,claim_token uuid,completion_state text,result_value jsonb,provider_identity text default null,source_sha text default null)
returns jsonb language plpgsql security invoker set search_path='' set statement_timeout='5s' as $$
declare current_job public.console_jobs; mutation boolean;
begin
  if claim_token is null or completion_state is null or completion_state not in ('succeeded','failed','uncertain') or result_value is null or jsonb_typeof(result_value)<>'object'
    or jsonb_typeof(result_value->'checks')<>'array' or jsonb_typeof(result_value->'summary')<>'string'
    or char_length(result_value->>'summary')>1000 or octet_length(result_value::text)>32768
    or (provider_identity is not null and (char_length(provider_identity)>256 or octet_length(provider_identity)>1024))
    or (source_sha is not null and source_sha !~ '^[0-9a-f]{7,64}$') then return jsonb_build_object('outcome','invalid');end if;
  if jsonb_array_length(result_value->'checks')>64 or exists(select 1 from jsonb_array_elements(result_value->'checks') c
    where jsonb_typeof(c)<>'object' or not (c ? 'name' and c ? 'state' and c ? 'detail') or (select count(*) from jsonb_object_keys(c))<>3
      or jsonb_typeof(c->'name')<>'string' or char_length(c->>'name') not between 1 and 120 or c->>'state' not in ('passed','failed','skipped','unavailable')
      or jsonb_typeof(c->'detail')<>'string' or char_length(c->>'detail')>500) then return jsonb_build_object('outcome','invalid');end if;
  select * into current_job from public.console_jobs j where j.id=console_job_publish_v1.job_id for update;
  if not found then return jsonb_build_object('outcome','missing');end if;
  -- The original claim token can reconcile an uncertain provider result, but claim() can never
  -- redispatch it. No other token can publish or release its mutation guard.
  if current_job.state not in ('running','uncertain') or current_job.dispatch_token is distinct from claim_token then
    return jsonb_build_object('outcome','stale','job',to_jsonb(current_job));
  end if;
  update public.console_jobs set state=completion_state,dispatch_token=case when completion_state='uncertain' then current_job.dispatch_token else null end,result=result_value,summary=result_value->>'summary',check_count=jsonb_array_length(result_value->'checks'),provider_id=coalesce(provider_identity,current_job.provider_id),
    source_sha=coalesce(console_job_publish_v1.source_sha,console_jobs.source_sha),updated_at=clock_timestamp()
    where id=current_job.id returning * into current_job;
  mutation:=current_job.operation in ('migrations.apply','deploy.preview','deploy.production');
  if mutation and completion_state<>'uncertain' then
    update public.console_job_mutation_guard set job_id=null where singleton and console_job_mutation_guard.job_id=current_job.id;
  end if;
  -- A reconciled receipt is no longer the unresolved work a new mutation must name.
  if completion_state<>'uncertain' then
    update public.console_job_mutation_guard set last_unresolved_id=null where singleton and console_job_mutation_guard.last_unresolved_id=current_job.id;
  end if;
  return jsonb_build_object('outcome','published','job',to_jsonb(current_job));
end;
$$;

-- (5) The public wrapper keeps its identity checks and running acceptance. Before a "running"
-- status can put an uncertain receipt back into the active index, it checks for the successor
-- that console_jobs_active_target would otherwise collide with, records the observation on the
-- still-uncertain receipt under the same token fence, and answers conflict.
create or replace function public.console_job_publish(job_id uuid,claim_token uuid,completion_state text,result_value jsonb,provider_identity text default null,source_sha text default null)
returns jsonb language plpgsql security invoker set search_path='' set statement_timeout='5s' as $$
declare current_job public.console_jobs; successor public.console_jobs; result jsonb; note text;
begin
  select * into current_job from public.console_jobs j where j.id=console_job_publish.job_id for update;
  if not found then return jsonb_build_object('outcome','missing');end if;
  if (current_job.provider_id is not null and provider_identity is not null and current_job.provider_id<>provider_identity)
    or (current_job.execution_context is not null and source_sha is not null and current_job.source_sha<>source_sha)
    or (completion_state='running' and provider_identity is null) then return jsonb_build_object('outcome','invalid');end if;
  if completion_state='running' and current_job.state='uncertain' then
    select * into successor from public.console_jobs j
      where j.operation=current_job.operation and j.target=current_job.target and j.id<>current_job.id and j.state in ('queued','running') limit 1;
    if found then
      if claim_token is null or current_job.dispatch_token is distinct from claim_token then
        return jsonb_build_object('outcome','stale','job',to_jsonb(current_job));
      end if;
      note:='Provider still reports this run in progress · a later '||current_job.operation||' command now owns '||current_job.target||' · this receipt stays uncertain';
      update public.console_jobs
        set result=jsonb_build_object('summary',note,'checks',jsonb_build_array(jsonb_build_object(
              'name','provider status','state','unavailable',
              'detail','The provider reported this run still in progress after the receipt was acknowledged and receipt '||successor.id||' took its target. This receipt cannot return to running; follow the provider run directly. The later command may duplicate its work.'))),
            summary=note,check_count=1,provider_id=coalesce(provider_identity,current_job.provider_id),updated_at=clock_timestamp()
        where id=current_job.id returning * into current_job;
      return jsonb_build_object('outcome','conflict','job',to_jsonb(current_job));
    end if;
  end if;
  result:=public.console_job_publish_v1(job_id,claim_token,case when completion_state='running' then 'uncertain' else completion_state end,result_value,provider_identity,source_sha);
  if result->>'outcome'='published' and completion_state='running' then
    update public.console_jobs set state='running' where id=job_id returning * into current_job;
    return jsonb_build_object('outcome','published','job',to_jsonb(current_job));
  end if;
  return result;
end;$$;

-- (4) The observer path refuses a NULL claim token before it reaches the publisher.
create or replace function public.console_job_reconcile_publish(job_id uuid,claim_token uuid,poll_owner uuid,completion_state text,result_value jsonb,provider_identity text default null)
returns jsonb language plpgsql security invoker set search_path='' set statement_timeout='5s' as $$
declare current_job public.console_jobs;
begin
  if claim_token is null then return jsonb_build_object('outcome','invalid');end if;
  select * into current_job from public.console_jobs j where j.id=console_job_reconcile_publish.job_id for update;
  if not found then return jsonb_build_object('outcome','missing');end if;
  if poll_owner is null or current_job.poll_token is distinct from poll_owner or current_job.poll_expires_at is null or current_job.poll_expires_at<=clock_timestamp() then
    return jsonb_build_object('outcome','stale','job',to_jsonb(current_job));
  end if;
  return public.console_job_publish(job_id,claim_token,completion_state,result_value,provider_identity,null);
end;$$;

revoke all on function public.console_job_enqueue(uuid,text,text,text,text),public.console_job_mark_uncertain(uuid),public.console_job_acknowledge_uncertain(uuid),public.console_job_publish_v1(uuid,uuid,text,jsonb,text,text),public.console_job_publish(uuid,uuid,text,jsonb,text,text),public.console_job_reconcile_publish(uuid,uuid,uuid,text,jsonb,text) from public,anon,authenticated;
grant execute on function public.console_job_enqueue(uuid,text,text,text,text),public.console_job_mark_uncertain(uuid),public.console_job_acknowledge_uncertain(uuid),public.console_job_publish_v1(uuid,uuid,text,jsonb,text,text),public.console_job_publish(uuid,uuid,text,jsonb,text,text),public.console_job_reconcile_publish(uuid,uuid,uuid,text,jsonb,text) to service_role;

insert into public.schema_migrations(name,checksum) values('20260909041000_console_job_recovery_exits.sql','69fc6866e68b0d1e518e9904e56fbdd899a9e3cb9fedc5c4666745ac5b616b8f');

-- IMMUTABLE FILE 20260909041500_pinned_live_corpus_snapshot.sql SHA256 97f03d1832b43f822ec7f93257e140dee8e2776d71875f229d93e29a714ebfda
-- Forward repair: corpus_snapshot ran with `search_path = public, pg_catalog`, the one service
-- RPC that searched public before the catalog, while its filter called regexp_replace and the
-- pattern operators unqualified. This pins the empty search path every other new function uses
-- and writes each table, function and pattern operator schema-qualified. Behaviour is unchanged:
-- the same isLive filter, the same measurement and the same 64 MiB ceiling.
--
-- statement_timeout is 30 s rather than the 5 s of the small RPCs: this call serializes up to
-- 64 MiB of notes in one statement, and PostgREST hoists the value into the calling transaction.
create or replace function public.corpus_snapshot()
returns jsonb
language plpgsql
stable
security invoker
set search_path = ''
set statement_timeout = '30s'
as $$
declare
  snapshot_head text;
  row_count bigint;
  row_bytes bigint;
  payload_bytes bigint;
  max_payload_bytes constant bigint := 67108864;
begin
  select s.head_sha
    into snapshot_head
    from public.sync_state as s
    where s.id is true;

  select pg_catalog.count(*),
         coalesce(
           pg_catalog.sum(pg_catalog.octet_length(encoded.row_json::text)),
           0
         )
    into row_count, row_bytes
    from (
      select pg_catalog.jsonb_build_object(
               'path', n.path,
               'content', n.content,
               'commit_sha', n.commit_sha
             ) as row_json
        from public.notes as n
          where n.path operator(pg_catalog.~*) '\.md$'
            and not (n.path operator(pg_catalog.^@) any(array['.git/','.claude/','tools/','archive/','brain-v2/','.github/']::text[]))
            and pg_catalog.regexp_replace(n.path, '^.*/', '') operator(pg_catalog.<>) all(array['brain-index.md','INDEX.md','README.md']::text[])
    ) as encoded;

  -- jsonb text renders array elements with a comma-and-space separator. The empty envelope
  -- already contributes both brackets, so replacing its empty array contents requires exactly
  -- the serialized row bytes plus two bytes between each adjacent pair.
  payload_bytes :=
    pg_catalog.octet_length(
      pg_catalog.jsonb_build_object(
        'head', snapshot_head,
        'rows', '[]'::pg_catalog.jsonb
      )::text
    )::bigint
    + row_bytes
    + 2 * greatest(row_count - 1, 0);

  if payload_bytes > max_payload_bytes then
    raise exception using
      errcode = '54000',
      message = 'corpus snapshot exceeds 64 MiB safety limit';
  end if;

  return (
    select pg_catalog.jsonb_build_object(
             'head', snapshot_head,
             'rows', coalesce(
               pg_catalog.jsonb_agg(encoded.row_json order by encoded.path),
               '[]'::pg_catalog.jsonb
             )
           )
      from (
        select n.path,
               pg_catalog.jsonb_build_object(
                 'path', n.path,
                 'content', n.content,
                 'commit_sha', n.commit_sha
               ) as row_json
          from public.notes as n
          where n.path operator(pg_catalog.~*) '\.md$'
            and not (n.path operator(pg_catalog.^@) any(array['.git/','.claude/','tools/','archive/','brain-v2/','.github/']::text[]))
            and pg_catalog.regexp_replace(n.path, '^.*/', '') operator(pg_catalog.<>) all(array['brain-index.md','INDEX.md','README.md']::text[])
      ) as encoded
  );
end
$$;

revoke execute on function public.corpus_snapshot() from public, anon, authenticated;
grant execute on function public.corpus_snapshot() to service_role;

insert into public.schema_migrations(name,checksum) values('20260909041500_pinned_live_corpus_snapshot.sql','97f03d1832b43f822ec7f93257e140dee8e2776d71875f229d93e29a714ebfda');

-- IMMUTABLE FILE 20260909042000_rpc_statement_timeouts.sql SHA256 9eeb93d714f716ad94eba6672c4cdcaae3440961c2712c91039950263a6a05f4
-- Forward repair: every service RPC carries its own statement timeout. The 8-second fetch abort
-- in the application cancels nothing on the server; PostgREST hoists a function's
-- statement_timeout into the calling transaction, and a direct native call alone does not.
-- These twelve functions shipped without one (two of them hold pg_advisory_xact_lock(763541,1)
-- unbounded). ALTER FUNCTION ... SET changes the setting only; no body or grant is touched.
-- corpus_snapshot() received its larger 30 s bound in 20260909041500_pinned_live_corpus_snapshot.sql.
alter function public.bubble_open_scoped(integer, integer, text, boolean) set statement_timeout = '5s';
alter function public.bubble_console_add(uuid, text, text, text) set statement_timeout = '5s';
alter function public.bubble_console_edit(bigint, bigint, text, text, text, boolean) set statement_timeout = '5s';
alter function public.bubble_console_list(text, timestamptz, bigint, integer) set statement_timeout = '5s';
alter function public.bubble_console_item(bigint) set statement_timeout = '5s';
alter function public.console_device_list() set statement_timeout = '5s';
alter function public.console_device_register(uuid, timestamptz, text, text, text, uuid) set statement_timeout = '5s';
alter function public.console_device_rename(uuid, timestamptz, text) set statement_timeout = '5s';
alter function public.console_device_forget(uuid, timestamptz) set statement_timeout = '5s';
alter function public.console_device_visit(uuid) set statement_timeout = '5s';
alter function public.edges_usage_identity() set statement_timeout = '5s';

insert into public.schema_migrations(name,checksum) values('20260909042000_rpc_statement_timeouts.sql','9eeb93d714f716ad94eba6672c4cdcaae3440961c2712c91039950263a6a05f4');

-- IMMUTABLE FILE 20260909043000_console_job_guard_invariant.sql SHA256 f23c1e834e5bbc4e2cf083f57d2aae0ca2d84b8dd42959f5e6997f0998baae6c
-- Forward repair of 20260909041000_console_job_recovery_exits.sql. That file shipped in #162 and may
-- be applied anywhere by now, so its bytes are immutable; the two functions below replace the ones
-- it created, with the same signatures and the same security posture.
--
-- 7. A mutation is running only while the mutation guard names it. Acknowledgment released that
--    guard, so a late provider "running" for an acknowledged mutation re-takes the guard when it is
--    free (and stops naming this receipt as the unresolved work) and answers conflict, naming the
--    holder, when another mutation has it. Two mutations never run at once, whatever the provider
--    reports; a row the old wrapper left running beside a free guard is healed on its next status.
-- 8. Acknowledging a receipt that was fenced before any claim names nothing new as unresolved: a
--    row with no dispatch token never reached a worker or provider and cannot still finish.
--
-- Decision — "Mark lost response uncertain" on a running provider receipt whose provider is healthy:
-- the control is reachable for any running receipt, and the next status poll then reports "running"
-- on an uncertain row that never released its guard. That is a resumption, not a conflict. The row
-- returns to running under its original token, the guard it never released still names it, and the
-- receipt carries the provider's status; the publisher answers `resumed` so the caller can say so.
-- Keeping the row uncertain would invite an acknowledgment of a run the provider verifiably has in
-- progress, which is the one thing that can put a second mutation beside it. Conflict is reserved
-- for the two cases where returning to running would break an invariant: a later command owns the
-- target, or another mutation holds the guard. Both leave the row uncertain and name the holder.
-- Publish takes no advisory lock on purpose: acknowledge takes the advisory lock and then the job
-- row, and a publisher holding the row while waiting for the advisory lock would deadlock it.

-- (2)(8) Acknowledgment stamps any uncertain receipt. The guard is released only when this receipt
-- holds it, and last_unresolved_id is set by that release, so acknowledging an older receipt
-- again cannot displace a newer unresolved mutation. Diagnostics never enter the guard. A receipt
-- without a dispatch token was fenced before any claim: nothing was sent, so it is not unresolved
-- work and the release leaves whatever last_unresolved_id already names in place.
create or replace function public.console_job_acknowledge_uncertain(job_id uuid) returns jsonb
language plpgsql security invoker set search_path='' set statement_timeout='5s' as $$
declare current_job public.console_jobs;
begin
  perform pg_advisory_xact_lock(763541,2);
  select * into current_job from public.console_jobs j where j.id=console_job_acknowledge_uncertain.job_id for update;
  if not found then return jsonb_build_object('outcome','missing');end if;
  if current_job.state<>'uncertain' then return jsonb_build_object('outcome','not_uncertain','job',to_jsonb(current_job));end if;
  update public.console_jobs set unresolved_acknowledged_at=clock_timestamp(),updated_at=clock_timestamp() where id=current_job.id returning * into current_job;
  if current_job.operation in ('migrations.apply','deploy.preview','deploy.production') then
    update public.console_job_mutation_guard g
      set job_id=null,last_unresolved_id=case when current_job.dispatch_token is null then g.last_unresolved_id else current_job.id end
      where g.singleton and g.job_id=current_job.id;
  end if;
  return jsonb_build_object('outcome','acknowledged','job',to_jsonb(current_job));
end;$$;

-- (5)(7) The public wrapper keeps its identity checks and running acceptance. Before a "running"
-- status can put a receipt back into the active index it checks for the successor that
-- console_jobs_active_target would otherwise collide with, and before a mutation can be running it
-- takes the guard row lock — the same lock admission takes before handing the guard to a new
-- mutation — and checks that the guard is free or already names this receipt. Either holder is
-- recorded on the still-uncertain receipt under the same token fence and answered as conflict.
-- A receipt that was uncertain and is running again is answered as `resumed`, not `published`.
create or replace function public.console_job_publish(job_id uuid,claim_token uuid,completion_state text,result_value jsonb,provider_identity text default null,source_sha text default null)
returns jsonb language plpgsql security invoker set search_path='' set statement_timeout='5s' as $$
declare current_job public.console_jobs; holder public.console_jobs; guard_job uuid; mutation boolean; resumed boolean; result jsonb; note text; detail text;
begin
  select * into current_job from public.console_jobs j where j.id=console_job_publish.job_id for update;
  if not found then return jsonb_build_object('outcome','missing');end if;
  if (current_job.provider_id is not null and provider_identity is not null and current_job.provider_id<>provider_identity)
    or (current_job.execution_context is not null and source_sha is not null and current_job.source_sha<>source_sha)
    or (completion_state='running' and provider_identity is null) then return jsonb_build_object('outcome','invalid');end if;
  mutation:=current_job.operation in ('migrations.apply','deploy.preview','deploy.production');
  resumed:=current_job.state='uncertain';
  if completion_state='running' then
    if resumed then
      select * into holder from public.console_jobs j
        where j.operation=current_job.operation and j.target=current_job.target and j.id<>current_job.id and j.state in ('queued','running') limit 1;
      if found then
        note:='Provider still reports this run in progress · a later '||current_job.operation||' command now owns '||current_job.target||' · this receipt stays uncertain';
        detail:='The provider reported this run still in progress after the receipt was acknowledged and receipt '||holder.id||' took its target. This receipt cannot return to running; follow the provider run directly. The later command may duplicate its work.';
      end if;
    end if;
    if note is null and mutation then
      select g.job_id into guard_job from public.console_job_mutation_guard g where g.singleton for update;
      if guard_job is not null and guard_job<>current_job.id then
        select * into holder from public.console_jobs j where j.id=guard_job;
        note:='Provider still reports this run in progress · a later '||coalesce(holder.operation,'mutation')||' command now holds the mutation guard · this receipt stays uncertain';
        detail:='The provider reported this run still in progress after the receipt was acknowledged and receipt '||guard_job||' ('||coalesce(holder.operation,'mutation')||') took the mutation guard. This receipt cannot return to running while another mutation holds the guard; follow the provider run directly. Two mutations never run at once, so the later command may duplicate its work.';
      end if;
    end if;
    if note is not null then
      if claim_token is null or current_job.dispatch_token is distinct from claim_token then
        return jsonb_build_object('outcome','stale','job',to_jsonb(current_job));
      end if;
      update public.console_jobs
        set state='uncertain',
            result=jsonb_build_object('summary',note,'checks',jsonb_build_array(jsonb_build_object('name','provider status','state','unavailable','detail',detail))),
            summary=note,check_count=1,provider_id=coalesce(provider_identity,current_job.provider_id),updated_at=clock_timestamp()
        where id=current_job.id returning * into current_job;
      return jsonb_build_object('outcome','conflict','job',to_jsonb(current_job));
    end if;
  end if;
  result:=public.console_job_publish_v1(job_id,claim_token,case when completion_state='running' then 'uncertain' else completion_state end,result_value,provider_identity,source_sha);
  if result->>'outcome'='published' and completion_state='running' then
    if mutation then
      -- Running implies holding the guard: re-take one that acknowledgment released, and stop
      -- naming a receipt that is back at work as the unresolved work the next mutation must cite.
      -- The row lock taken above makes the free-or-mine check and this write one decision.
      insert into public.console_job_mutation_guard(singleton,job_id) values(true,current_job.id)
        on conflict(singleton) do update set job_id=excluded.job_id,
          last_unresolved_id=case when console_job_mutation_guard.last_unresolved_id=excluded.job_id then null else console_job_mutation_guard.last_unresolved_id end
        where console_job_mutation_guard.job_id is null or console_job_mutation_guard.job_id=excluded.job_id;
      if not found then raise exception 'console_job_publish: mutation guard held by another receipt' using errcode='serialization_failure';end if;
    end if;
    update public.console_jobs set state='running' where id=job_id returning * into current_job;
    return jsonb_build_object('outcome',case when resumed then 'resumed' else 'published' end,'job',to_jsonb(current_job));
  end if;
  return result;
end;$$;

revoke all on function public.console_job_acknowledge_uncertain(uuid),public.console_job_publish(uuid,uuid,text,jsonb,text,text) from public,anon,authenticated;
grant execute on function public.console_job_acknowledge_uncertain(uuid),public.console_job_publish(uuid,uuid,text,jsonb,text,text) to service_role;

insert into public.schema_migrations(name,checksum) values('20260909043000_console_job_guard_invariant.sql','f23c1e834e5bbc4e2cf083f57d2aae0ca2d84b8dd42959f5e6997f0998baae6c');

do $cortex_finish$
declare table_name text; contains_rows boolean;
begin
 for table_name in select c.relname from pg_catalog.pg_class c join pg_catalog.pg_namespace n on n.oid=c.relnamespace
   where n.nspname='public' and c.relkind in ('r','p')
     and c.relname not in ('schema_migrations','sync_state','console_job_mutation_guard','cortex_installation') loop
   execute pg_catalog.format('select exists(select 1 from public.%I)',table_name) into contains_rows;
   if contains_rows then raise exception 'Pristine bootstrap found unexpected user data; transaction rolled back';end if;
 end loop;
 if (select count(*) from public.sync_state)<>1 or not exists(select 1 from public.sync_state where id and head_sha='')
   or (select count(*) from public.console_job_mutation_guard)<>1
   or not exists(select 1 from public.console_job_mutation_guard where singleton and job_id is null)
   or exists(select 1 from public.cortex_installation) then
   raise exception 'Pristine bootstrap scaffold validation failed; transaction rolled back';
 end if;
 if exists(select 1 from pg_catalog.pg_class c join pg_catalog.pg_namespace n on n.oid=c.relnamespace
   where n.nspname='public' and c.relkind in ('r','p') and not c.relrowsecurity
     and not exists(select 1 from pg_catalog.pg_depend d where d.classid='pg_catalog.pg_class'::regclass and d.objid=c.oid and d.deptype='e')) then
   raise exception 'Cortex table RLS validation failed';
 end if;
 revoke all on function public.rls_auto_enable() from public,anon,authenticated,service_role;
 insert into public.cortex_installation(id,mode) values(true,'pristine');
end $cortex_finish$;
commit;
