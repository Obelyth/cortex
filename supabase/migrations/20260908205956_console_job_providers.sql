-- Optional provider execution. Existing receipts, owner claims and global mutation guard survive.
alter table public.console_jobs add column execution_context jsonb check(execution_context is null or (jsonb_typeof(execution_context)='object' and octet_length(execution_context::text)<=2048));
alter table public.console_jobs add column last_polled_at timestamptz;
alter table public.console_jobs add column poll_token uuid;
alter table public.console_job_mutation_guard add column last_unresolved_id uuid references public.console_jobs(id) on delete restrict;

create function public.console_job_enqueue_provider(request_key uuid,input_fingerprint text,operation_name text,target_name text,source_sha text,execution_value jsonb,expires_at timestamptz,unresolved_id uuid default null)
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
    update public.console_jobs set execution_context=execution_value where id=(admission_result->'job'->>'id')::uuid returning * into prior;
    return jsonb_build_object('outcome','enqueued','job',to_jsonb(prior));
  end if;
  return admission_result;
end;$$;

-- Reuse the reviewed envelope validation and terminal guard release. Running acceptance keeps
-- the dispatch token; provider identity/source cannot change under a stored execution context.
alter function public.console_job_publish(uuid,uuid,text,jsonb,text,text) rename to console_job_publish_v1;
-- PL/pgSQL's parameter qualification follows the function name, not its OID.
do $$ begin execute replace(pg_get_functiondef('public.console_job_publish_v1(uuid,uuid,text,jsonb,text,text)'::regprocedure),'console_job_publish.','console_job_publish_v1.');end $$;
create function public.console_job_publish(job_id uuid,claim_token uuid,completion_state text,result_value jsonb,provider_identity text default null,source_sha text default null)
returns jsonb language plpgsql security invoker set search_path='' set statement_timeout='5s' as $$
declare current_job public.console_jobs; result jsonb;
begin
  select * into current_job from public.console_jobs j where j.id=console_job_publish.job_id for update;
  if not found then return jsonb_build_object('outcome','missing');end if;
  if (current_job.provider_id is not null and provider_identity is not null and current_job.provider_id<>provider_identity)
    or (current_job.execution_context is not null and source_sha is not null and current_job.source_sha<>source_sha)
    or (completion_state='running' and provider_identity is null) then return jsonb_build_object('outcome','invalid');end if;
  result:=public.console_job_publish_v1(job_id,claim_token,case when completion_state='running' then 'uncertain' else completion_state end,result_value,provider_identity,source_sha);
  if result->>'outcome'='published' and completion_state='running' then
    update public.console_jobs set state='running' where id=job_id returning * into current_job;
    return jsonb_build_object('outcome','published','job',to_jsonb(current_job));
  end if;
  return result;
end;$$;

-- Explicit recovery also fences an admitted request whose caller died before claim. The same
-- row lock decides the race: a claim that already won keeps its original reconciliation token.
alter function public.console_job_mark_uncertain(uuid) rename to console_job_mark_uncertain_v1;
do $$ begin execute replace(pg_get_functiondef('public.console_job_mark_uncertain_v1(uuid)'::regprocedure),'console_job_mark_uncertain.','console_job_mark_uncertain_v1.');end $$;
create function public.console_job_mark_uncertain(job_id uuid) returns jsonb
language plpgsql security invoker set search_path='' set statement_timeout='5s' as $$
declare current_job public.console_jobs;
begin
  select * into current_job from public.console_jobs j where j.id=console_job_mark_uncertain.job_id for update;
  if found and current_job.state='queued' and current_job.execution_context is not null then
    update public.console_jobs set state='uncertain',updated_at=clock_timestamp(),check_count=1,
      summary='Unclaimed request explicitly fenced · unresolved acknowledgment required for another mutation',
      result=jsonb_build_object('summary','Unclaimed request explicitly fenced · unresolved acknowledgment required for another mutation',
        'checks',jsonb_build_array(jsonb_build_object('name','provider execution','state','unavailable',
          'detail','No dispatch claim won before explicit recovery. The immutable receipt and mutation guard remain; this is not provider cancellation.')))
      where id=current_job.id returning * into current_job;
    return jsonb_build_object('outcome','marked_uncertain','job',to_jsonb(current_job));
  end if;
  return public.console_job_mark_uncertain_v1(job_id);
end;$$;
revoke all on function public.console_job_mark_uncertain(uuid) from public,anon,authenticated;
grant execute on function public.console_job_mark_uncertain(uuid) to service_role;

