-- Bind an execution claim to the request that received it. This is a forward migration:
-- installations that already applied 20260908160000_console_jobs.sql keep every receipt.
alter table public.console_jobs add column if not exists claim_owner uuid;

create function public.console_job_claim(job_id uuid, owner_token uuid) returns jsonb
language plpgsql security invoker set search_path='' set statement_timeout='5s' as $$
declare current_job public.console_jobs;
begin
  if owner_token is null then return jsonb_build_object('outcome','invalid'); end if;
  select * into current_job from public.console_jobs j where j.id=console_job_claim.job_id for update;
  if not found then return jsonb_build_object('outcome','missing'); end if;

  if current_job.state='queued' then
    update public.console_jobs
      set state='running',dispatch_token=gen_random_uuid(),claim_owner=owner_token,updated_at=clock_timestamp()
      where id=current_job.id returning * into current_job;
    return jsonb_build_object('outcome','claimed','token',current_job.dispatch_token,'job',to_jsonb(current_job));
  end if;

  -- Retrying a claim whose response was lost returns the original token only to the same
  -- request owner. It does not dispatch a second worker.
  if current_job.state='running' and current_job.claim_owner=owner_token then
    return jsonb_build_object('outcome','claimed','token',current_job.dispatch_token,'job',to_jsonb(current_job));
  end if;

  return jsonb_build_object('outcome','not_claimed','job',to_jsonb(current_job));
end;
$$;

-- Explicit operator recovery for a caller that vanished after its claim committed. There is no
-- age inference. Local diagnostics fence late publication; provider tokens stay available for
-- reconciliation, and mutation guards remain untouched until reconciliation or acknowledgement.
create function public.console_job_mark_uncertain(job_id uuid) returns jsonb
language plpgsql security invoker set search_path='' set statement_timeout='5s' as $$
declare current_job public.console_jobs; local_diagnostic boolean;
begin
  select * into current_job from public.console_jobs j where j.id=console_job_mark_uncertain.job_id for update;
  if not found then return jsonb_build_object('outcome','missing'); end if;
  if current_job.state<>'running' then
    return jsonb_build_object('outcome','not_running','job',to_jsonb(current_job));
  end if;
  local_diagnostic:=current_job.operation='diagnostics';
  update public.console_jobs
    set state='uncertain',
        -- A local diagnostic has no external completion to reconcile, so fence any late
        -- publisher. Provider work retains its claim token and the mutation guard.
        dispatch_token=case when local_diagnostic then null else current_job.dispatch_token end,
        claim_owner=case when local_diagnostic then null else current_job.claim_owner end,
        result=jsonb_build_object(
          'checks',jsonb_build_array(jsonb_build_object(
            'name',case when local_diagnostic then 'diagnostic execution' else current_job.operation end,
            'state','unavailable',
            'detail',case when local_diagnostic
              then 'The diagnostic worker response was lost; no external operation was dispatched.'
              else 'The worker response was lost; reconcile the provider before retrying.' end
          )),
          'summary',case when local_diagnostic
            then 'Diagnostic outcome uncertain · run a new explicitly labeled diagnostic if needed'
            else 'Outcome uncertain · reconcile the provider before retrying' end
        ),
        summary=case when local_diagnostic
          then 'Diagnostic outcome uncertain · run a new explicitly labeled diagnostic if needed'
          else 'Outcome uncertain · reconcile the provider before retrying' end,
        check_count=1,updated_at=clock_timestamp()
    where id=current_job.id returning * into current_job;
  return jsonb_build_object('outcome','marked_uncertain','job',to_jsonb(current_job));
end;
$$;

revoke all on function public.console_job_claim(uuid,uuid),public.console_job_mark_uncertain(uuid) from public,anon,authenticated;
grant execute on function public.console_job_claim(uuid,uuid),public.console_job_mark_uncertain(uuid) to service_role;
