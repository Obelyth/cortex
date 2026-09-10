-- Durable console commands are separate from reporter runs, alerts and browser inventory.
-- Request bodies, credentials and note text have no column here; only bounded command receipts.
create table public.console_jobs (
  id uuid primary key default gen_random_uuid(),
  request_key uuid not null unique,
  input_fingerprint text not null check (input_fingerprint ~ '^[0-9a-f]{64}$'),
  operation text not null check (operation in ('diagnostics','checks','migrations.check','migrations.apply','deploy.preview','deploy.production')),
  target text not null check (char_length(btrim(target)) between 1 and 160 and octet_length(target) <= 640 and target !~ '[[:cntrl:]]'),
  source_sha text check (source_sha ~ '^[0-9a-f]{7,64}$'),
  state text not null default 'queued' check (state in ('queued','running','succeeded','failed','uncertain')),
  requested_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  dispatch_token uuid,
  result jsonb not null default '{"checks":[],"summary":"Queued"}'::jsonb check (jsonb_typeof(result)='object' and octet_length(result::text) <= 32768),
  summary text not null default 'Queued' check (char_length(summary)<=1000),
  check_count integer not null default 0 check (check_count between 0 and 64),
  provider_id text check (char_length(provider_id) <= 256 and octet_length(provider_id) <= 1024),
  unresolved_acknowledged_at timestamptz,
  check ((state='running' and dispatch_token is not null) or (state='uncertain') or (state not in ('running','uncertain') and dispatch_token is null))
);

-- The one-row guard is deliberately stronger than the per-operation/target uniqueness rule.
-- An uncertain mutation continues to own it until reconciliation or an explicit acknowledgment.
create table public.console_job_mutation_guard (
  singleton boolean primary key default true check (singleton),
  job_id uuid unique references public.console_jobs(id) on delete restrict
);
insert into public.console_job_mutation_guard(singleton,job_id) values(true,null);

create unique index console_jobs_active_target on public.console_jobs(operation,target) where state in ('queued','running');
create index console_jobs_page on public.console_jobs(requested_at desc,id desc);

alter table public.console_jobs enable row level security;
alter table public.console_job_mutation_guard enable row level security;
revoke all on public.console_jobs,public.console_job_mutation_guard from public,anon,authenticated;
grant select,insert,update,delete on public.console_jobs to service_role;
grant select,insert,update on public.console_job_mutation_guard to service_role;
create policy console_jobs_service on public.console_jobs to service_role using(true) with check(true);
create policy console_job_guard_service on public.console_job_mutation_guard to service_role using(true) with check(true);

create function public.console_job_enqueue(request_key uuid,input_fingerprint text,operation_name text,target_name text,source_sha text default null)
returns jsonb language plpgsql security invoker set search_path='' set statement_timeout='5s' as $$
declare current_job public.console_jobs; guard_job uuid; mutation boolean; moment timestamptz:=clock_timestamp();
begin
  if request_key is null or input_fingerprint is null or input_fingerprint !~ '^[0-9a-f]{64}$'
    or operation_name not in ('diagnostics','checks','migrations.check','migrations.apply','deploy.preview','deploy.production')
    or target_name is null or char_length(btrim(target_name)) not between 1 and 160 or octet_length(target_name)>640 or target_name ~ '[[:cntrl:]]'
    or (source_sha is not null and source_sha !~ '^[0-9a-f]{7,64}$') then
    return jsonb_build_object('outcome','invalid');
  end if;
  perform pg_advisory_xact_lock(763541,2);
  insert into public.console_job_mutation_guard(singleton,job_id) values(true,null) on conflict(singleton) do nothing;
  -- Retention is intentionally narrow: only terminal diagnostics/tests, never uncertain or
  -- migration/deployment receipts. Inactive deployments may retain these longer than 30 days.
  delete from public.console_jobs where operation in ('diagnostics','checks') and state in ('succeeded','failed') and updated_at < moment-interval '30 days';
  select * into current_job from public.console_jobs j where j.request_key=console_job_enqueue.request_key;
  if found then
    if current_job.input_fingerprint<>input_fingerprint then return jsonb_build_object('outcome','key_conflict');end if;
    return jsonb_build_object('outcome','replay','job',to_jsonb(current_job));
  end if;
  if exists(select 1 from public.console_jobs j where j.operation=operation_name and j.target=btrim(target_name) and j.state in ('queued','running')) then
    return jsonb_build_object('outcome','active');
  end if;
  if (select count(*) from public.console_jobs where state in ('queued','running'))>=20 then return jsonb_build_object('outcome','capacity');end if;
  mutation:=operation_name in ('migrations.apply','deploy.preview','deploy.production');
  if mutation then
    select job_id into guard_job from public.console_job_mutation_guard where singleton for update;
    if guard_job is not null then return jsonb_build_object('outcome','mutation_busy');end if;
  end if;
  insert into public.console_jobs(request_key,input_fingerprint,operation,target,source_sha)
    values(request_key,input_fingerprint,operation_name,btrim(target_name),source_sha) returning * into current_job;
  if mutation then update public.console_job_mutation_guard set job_id=current_job.id where singleton;end if;
  return jsonb_build_object('outcome','enqueued','job',to_jsonb(current_job));
