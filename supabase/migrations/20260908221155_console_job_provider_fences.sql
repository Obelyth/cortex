-- Forward repair: retain immutable intent expiry and protect an active read-only observer.
-- Unknown legacy queued provider expiry is deliberately not backfilled from a guessed time.
alter table public.console_jobs add column intent_expires_at timestamptz;
alter table public.console_jobs add column poll_expires_at timestamptz;

create or replace function public.console_job_enqueue_provider(request_key uuid,input_fingerprint text,operation_name text,target_name text,source_sha text,execution_value jsonb,expires_at timestamptz,unresolved_id uuid default null)
returns jsonb language plpgsql security invoker set search_path='' set statement_timeout='5s' as $$
declare prior public.console_jobs; admission_result jsonb; previous_id uuid;
begin
  perform pg_advisory_xact_lock(763541,2);
  select * into prior from public.console_jobs j where j.request_key=console_job_enqueue_provider.request_key;
  if found then
    if prior.input_fingerprint<>input_fingerprint then return jsonb_build_object('outcome','key_conflict');end if;
    return jsonb_build_object('outcome','replay','job',to_jsonb(prior));
  end if;
  if expires_at is null or expires_at<=clock_timestamp() or expires_at>clock_timestamp()+interval '5 minutes'
    or source_sha is null or source_sha !~ '^[a-f0-9]{40}$' or operation_name='diagnostics'
    or execution_value is null or jsonb_typeof(execution_value)<>'object' or octet_length(execution_value::text)>2048
    or not(execution_value ?& array['provider','repository','branch','project','team','pendingDigest'])
    or (select count(*) from jsonb_object_keys(execution_value))<>6
    or execution_value->>'provider' not in ('github','vercel')
    or jsonb_typeof(execution_value->'repository')<>'string' or jsonb_typeof(execution_value->'branch')<>'string'
    then return jsonb_build_object('outcome','conflict');end if;
  if operation_name in ('migrations.apply','deploy.preview','deploy.production') then
    select last_unresolved_id into previous_id from public.console_job_mutation_guard where singleton;
    if previous_id is distinct from unresolved_id then return jsonb_build_object('outcome','conflict');end if;
  end if;
  admission_result:=public.console_job_enqueue(request_key,input_fingerprint,operation_name,target_name,source_sha);
  if admission_result->>'outcome'='enqueued' then
    update public.console_jobs set execution_context=execution_value,intent_expires_at=expires_at
      where id=(admission_result->'job'->>'id')::uuid returning * into prior;
    return jsonb_build_object('outcome','enqueued','job',to_jsonb(prior));
  end if;
  return admission_result;
end;$$;

-- Both public claim signatures enforce the saved expiry after acquiring the row lock.
create or replace function public.console_job_claim(job_id uuid) returns jsonb
language plpgsql security invoker set search_path='' set statement_timeout='5s' as $$
declare current_job public.console_jobs;
begin
  select * into current_job from public.console_jobs j where j.id=console_job_claim.job_id for update;
  if not found then return jsonb_build_object('outcome','missing');end if;
  if current_job.state<>'queued' or (current_job.execution_context is not null and
    (current_job.intent_expires_at is null or current_job.intent_expires_at<=clock_timestamp())) then
    return jsonb_build_object('outcome','not_claimed','job',to_jsonb(current_job));
  end if;
  update public.console_jobs set state='running',dispatch_token=gen_random_uuid(),updated_at=clock_timestamp()
    where id=current_job.id returning * into current_job;
  return jsonb_build_object('outcome','claimed','token',current_job.dispatch_token,'job',to_jsonb(current_job));
end;$$;

