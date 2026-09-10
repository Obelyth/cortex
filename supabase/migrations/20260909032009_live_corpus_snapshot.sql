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