end;
$$;

create function public.console_job_claim(job_id uuid) returns jsonb
language plpgsql security invoker set search_path='' set statement_timeout='5s' as $$
declare current_job public.console_jobs;
begin
  select * into current_job from public.console_jobs j where j.id=console_job_claim.job_id for update;
  if not found then return jsonb_build_object('outcome','missing');end if;
  if current_job.state<>'queued' then return jsonb_build_object('outcome','not_claimed','job',to_jsonb(current_job));end if;
  update public.console_jobs set state='running',dispatch_token=gen_random_uuid(),updated_at=clock_timestamp()
    where id=current_job.id returning * into current_job;
  return jsonb_build_object('outcome','claimed','token',current_job.dispatch_token,'job',to_jsonb(current_job));
end;
$$;

create function public.console_job_publish(job_id uuid,claim_token uuid,completion_state text,result_value jsonb,provider_identity text default null,source_sha text default null)
returns jsonb language plpgsql security invoker set search_path='' set statement_timeout='5s' as $$
declare current_job public.console_jobs; mutation boolean;
begin
  if completion_state is null or completion_state not in ('succeeded','failed','uncertain') or result_value is null or jsonb_typeof(result_value)<>'object'
    or jsonb_typeof(result_value->'checks')<>'array' or jsonb_typeof(result_value->'summary')<>'string'
    or char_length(result_value->>'summary')>1000 or octet_length(result_value::text)>32768
    or (provider_identity is not null and (char_length(provider_identity)>256 or octet_length(provider_identity)>1024))
    or (source_sha is not null and source_sha !~ '^[0-9a-f]{7,64}$') then return jsonb_build_object('outcome','invalid');end if;
  if jsonb_array_length(result_value->'checks')>64 or exists(select 1 from jsonb_array_elements(result_value->'checks') c
    where jsonb_typeof(c)<>'object' or not (c ? 'name' and c ? 'state' and c ? 'detail') or (select count(*) from jsonb_object_keys(c))<>3
      or jsonb_typeof(c->'name')<>'string' or char_length(c->>'name') not between 1 and 120 or c->>'state' not in ('passed','failed','skipped','unavailable')
      or jsonb_typeof(c->'detail')<>'string' or char_length(c->>'detail')>500) then return jsonb_build_object('outcome','invalid');end if;
  select * into current_job from public.console_jobs j where j.id=console_job_publish.job_id for update;
  if not found then return jsonb_build_object('outcome','missing');end if;
  -- The original claim token can reconcile an uncertain provider result, but claim() can never
  -- redispatch it. No other token can publish or release its mutation guard.
  if current_job.state not in ('running','uncertain') or current_job.dispatch_token is distinct from claim_token then
    return jsonb_build_object('outcome','stale','job',to_jsonb(current_job));
  end if;
  update public.console_jobs set state=completion_state,dispatch_token=case when completion_state='uncertain' then current_job.dispatch_token else null end,result=result_value,summary=result_value->>'summary',check_count=jsonb_array_length(result_value->'checks'),provider_id=coalesce(provider_identity,current_job.provider_id),
    source_sha=coalesce(console_job_publish.source_sha,console_jobs.source_sha),updated_at=clock_timestamp()
    where id=current_job.id returning * into current_job;
  mutation:=current_job.operation in ('migrations.apply','deploy.preview','deploy.production');
  if mutation and completion_state<>'uncertain' then
    update public.console_job_mutation_guard set job_id=null where singleton and console_job_mutation_guard.job_id=current_job.id;
  end if;
  return jsonb_build_object('outcome','published','job',to_jsonb(current_job));
end;
$$;

create function public.console_job_acknowledge_uncertain(job_id uuid) returns jsonb
language plpgsql security invoker set search_path='' set statement_timeout='5s' as $$
declare current_job public.console_jobs;
begin
  perform pg_advisory_xact_lock(763541,2);
  select * into current_job from public.console_jobs j where j.id=console_job_acknowledge_uncertain.job_id for update;
  if not found then return jsonb_build_object('outcome','missing');end if;
  if current_job.state<>'uncertain' or current_job.operation not in ('migrations.apply','deploy.preview','deploy.production') then
    return jsonb_build_object('outcome','not_uncertain','job',to_jsonb(current_job));
  end if;
  update public.console_jobs set unresolved_acknowledged_at=clock_timestamp(),updated_at=clock_timestamp() where id=current_job.id returning * into current_job;
  update public.console_job_mutation_guard set job_id=null where singleton and console_job_mutation_guard.job_id=current_job.id;
  return jsonb_build_object('outcome','acknowledged','job',to_jsonb(current_job));
end;
$$;

revoke all on function public.console_job_enqueue(uuid,text,text,text,text),public.console_job_claim(uuid),public.console_job_publish(uuid,uuid,text,jsonb,text,text),public.console_job_acknowledge_uncertain(uuid) from public,anon,authenticated;
grant execute on function public.console_job_enqueue(uuid,text,text,text,text),public.console_job_claim(uuid),public.console_job_publish(uuid,uuid,text,jsonb,text,text),public.console_job_acknowledge_uncertain(uuid) to service_role;