create function public.console_job_reconcile_claim(job_id uuid) returns jsonb
language plpgsql security invoker set search_path='' set statement_timeout='5s' as $$
declare current_job public.console_jobs;
begin
  select * into current_job from public.console_jobs j where j.id=console_job_reconcile_claim.job_id for update;
  if not found or current_job.execution_context is null or (current_job.dispatch_token is null and current_job.provider_id is null) or current_job.state='queued'
    or current_job.last_polled_at>clock_timestamp()-interval '5 seconds' then return jsonb_build_object('outcome','not_claimed');end if;
  update public.console_jobs set last_polled_at=clock_timestamp(),poll_token=gen_random_uuid() where id=current_job.id returning * into current_job;
  return jsonb_build_object('outcome','claimed','job',to_jsonb(current_job),'token',current_job.dispatch_token,'pollToken',current_job.poll_token,'execution',current_job.execution_context);
end;$$;

create function public.console_job_reconcile_publish(job_id uuid,claim_token uuid,poll_owner uuid,completion_state text,result_value jsonb,provider_identity text default null)
returns jsonb language plpgsql security invoker set search_path='' set statement_timeout='5s' as $$
declare current_job public.console_jobs;
begin
  select * into current_job from public.console_jobs j where j.id=console_job_reconcile_publish.job_id for update;
  if not found then return jsonb_build_object('outcome','missing');end if;
  if poll_owner is null or current_job.poll_token is distinct from poll_owner then return jsonb_build_object('outcome','stale','job',to_jsonb(current_job));end if;
  return public.console_job_publish(job_id,claim_token,completion_state,result_value,provider_identity,null);
end;$$;

alter function public.console_job_acknowledge_uncertain(uuid) rename to console_job_acknowledge_uncertain_v1;
do $$ begin execute replace(pg_get_functiondef('public.console_job_acknowledge_uncertain_v1(uuid)'::regprocedure),'console_job_acknowledge_uncertain.','console_job_acknowledge_uncertain_v1.');end $$;
create function public.console_job_acknowledge_uncertain(job_id uuid) returns jsonb
language plpgsql security invoker set search_path='' set statement_timeout='5s' as $$
declare result jsonb;
begin
  perform pg_advisory_xact_lock(763541,2);
  result:=public.console_job_acknowledge_uncertain_v1(job_id);
  if result->>'outcome'='acknowledged' then update public.console_job_mutation_guard set last_unresolved_id=console_job_acknowledge_uncertain.job_id where singleton;end if;
  return result;
end;$$;

-- A bounded scalar envelope avoids gateway row caps. Reading never creates/upgrades a ledger.
create function public.console_job_migration_ledger() returns jsonb
language plpgsql stable security invoker set search_path='' set statement_timeout='5s' as $$
declare result jsonb; row_count integer; invalid boolean;
begin
  if to_regclass('public.schema_migrations') is null then return jsonb_build_object('state','absent','rows','[]'::jsonb);end if;
  if not exists(select 1 from information_schema.columns where table_schema='public' and table_name='schema_migrations' and column_name='checksum') then return jsonb_build_object('state','legacy','rows','[]'::jsonb);end if;
  execute 'select count(*),coalesce(bool_or(char_length(name)>255 or char_length(checksum)>64),false) from (select name,checksum from public.schema_migrations order by name limit 2001) s' into row_count,invalid;
  if row_count>2000 or invalid then raise exception 'migration ledger unavailable';end if;
  execute 'select coalesce(jsonb_agg(jsonb_build_object(''name'',name,''checksum'',checksum) order by name),''[]''::jsonb) from public.schema_migrations' into result;
  if octet_length(result::text)>524288 then raise exception 'migration ledger unavailable';end if;
  return jsonb_build_object('state','present','rows',result);
end;$$;

revoke all on function public.console_job_enqueue_provider(uuid,text,text,text,text,jsonb,timestamptz,uuid),public.console_job_publish(uuid,uuid,text,jsonb,text,text),public.console_job_reconcile_claim(uuid),public.console_job_reconcile_publish(uuid,uuid,uuid,text,jsonb,text),public.console_job_acknowledge_uncertain(uuid),public.console_job_migration_ledger() from public,anon,authenticated;
grant execute on function public.console_job_enqueue_provider(uuid,text,text,text,text,jsonb,timestamptz,uuid),public.console_job_publish(uuid,uuid,text,jsonb,text,text),public.console_job_reconcile_claim(uuid),public.console_job_reconcile_publish(uuid,uuid,uuid,text,jsonb,text),public.console_job_acknowledge_uncertain(uuid),public.console_job_migration_ledger() to service_role;
