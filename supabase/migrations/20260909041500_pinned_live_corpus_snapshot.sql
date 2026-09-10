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
