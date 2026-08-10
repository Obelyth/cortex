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
