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
