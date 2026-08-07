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
