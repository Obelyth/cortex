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
