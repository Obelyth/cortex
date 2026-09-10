-- Forward repair for console job recovery. Every function keeps its signature, invoker security,
-- empty search path and 5-second statement timeout. Applied bytes are never rewritten.
--
-- 1. A queued receipt without an execution context (the local diagnostic, or a legacy mutation
--    admitted through the plain path) had no operator exit: mark_uncertain answered not_running,
--    and the row held its (operation,target) slot for good. Any queued row can now be fenced.
-- 2. Acknowledgment accepts any uncertain receipt. Only a mutation touches the guard, and
--    last_unresolved_id records the job whose guard this acknowledgment actually released.
-- 3. A terminal publication clears last_unresolved_id when it names the job that reconciled.
-- 4. A NULL claim token never publishes: "is distinct from" treats NULL and NULL as equal.
-- 5. A late provider "running" for an acknowledged receipt whose target a later command holds
--    answers conflict on the still-uncertain row instead of raising unique_violation.
-- 6. The active admission refusal names the receipt that holds the slot.

-- (6) Same admission rules; the active refusal carries the blocking receipt.
create or replace function public.console_job_enqueue(request_key uuid,input_fingerprint text,operation_name text,target_name text,source_sha text default null)
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
  -- Name the receipt holding the slot so an operator can open it and, when the request that
  -- queued it never claimed it, fence it explicitly instead of clicking into the same refusal.
  select * into current_job from public.console_jobs j where j.operation=operation_name and j.target=btrim(target_name) and j.state in ('queued','running') limit 1;
  if found then return jsonb_build_object('outcome','active','job',to_jsonb(current_job));end if;
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

-- (1) Any queued row can be fenced. A queued row never carries claim material, so clearing the
-- dispatch token and owner on a local row is explicit rather than consequential; a running row
-- still goes through the v1 rules (local diagnostics fence their token, provider work keeps it).
create or replace function public.console_job_mark_uncertain(job_id uuid) returns jsonb
language plpgsql security invoker set search_path='' set statement_timeout='5s' as $$
declare current_job public.console_jobs; mutation boolean; provider_request boolean; message text; detail text;
begin
  select * into current_job from public.console_jobs j where j.id=console_job_mark_uncertain.job_id for update;
  if not found then return jsonb_build_object('outcome','missing'); end if;
  if current_job.state<>'queued' then return public.console_job_mark_uncertain_v1(job_id); end if;
  mutation:=current_job.operation in ('migrations.apply','deploy.preview','deploy.production');
  provider_request:=current_job.execution_context is not null;
  message:=case when mutation
    then 'The request that queued this job never claimed it · nothing was dispatched · acknowledge to release the mutation slot'
    else 'The request that queued this job never claimed it · nothing was dispatched · a new request can proceed' end;
  detail:='No dispatch claim was recorded before explicit recovery: the request that queued this job never claimed it, so nothing was sent to a worker or provider. The receipt is retained; this is not cancellation or success.'
    ||case when mutation then ' The mutation guard remains until explicit unresolved acknowledgment.' else '' end;
  update public.console_jobs
    set state='uncertain',
        dispatch_token=case when provider_request then current_job.dispatch_token else null end,
        claim_owner=case when provider_request then current_job.claim_owner else null end,
        result=jsonb_build_object('summary',message,'checks',jsonb_build_array(jsonb_build_object(
          'name',case when current_job.operation='diagnostics' then 'diagnostic execution' when provider_request then 'provider execution' else current_job.operation end,
          'state','unavailable','detail',detail))),
        summary=message,check_count=1,updated_at=clock_timestamp()
    where id=current_job.id returning * into current_job;
  return jsonb_build_object('outcome','marked_uncertain','job',to_jsonb(current_job));
end;$$;

