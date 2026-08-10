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
