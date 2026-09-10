-- Requires bubble_items and the reviewed Unicode project normalizer from bubble_open_scoped.
-- Revisions belong to the database: old MCP/table writers and lazy age-out advance them too.
alter table public.bubble_items
  add column version bigint not null default 1 check (version > 0),
  add column console_request_key uuid unique,
  add column console_payload_digest text;

create function public.bubble_advance_version()
returns trigger language plpgsql security invoker set search_path = '' as $$
begin
  new.version := old.version + 1;
  -- An add's identity describes its ORIGINAL payload even after a model edits the item.
  new.console_request_key := old.console_request_key;
  new.console_payload_digest := old.console_payload_digest;
  return new;
end $$;
create trigger bubble_item_revision before update on public.bubble_items
  for each row execute function public.bubble_advance_version();

create function public.bubble_console_add(request_key uuid, item_kind text, item_body text, project_name text)
returns jsonb language plpgsql security invoker set search_path = '' as $$
declare
  item public.bubble_items;
  project text := public.bubble_normalize_project(project_name);
  fingerprint text;
begin
  if request_key is null or item_kind is null or item_kind not in ('focus','decision','question','handoff')
     or item_body is null or char_length(item_body) not between 1 and 2000 or octet_length(item_body) > 8000
     or btrim(item_body) = '' or project is null or char_length(project) > 80 or octet_length(project) > 320 then
    return jsonb_build_object('outcome','invalid');
  end if;
  fingerprint := encode(sha256(convert_to(jsonb_build_array(item_kind,item_body,project)::text,'UTF8')),'hex');
  insert into public.bubble_items(kind,body,project,surface,console_request_key,console_payload_digest)
    values(item_kind,item_body,project,'console',request_key,fingerprint)
    on conflict(console_request_key) do nothing;
  -- The unique constraint waits for competing inserts. A subsequent statement sees its winner.
  select * into item from public.bubble_items b where b.console_request_key = request_key for update;
  if not found then raise exception 'working state unavailable'; end if;
  if item.console_payload_digest <> fingerprint then return jsonb_build_object('outcome','key_conflict'); end if;
  if item.status = 'open' and item.touched_at < now() - interval '14 days' then
    update public.bubble_items set status='aged' where id=item.id returning * into item;
  end if;
  return jsonb_build_object('outcome','saved','item',to_jsonb(item));
end $$;

create function public.bubble_console_edit(
  item_id bigint, expected_version bigint, item_kind text default null, item_body text default null,
  project_name text default null, age_out boolean default false
)
returns jsonb language plpgsql security invoker set search_path = '' as $$
declare item public.bubble_items;
begin
  if item_id is null or item_id < 1 or expected_version is null or expected_version < 1 or age_out is null
     or (item_kind is not null and item_kind not in ('focus','decision','question','handoff'))
     or (item_body is not null and (char_length(item_body) not between 1 and 2000 or octet_length(item_body)>8000 or btrim(item_body)=''))
     or (project_name is not null and (char_length(public.bubble_normalize_project(project_name))>80 or octet_length(project_name)>320)) then
    return jsonb_build_object('outcome','invalid');
  end if;
  select * into item from public.bubble_items where id=item_id for update;
  if not found then return jsonb_build_object('outcome','missing'); end if;
  if item.status='open' and item.touched_at < now()-interval '14 days' then
    update public.bubble_items set status='aged' where id=item_id returning * into item;
  end if;
  if item.version <> expected_version or item.status <> 'open' then
    return jsonb_build_object('outcome','conflict','item',to_jsonb(item));
  end if;
  update public.bubble_items set
    kind=coalesce(item_kind,kind), body=coalesce(item_body,body),
    project=coalesce(public.bubble_normalize_project(project_name),project),
    status=case when age_out then 'aged' else status end, touched_at=now()
    where id=item_id returning * into item;
  return jsonb_build_object('outcome','saved','item',to_jsonb(item));
end $$;

create index bubble_console_open_order on public.bubble_items(touched_at desc,id desc) where status='open';

create function public.bubble_console_list(
  project_name text default null, before_touched timestamptz default null,
  before_id bigint default null, page_size integer default 20
)
returns jsonb language plpgsql security invoker set search_path = '' as $$
declare swept integer; result jsonb;
begin
  if page_size is null or page_size not between 1 and 50 or (before_touched is null) <> (before_id is null)
     or before_id < 1 or char_length(project_name)>80 then raise exception 'invalid management page'; end if;
  with aged as (
    update public.bubble_items set status='aged' where status='open' and touched_at<now()-interval '14 days'
    returning project
  ) select count(*)::integer into swept from aged
    where project_name is null or public.bubble_normalize_project(project)=public.bubble_normalize_project(project_name);
  -- One statement gives the count and page the same snapshot and exactly the same scope.
  with scoped as materialized (
    select id,version,kind,body,project,status,touched_at from public.bubble_items
    where status='open' and (project_name is null or public.bubble_normalize_project(project)=public.bubble_normalize_project(project_name))
  ), page as (
    select * from scoped where before_touched is null or (touched_at,id)<(before_touched,before_id)
    order by touched_at desc,id desc limit page_size+1
  ), shown as (select * from page order by touched_at desc,id desc limit page_size)
  select jsonb_build_object(
    'total',(select count(*) from scoped),'swept',swept,
    'items',coalesce((select jsonb_agg(s order by touched_at desc,id desc) from shown s),'[]'::jsonb),
    'next',case when (select count(*) from page)>page_size
      then (select jsonb_build_object('touched_at',touched_at,'id',id) from shown order by touched_at,id limit 1)
      else null end
  ) into result;
  return result;
end $$;

create function public.bubble_console_item(item_id bigint)
returns jsonb language plpgsql security invoker set search_path = '' as $$
declare item public.bubble_items;
begin
  select * into item from public.bubble_items where id=item_id for update;
  if not found then return null; end if;
  if item.status='open' and item.touched_at<now()-interval '14 days' then
    update public.bubble_items set status='aged' where id=item_id returning * into item;
  end if;
  return to_jsonb(item);
end $$;

-- Existing service writes remain supported; no browser role gains table or function access.
grant select,insert,update on public.bubble_items to service_role;
grant usage,select on sequence public.bubble_items_id_seq to service_role;
create policy bubble_service_working_state on public.bubble_items to service_role using(true) with check(true);
revoke execute on function public.bubble_advance_version() from public,anon,authenticated;
revoke execute on function public.bubble_console_add(uuid,text,text,text) from public,anon,authenticated;
revoke execute on function public.bubble_console_edit(bigint,bigint,text,text,text,boolean) from public,anon,authenticated;
revoke execute on function public.bubble_console_list(text,timestamptz,bigint,integer) from public,anon,authenticated;
revoke execute on function public.bubble_console_item(bigint) from public,anon,authenticated;
grant execute on function public.bubble_console_add(uuid,text,text,text) to service_role;
grant execute on function public.bubble_console_edit(bigint,bigint,text,text,text,boolean) to service_role;
grant execute on function public.bubble_console_list(text,timestamptz,bigint,integer) to service_role;
grant execute on function public.bubble_console_item(bigint) to service_role;