-- (2) Acknowledgment stamps any uncertain receipt. The guard is released only when this receipt
-- holds it, and last_unresolved_id is set by that release, so acknowledging an older receipt
-- again cannot displace a newer unresolved mutation. Diagnostics never enter the guard.
create or replace function public.console_job_acknowledge_uncertain(job_id uuid) returns jsonb
language plpgsql security invoker set search_path='' set statement_timeout='5s' as $$
declare current_job public.console_jobs;
begin
  perform pg_advisory_xact_lock(763541,2);
  select * into current_job from public.console_jobs j where j.id=console_job_acknowledge_uncertain.job_id for update;
  if not found then return jsonb_build_object('outcome','missing');end if;
  if current_job.state<>'uncertain' then return jsonb_build_object('outcome','not_uncertain','job',to_jsonb(current_job));end if;
  update public.console_jobs set unresolved_acknowledged_at=clock_timestamp(),updated_at=clock_timestamp() where id=current_job.id returning * into current_job;
  if current_job.operation in ('migrations.apply','deploy.preview','deploy.production') then
    update public.console_job_mutation_guard set job_id=null,last_unresolved_id=current_job.id
      where singleton and console_job_mutation_guard.job_id=current_job.id;
  end if;
  return jsonb_build_object('outcome','acknowledged','job',to_jsonb(current_job));
end;$$;

-- (3)(4) Same envelope validation and token fence as before, plus: a NULL token is invalid, and a
-- terminal result clears last_unresolved_id when it names this job. Parameter references are
-- qualified with the v1 name this function has carried since 20260908205956.
create or replace function public.console_job_publish_v1(job_id uuid,claim_token uuid,completion_state text,result_value jsonb,provider_identity text default null,source_sha text default null)
returns jsonb language plpgsql security invoker set search_path='' set statement_timeout='5s' as $$
declare current_job public.console_jobs; mutation boolean;
begin
  if claim_token is null or completion_state is null or completion_state not in ('succeeded','failed','uncertain') or result_value is null or jsonb_typeof(result_value)<>'object'
    or jsonb_typeof(result_value->'checks')<>'array' or jsonb_typeof(result_value->'summary')<>'string'
    or char_length(result_value->>'summary')>1000 or octet_length(result_value::text)>32768
    or (provider_identity is not null and (char_length(provider_identity)>256 or octet_length(provider_identity)>1024))
    or (source_sha is not null and source_sha !~ '^[0-9a-f]{7,64}$') then return jsonb_build_object('outcome','invalid');end if;
  if jsonb_array_length(result_value->'checks')>64 or exists(select 1 from jsonb_array_elements(result_value->'checks') c
    where jsonb_typeof(c)<>'object' or not (c ? 'name' and c ? 'state' and c ? 'detail') or (select count(*) from jsonb_object_keys(c))<>3
      or jsonb_typeof(c->'name')<>'string' or char_length(c->>'name') not between 1 and 120 or c->>'state' not in ('passed','failed','skipped','unavailable')
      or jsonb_typeof(c->'detail')<>'string' or char_length(c->>'detail')>500) then return jsonb_build_object('outcome','invalid');end if;
  select * into current_job from public.console_jobs j where j.id=console_job_publish_v1.job_id for update;
  if not found then return jsonb_build_object('outcome','missing');end if;
  -- The original claim token can reconcile an uncertain provider result, but claim() can never
  -- redispatch it. No other token can publish or release its mutation guard.
  if current_job.state not in ('running','uncertain') or current_job.dispatch_token is distinct from claim_token then
    return jsonb_build_object('outcome','stale','job',to_jsonb(current_job));
  end if;
  update public.console_jobs set state=completion_state,dispatch_token=case when completion_state='uncertain' then current_job.dispatch_token else null end,result=result_value,summary=result_value->>'summary',check_count=jsonb_array_length(result_value->'checks'),provider_id=coalesce(provider_identity,current_job.provider_id),
    source_sha=coalesce(console_job_publish_v1.source_sha,console_jobs.source_sha),updated_at=clock_timestamp()
    where id=current_job.id returning * into current_job;
  mutation:=current_job.operation in ('migrations.apply','deploy.preview','deploy.production');
  if mutation and completion_state<>'uncertain' then
    update public.console_job_mutation_guard set job_id=null where singleton and console_job_mutation_guard.job_id=current_job.id;
  end if;
  -- A reconciled receipt is no longer the unresolved work a new mutation must name.
  if completion_state<>'uncertain' then
    update public.console_job_mutation_guard set last_unresolved_id=null where singleton and console_job_mutation_guard.last_unresolved_id=current_job.id;
  end if;
  return jsonb_build_object('outcome','published','job',to_jsonb(current_job));
end;
$$;

