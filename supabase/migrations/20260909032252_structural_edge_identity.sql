-- Algorithm identity is independent of corpus SHA and coaccess usage policy. Existing rows
-- deliberately remain unstamped and stale until the bounded current deriver publishes them.
alter table public.edges_state add column built_structure text;
create or replace function public.edges_freshness(new_head text) returns jsonb
language sql stable security invoker set search_path = '' set statement_timeout = '2s' as $$
  with input as (select public.edges_usage_identity() identity)
  select i.identity || jsonb_build_object('structure','structural-v2-unicode-bm25-1.5-1','builtStructure',(select built_structure from public.edges_state where id is true),'builtAt',(select built_at from public.edges_state where id is true),
    'structural',not exists(select 1 from public.edges_state s where s.id is true and s.built_head=new_head and s.built_structure='structural-v2-unicode-bm25-1.5-1'),'state',case
    when (select head_sha from public.sync_state where id is true) is distinct from new_head then 'stale-head'
    when exists(select 1 from public.edges_state s where s.id is true and s.built_head=new_head and s.built_structure='structural-v2-unicode-bm25-1.5-1'
      and s.built_watermark=i.identity->>'watermark' and s.built_cutoff=(i.identity->>'cutoff')::timestamptz
      and s.built_policy=i.identity->>'policy') then 'current' else 'stale' end)
  from input i
$$;

-- Nonblocking publication locks bound contention. A 100001-row probe refuses overload rather
-- than training on a silently truncated history. HTTP timeouts are NOT a rollback guarantee.
create function public.edges_rebuild_v3(new_head text, expected_watermark text,
  expected_cutoff timestamptz, expected_structure text, edges jsonb, force boolean default false) returns text
language plpgsql security invoker set search_path = '' set statement_timeout = '5s' as $$
declare identity jsonb; samples jsonb; n bigint; mirror_head text;
begin
  if expected_structure is distinct from 'structural-v2-unicode-bm25-1.5-1' then return 'stale-input'; end if;
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
  if edges is null and not exists(select 1 from public.edges_state where id is true and built_head=new_head and built_structure=expected_structure) then return 'stale-input'; end if;
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
  insert into public.edges_state(id,built_head,built_at,built_watermark,built_cutoff,built_policy,built_structure)
    values(true,new_head,clock_timestamp(),expected_watermark,expected_cutoff,identity->>'policy',expected_structure)
    on conflict(id) do update set built_head=excluded.built_head,built_at=excluded.built_at,
      built_watermark=excluded.built_watermark,built_cutoff=excluded.built_cutoff,built_policy=excluded.built_policy,built_structure=excluded.built_structure;
  return 'rebuilt';
exception when lock_not_available then return 'busy';
end $$;


-- Old deployments cannot falsely certify their old lexical output as the new algorithm.
create or replace function public.edges_rebuild_v2(new_head text,expected_watermark text,
 expected_cutoff timestamptz,edges jsonb,force boolean default false) returns text
language sql security invoker set search_path='' as $$ select 'stale-input'::text $$;
revoke execute on function public.edges_rebuild_v3(text,text,timestamptz,text,jsonb,boolean) from public,anon,authenticated;
grant execute on function public.edges_rebuild_v3(text,text,timestamptz,text,jsonb,boolean) to service_role;
