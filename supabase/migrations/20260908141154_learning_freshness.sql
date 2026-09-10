-- Policy coaccess-v2-90d-closed-utc-6-2. Raw history and structural edges are retained.
-- A bounded mutation clock, not a second access log: at most 2161 UTC hour buckets.
create table public.edges_usage_hours (
  hour timestamptz primary key,
  revision bigint not null check (revision > 0)
);
alter table public.edges_usage_hours enable row level security;
revoke all on public.edges_usage_hours from public, anon, authenticated;
grant select, insert, update, delete on public.edges_usage_hours to service_role;
create policy edges_usage_service on public.edges_usage_hours for all to service_role using(true) with check(true);
create policy edges_state_service on public.edges_state for all to service_role using(true) with check(true);
create policy note_edges_service on public.note_edges for all to service_role using(true) with check(true);
alter table public.edges_state add column built_watermark text;
alter table public.edges_state add column built_cutoff timestamptz;
alter table public.edges_state add column built_policy text;
create index note_access_learning_at on public.note_access(at)
  where mode not in ('boot', 'handoff', 'maintenance');

create function public.edges_touch_hour(t timestamptz) returns void
language plpgsql security invoker set search_path = '' as $$
declare cutoff timestamptz := date_trunc('hour', statement_timestamp(), 'UTC');
begin
  if t >= cutoff - interval '2160 hours' and t < cutoff + interval '1 hour' then
    delete from public.edges_usage_hours where hour < cutoff - interval '2160 hours';
    insert into public.edges_usage_hours(hour,revision) values(date_trunc('hour',t,'UTC'),1)
      on conflict(hour) do update set revision=public.edges_usage_hours.revision+1;
  end if;
end $$;
create function public.edges_access_changed() returns trigger
language plpgsql security invoker set search_path = '' as $$
begin
  if tg_op = 'TRUNCATE' then
    perform public.edges_touch_hour(statement_timestamp()-interval '1 hour');
    return null;
  end if;
  if tg_op <> 'INSERT' and old.mode not in ('boot', 'handoff', 'maintenance') then
    perform public.edges_touch_hour(old.at);
  end if;
  if tg_op <> 'DELETE' and new.mode not in ('boot', 'handoff', 'maintenance') then
    perform public.edges_touch_hour(new.at);
  end if;
  return null;
end $$;
create trigger edges_access_mutation after insert or update or delete on public.note_access
  for each row execute function public.edges_access_changed();
create trigger edges_access_truncate after truncate on public.note_access
  for each statement execute function public.edges_access_changed();

create function public.edges_usage_identity() returns jsonb
language sql stable security invoker set search_path = '' as $$
  with boundary as (select date_trunc('hour',statement_timestamp(),'UTC') cutoff)
  select jsonb_build_object('policy','coaccess-v2-90d-closed-utc-6-2','cutoff',b.cutoff,
    'watermark',md5(coalesce((select string_agg(extract(epoch from h.hour)::text || ':' || h.revision::text,',' order by h.hour)
      from public.edges_usage_hours h where h.hour >= b.cutoff-interval '2160 hours' and h.hour < b.cutoff),'')))
  from boundary b
$$;
create function public.edges_freshness(new_head text) returns jsonb
language sql stable security invoker set search_path = '' set statement_timeout = '2s' as $$
  with input as (select public.edges_usage_identity() identity)
  select i.identity || jsonb_build_object('builtAt',(select built_at from public.edges_state where id is true),
    'structural',not exists(select 1 from public.edges_state s where s.id is true and s.built_head=new_head),'state',case
    when (select head_sha from public.sync_state where id is true) is distinct from new_head then 'stale-head'
    when exists(select 1 from public.edges_state s where s.id is true and s.built_head=new_head
      and s.built_watermark=i.identity->>'watermark' and s.built_cutoff=(i.identity->>'cutoff')::timestamptz
      and s.built_policy=i.identity->>'policy') then 'current' else 'stale' end)
  from input i
$$;

-- Nonblocking publication locks bound contention. A 100001-row probe refuses overload rather
-- than training on a silently truncated history. HTTP timeouts are NOT a rollback guarantee.
create function public.edges_rebuild_v2(new_head text, expected_watermark text,
  expected_cutoff timestamptz, edges jsonb, force boolean default false) returns text
