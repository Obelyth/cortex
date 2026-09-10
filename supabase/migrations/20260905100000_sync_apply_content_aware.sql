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