create or replace function public.console_job_claim(job_id uuid,owner_token uuid) returns jsonb
language plpgsql security invoker set search_path='' set statement_timeout='5s' as $$
declare current_job public.console_jobs;
begin
  if owner_token is null then return jsonb_build_object('outcome','invalid');end if;
  select * into current_job from public.console_jobs j where j.id=console_job_claim.job_id for update;
  if not found then return jsonb_build_object('outcome','missing');end if;
  if current_job.state='queued' then
    if current_job.execution_context is not null and (current_job.intent_expires_at is null or current_job.intent_expires_at<=clock_timestamp()) then
      return jsonb_build_object('outcome','not_claimed','job',to_jsonb(current_job));
    end if;
    update public.console_jobs set state='running',dispatch_token=gen_random_uuid(),claim_owner=owner_token,updated_at=clock_timestamp()
      where id=current_job.id returning * into current_job;
    return jsonb_build_object('outcome','claimed','token',current_job.dispatch_token,'job',to_jsonb(current_job));
  end if;
  -- A claim that already won may recover its original token, even after intent expiry.
  if current_job.state='running' and current_job.claim_owner=owner_token then
    return jsonb_build_object('outcome','claimed','token',current_job.dispatch_token,'job',to_jsonb(current_job));
  end if;
  return jsonb_build_object('outcome','not_claimed','job',to_jsonb(current_job));
end;$$;

create or replace function public.console_job_reconcile_claim(job_id uuid) returns jsonb
language plpgsql security invoker set search_path='' set statement_timeout='5s' as $$
declare current_job public.console_jobs;
begin
  select * into current_job from public.console_jobs j where j.id=console_job_reconcile_claim.job_id for update;
  if not found or current_job.execution_context is null or (current_job.dispatch_token is null and current_job.provider_id is null) or current_job.state='queued'
    or current_job.last_polled_at>clock_timestamp()-interval '5 seconds'
    or (current_job.poll_token is not null and current_job.poll_expires_at>clock_timestamp()) then
    return jsonb_build_object('outcome','not_claimed');
  end if;
  update public.console_jobs set last_polled_at=clock_timestamp(),poll_token=gen_random_uuid(),poll_expires_at=clock_timestamp()+interval '100 seconds'
    where id=current_job.id returning * into current_job;
  return jsonb_build_object('outcome','claimed','job',to_jsonb(current_job),'token',current_job.dispatch_token,'pollToken',current_job.poll_token,'execution',current_job.execution_context);
end;$$;

create or replace function public.console_job_reconcile_publish(job_id uuid,claim_token uuid,poll_owner uuid,completion_state text,result_value jsonb,provider_identity text default null)
returns jsonb language plpgsql security invoker set search_path='' set statement_timeout='5s' as $$
declare current_job public.console_jobs;
begin
  select * into current_job from public.console_jobs j where j.id=console_job_reconcile_publish.job_id for update;
  if not found then return jsonb_build_object('outcome','missing');end if;
  if poll_owner is null or current_job.poll_token is distinct from poll_owner or current_job.poll_expires_at is null or current_job.poll_expires_at<=clock_timestamp() then
    return jsonb_build_object('outcome','stale','job',to_jsonb(current_job));
  end if;
  return public.console_job_publish(job_id,claim_token,completion_state,result_value,provider_identity,null);
end;$$;

create function public.console_job_reconcile_release(job_id uuid,poll_owner uuid) returns jsonb
language plpgsql security invoker set search_path='' set statement_timeout='5s' as $$
begin
  update public.console_jobs set poll_token=null,poll_expires_at=null
    where id=console_job_reconcile_release.job_id and poll_token=poll_owner;
  return jsonb_build_object('released',found);
end;$$;

revoke all on function public.console_job_enqueue_provider(uuid,text,text,text,text,jsonb,timestamptz,uuid),public.console_job_claim(uuid),public.console_job_claim(uuid,uuid),public.console_job_reconcile_claim(uuid),public.console_job_reconcile_publish(uuid,uuid,uuid,text,jsonb,text),public.console_job_reconcile_release(uuid,uuid) from public,anon,authenticated;
grant execute on function public.console_job_enqueue_provider(uuid,text,text,text,text,jsonb,timestamptz,uuid),public.console_job_claim(uuid),public.console_job_claim(uuid,uuid),public.console_job_reconcile_claim(uuid),public.console_job_reconcile_publish(uuid,uuid,uuid,text,jsonb,text),public.console_job_reconcile_release(uuid,uuid) to service_role;