-- (5) The public wrapper keeps its identity checks and running acceptance. Before a "running"
-- status can put an uncertain receipt back into the active index, it checks for the successor
-- that console_jobs_active_target would otherwise collide with, records the observation on the
-- still-uncertain receipt under the same token fence, and answers conflict.
create or replace function public.console_job_publish(job_id uuid,claim_token uuid,completion_state text,result_value jsonb,provider_identity text default null,source_sha text default null)
returns jsonb language plpgsql security invoker set search_path='' set statement_timeout='5s' as $$
declare current_job public.console_jobs; successor public.console_jobs; result jsonb; note text;
begin
  select * into current_job from public.console_jobs j where j.id=console_job_publish.job_id for update;
  if not found then return jsonb_build_object('outcome','missing');end if;
  if (current_job.provider_id is not null and provider_identity is not null and current_job.provider_id<>provider_identity)
    or (current_job.execution_context is not null and source_sha is not null and current_job.source_sha<>source_sha)
    or (completion_state='running' and provider_identity is null) then return jsonb_build_object('outcome','invalid');end if;
  if completion_state='running' and current_job.state='uncertain' then
    select * into successor from public.console_jobs j
      where j.operation=current_job.operation and j.target=current_job.target and j.id<>current_job.id and j.state in ('queued','running') limit 1;
    if found then
      if claim_token is null or current_job.dispatch_token is distinct from claim_token then
        return jsonb_build_object('outcome','stale','job',to_jsonb(current_job));
      end if;
      note:='Provider still reports this run in progress · a later '||current_job.operation||' command now owns '||current_job.target||' · this receipt stays uncertain';
      update public.console_jobs
        set result=jsonb_build_object('summary',note,'checks',jsonb_build_array(jsonb_build_object(
              'name','provider status','state','unavailable',
              'detail','The provider reported this run still in progress after the receipt was acknowledged and receipt '||successor.id||' took its target. This receipt cannot return to running; follow the provider run directly. The later command may duplicate its work.'))),
            summary=note,check_count=1,provider_id=coalesce(provider_identity,current_job.provider_id),updated_at=clock_timestamp()
        where id=current_job.id returning * into current_job;
      return jsonb_build_object('outcome','conflict','job',to_jsonb(current_job));
    end if;
  end if;
  result:=public.console_job_publish_v1(job_id,claim_token,case when completion_state='running' then 'uncertain' else completion_state end,result_value,provider_identity,source_sha);
  if result->>'outcome'='published' and completion_state='running' then
    update public.console_jobs set state='running' where id=job_id returning * into current_job;
    return jsonb_build_object('outcome','published','job',to_jsonb(current_job));
  end if;
  return result;
end;$$;

-- (4) The observer path refuses a NULL claim token before it reaches the publisher.
create or replace function public.console_job_reconcile_publish(job_id uuid,claim_token uuid,poll_owner uuid,completion_state text,result_value jsonb,provider_identity text default null)
returns jsonb language plpgsql security invoker set search_path='' set statement_timeout='5s' as $$
declare current_job public.console_jobs;
begin
  if claim_token is null then return jsonb_build_object('outcome','invalid');end if;
  select * into current_job from public.console_jobs j where j.id=console_job_reconcile_publish.job_id for update;
  if not found then return jsonb_build_object('outcome','missing');end if;
  if poll_owner is null or current_job.poll_token is distinct from poll_owner or current_job.poll_expires_at is null or current_job.poll_expires_at<=clock_timestamp() then
    return jsonb_build_object('outcome','stale','job',to_jsonb(current_job));
  end if;
  return public.console_job_publish(job_id,claim_token,completion_state,result_value,provider_identity,null);
end;$$;

revoke all on function public.console_job_enqueue(uuid,text,text,text,text),public.console_job_mark_uncertain(uuid),public.console_job_acknowledge_uncertain(uuid),public.console_job_publish_v1(uuid,uuid,text,jsonb,text,text),public.console_job_publish(uuid,uuid,text,jsonb,text,text),public.console_job_reconcile_publish(uuid,uuid,uuid,text,jsonb,text) from public,anon,authenticated;
grant execute on function public.console_job_enqueue(uuid,text,text,text,text),public.console_job_mark_uncertain(uuid),public.console_job_acknowledge_uncertain(uuid),public.console_job_publish_v1(uuid,uuid,text,jsonb,text,text),public.console_job_publish(uuid,uuid,text,jsonb,text,text),public.console_job_reconcile_publish(uuid,uuid,uuid,text,jsonb,text) to service_role;
