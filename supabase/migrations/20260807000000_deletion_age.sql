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
