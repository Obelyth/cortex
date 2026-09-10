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
