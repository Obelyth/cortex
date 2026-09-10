-- Forward repair of 20260909041000_console_job_recovery_exits.sql. That file shipped in #162 and may
-- be applied anywhere by now, so its bytes are immutable; the two functions below replace the ones
-- it created, with the same signatures and the same security posture.
--
-- 7. A mutation is running only while the mutation guard names it. Acknowledgment released that
--    guard, so a late provider "running" for an acknowledged mutation re-takes the guard when it is
--    free (and stops naming this receipt as the unresolved work) and answers conflict, naming the
--    holder, when another mutation has it. Two mutations never run at once, whatever the provider
--    reports; a row the old wrapper left running beside a free guard is healed on its next status.
-- 8. Acknowledging a receipt that was fenced before any claim names nothing new as unresolved: a
--    row with no dispatch token never reached a worker or provider and cannot still finish.
--
-- Decision — "Mark lost response uncertain" on a running provider receipt whose provider is healthy:
-- the control is reachable for any running receipt, and the next status poll then reports "running"
-- on an uncertain row that never released its guard. That is a resumption, not a conflict. The row
-- returns to running under its original token, the guard it never released still names it, and the
-- receipt carries the provider's status; the publisher answers `resumed` so the caller can say so.
-- Keeping the row uncertain would invite an acknowledgment of a run the provider verifiably has in
-- progress, which is the one thing that can put a second mutation beside it. Conflict is reserved
-- for the two cases where returning to running would break an invariant: a later command owns the
-- target, or another mutation holds the guard. Both leave the row uncertain and name the holder.
-- Publish takes no advisory lock on purpose: acknowledge takes the advisory lock and then the job
-- row, and a publisher holding the row while waiting for the advisory lock would deadlock it.

-- (2)(8) Acknowledgment stamps any uncertain receipt. The guard is released only when this receipt
-- holds it, and last_unresolved_id is set by that release, so acknowledging an older receipt
-- again cannot displace a newer unresolved mutation. Diagnostics never enter the guard. A receipt
-- without a dispatch token was fenced before any claim: nothing was sent, so it is not unresolved
-- work and the release leaves whatever last_unresolved_id already names in place.
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
    update public.console_job_mutation_guard g
      set job_id=null,last_unresolved_id=case when current_job.dispatch_token is null then g.last_unresolved_id else current_job.id end
      where g.singleton and g.job_id=current_job.id;
  end if;
  return jsonb_build_object('outcome','acknowledged','job',to_jsonb(current_job));
end;$$;

-- (5)(7) The public wrapper keeps its identity checks and running acceptance. Before a "running"
-- status can put a receipt back into the active index it checks for the successor that
-- console_jobs_active_target would otherwise collide with, and before a mutation can be running it
-- takes the guard row lock — the same lock admission takes before handing the guard to a new
-- mutation — and checks that the guard is free or already names this receipt. Either holder is
-- recorded on the still-uncertain receipt under the same token fence and answered as conflict.
-- A receipt that was uncertain and is running again is answered as `resumed`, not `published`.
create or replace function public.console_job_publish(job_id uuid,claim_token uuid,completion_state text,result_value jsonb,provider_identity text default null,source_sha text default null)
returns jsonb language plpgsql security invoker set search_path='' set statement_timeout='5s' as $$
declare current_job public.console_jobs; holder public.console_jobs; guard_job uuid; mutation boolean; resumed boolean; result jsonb; note text; detail text;
begin
  select * into current_job from public.console_jobs j where j.id=console_job_publish.job_id for update;
  if not found then return jsonb_build_object('outcome','missing');end if;
  if (current_job.provider_id is not null and provider_identity is not null and current_job.provider_id<>provider_identity)
    or (current_job.execution_context is not null and source_sha is not null and current_job.source_sha<>source_sha)
    or (completion_state='running' and provider_identity is null) then return jsonb_build_object('outcome','invalid');end if;
  mutation:=current_job.operation in ('migrations.apply','deploy.preview','deploy.production');
  resumed:=current_job.state='uncertain';
  if completion_state='running' then
    if resumed then
      select * into holder from public.console_jobs j
        where j.operation=current_job.operation and j.target=current_job.target and j.id<>current_job.id and j.state in ('queued','running') limit 1;
      if found then
        note:='Provider still reports this run in progress · a later '||current_job.operation||' command now owns '||current_job.target||' · this receipt stays uncertain';
        detail:='The provider reported this run still in progress after the receipt was acknowledged and receipt '||holder.id||' took its target. This receipt cannot return to running; follow the provider run directly. The later command may duplicate its work.';
      end if;
    end if;
    if note is null and mutation then
      select g.job_id into guard_job from public.console_job_mutation_guard g where g.singleton for update;
      if guard_job is not null and guard_job<>current_job.id then
        select * into holder from public.console_jobs j where j.id=guard_job;
        note:='Provider still reports this run in progress · a later '||coalesce(holder.operation,'mutation')||' command now holds the mutation guard · this receipt stays uncertain';
        detail:='The provider reported this run still in progress after the receipt was acknowledged and receipt '||guard_job||' ('||coalesce(holder.operation,'mutation')||') took the mutation guard. This receipt cannot return to running while another mutation holds the guard; follow the provider run directly. Two mutations never run at once, so the later command may duplicate its work.';
      end if;
    end if;
    if note is not null then
      if claim_token is null or current_job.dispatch_token is distinct from claim_token then
        return jsonb_build_object('outcome','stale','job',to_jsonb(current_job));
      end if;
      update public.console_jobs
        set state='uncertain',
            result=jsonb_build_object('summary',note,'checks',jsonb_build_array(jsonb_build_object('name','provider status','state','unavailable','detail',detail))),
            summary=note,check_count=1,provider_id=coalesce(provider_identity,current_job.provider_id),updated_at=clock_timestamp()
        where id=current_job.id returning * into current_job;
      return jsonb_build_object('outcome','conflict','job',to_jsonb(current_job));
    end if;
  end if;
  result:=public.console_job_publish_v1(job_id,claim_token,case when completion_state='running' then 'uncertain' else completion_state end,result_value,provider_identity,source_sha);
  if result->>'outcome'='published' and completion_state='running' then
    if mutation then
      -- Running implies holding the guard: re-take one that acknowledgment released, and stop
      -- naming a receipt that is back at work as the unresolved work the next mutation must cite.
      -- The row lock taken above makes the free-or-mine check and this write one decision.
      insert into public.console_job_mutation_guard(singleton,job_id) values(true,current_job.id)
        on conflict(singleton) do update set job_id=excluded.job_id,
          last_unresolved_id=case when console_job_mutation_guard.last_unresolved_id=excluded.job_id then null else console_job_mutation_guard.last_unresolved_id end
        where console_job_mutation_guard.job_id is null or console_job_mutation_guard.job_id=excluded.job_id;
      if not found then raise exception 'console_job_publish: mutation guard held by another receipt' using errcode='serialization_failure';end if;
    end if;
    update public.console_jobs set state='running' where id=job_id returning * into current_job;
    return jsonb_build_object('outcome',case when resumed then 'resumed' else 'published' end,'job',to_jsonb(current_job));
  end if;
  return result;
end;$$;

revoke all on function public.console_job_acknowledge_uncertain(uuid),public.console_job_publish(uuid,uuid,text,jsonb,text,text) from public,anon,authenticated;
grant execute on function public.console_job_acknowledge_uncertain(uuid),public.console_job_publish(uuid,uuid,text,jsonb,text,text) to service_role;