language plpgsql security invoker set search_path = '' set statement_timeout = '5s' as $$
declare identity jsonb; samples jsonb; n bigint; mirror_head text;
begin
  if not pg_try_advisory_xact_lock(18462026,2) then return 'busy'; end if;
  lock table public.edges_usage_hours in share mode nowait;
  select head_sha into mirror_head from public.sync_state where id is true for share nowait;
  if mirror_head is distinct from new_head then return 'stale-head'; end if;
  identity := public.edges_usage_identity();
  if expected_watermark is distinct from identity->>'watermark'
    or expected_cutoff is distinct from (identity->>'cutoff')::timestamptz then return 'stale-input'; end if;
  if not force and public.edges_freshness(new_head)->>'state'='current' then return 'current'; end if;
  with bounded as materialized (
    select at,path from public.note_access where mode not in ('boot', 'handoff', 'maintenance')
      and at >= expected_cutoff-interval '2160 hours' and at < expected_cutoff limit 100001
  ) select count(*),jsonb_agg(jsonb_build_object('w',date_trunc('hour',at,'UTC'),'path',path)) into n,samples from bounded;
  if n > 100000 then return 'capacity'; end if;
  if edges is null and not exists(select 1 from public.edges_state where id is true and built_head=new_head) then return 'stale-input'; end if;
  if edges is not null and (jsonb_typeof(edges) is distinct from 'array' or jsonb_array_length(edges)>200000 or octet_length(edges::text)>16*1024*1024) then return 'capacity'; end if;
  if exists(select 1 from jsonb_to_recordset(edges) x(kind text) where x.kind='coaccess') then
    raise exception 'coaccess must be derived from eligible history';
  end if;
  delete from public.note_edges where edges is not null or kind='coaccess';
  insert into public.note_edges(src,dst,kind,weight,evidence,built_head)
    select x.src,x.dst,x.kind,x.weight,x.evidence,new_head from jsonb_to_recordset(edges)
      x(src text,dst text,kind text,weight real,evidence text);
  with reads as (
    select distinct x.w,x.path from jsonb_to_recordset(coalesce(samples,'[]'::jsonb)) x(w timestamptz,path text)
  ), focused as (select w from reads group by w having count(*)<=6), eligible as (
    select r.* from reads r join focused f using(w)
  ) insert into public.note_edges(src,dst,kind,weight,evidence,built_head)
    select a.path,b.path,'coaccess',count(*)::real,
      'co-read in ' || count(*) || ' shared UTC hours; coaccess-v2: last 90 days, completed hours, fanout <=6, >=2 windows; boot/handoff/maintenance excluded',new_head
    from eligible a join eligible b on a.w=b.w and a.path collate "C" < b.path collate "C"
    where exists(select 1 from public.notes n where n.path=a.path)
      and exists(select 1 from public.notes n where n.path=b.path)
    group by a.path,b.path having count(*)>=2;
  insert into public.edges_state(id,built_head,built_at,built_watermark,built_cutoff,built_policy)
    values(true,new_head,clock_timestamp(),expected_watermark,expected_cutoff,identity->>'policy')
    on conflict(id) do update set built_head=excluded.built_head,built_at=excluded.built_at,
      built_watermark=excluded.built_watermark,built_cutoff=excluded.built_cutoff,built_policy=excluded.built_policy;
  return 'rebuilt';
exception when lock_not_available then return 'busy';
end $$;

-- An old caller cannot publish a graph without the new identity contract.
drop function public.edges_rebuild(text,jsonb);
revoke execute on function public.edges_touch_hour(timestamptz),public.edges_access_changed(),
  public.edges_usage_identity(),public.edges_freshness(text),public.edges_rebuild_v2(text,text,timestamptz,jsonb,boolean)
  from public,anon,authenticated;
grant execute on function public.edges_touch_hour(timestamptz),public.edges_access_changed(),
  public.edges_usage_identity(),public.edges_freshness(text),public.edges_rebuild_v2(text,text,timestamptz,jsonb,boolean) to service_role;
grant select,insert,update on public.edges_state to service_role;
grant select,insert,delete on public.note_edges to service_role;
grant select on public.notes,public.note_access to service_role;
grant select,update on public.sync_state to service_role;
