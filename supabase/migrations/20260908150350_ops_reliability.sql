-- Ops-only coordination. Terminal execution evidence, visual state and transport acceptance
-- have separate identities. Invoker RPCs are service-only; no external call holds these locks.
alter table public.ops_runs add column terminal_outcome text
  check(terminal_outcome in ('succeeded','unverified','failed','crashed','needs_you'));

-- Historical reconstruction: prefer the actual finish receipt, not the sweep's mutable state.
update public.ops_runs r set terminal_outcome=coalesce(
  (select case when e.to_state in ('succeeded','unverified','failed','crashed','needs_you') then e.to_state end
   from public.ops_events e where e.run_id=r.id and e.kind='finish' order by e.id desc limit 1),
  case when r.exit_reason='question' then 'needs_you' when r.exit_reason='infra' then 'crashed'
       when r.exit_reason in ('code','timeout') then 'failed'
       when jsonb_array_length(r.evidence)>0 then 'succeeded' else 'unverified' end)
from public.ops_units u where u.id=r.unit_id and u.kind<>'machine' and r.ended_at is not null;

create table public.ops_monitor (
  unit_id text primary key references public.ops_units(id) on delete cascade,
  active_run_id bigint references public.ops_runs(id) on delete set null,
  failures integer not null default 0 check(failures>=0),
  visual text not null default 'scheduled',
  last_alert_key text,
  -- Acceptance receipt order, not outbox intent creation order. A delayed older intent
  -- accepted after a recovery creates new outstanding debt.
  accepted_alert bigint not null default 0,
  recovered_alert bigint not null default 0,
  last_recovery_key text,
  owed jsonb check(owed is null or octet_length(owed::text)<=2048),
  mail_status text,
  suppressed boolean not null default false,
  revision bigint not null default 0
);
alter table public.ops_monitor enable row level security;
create policy ops_monitor_service on public.ops_monitor to service_role using(true) with check(true);
insert into public.ops_monitor(unit_id,active_run_id,failures,visual,accepted_alert,recovered_alert)
select u.id,
 (select r.id from public.ops_runs r where r.unit_id=u.id and r.started_at is not null and r.ended_at is null order by r.started_at desc,r.id desc limit 1),
 (select count(*)::int from public.ops_runs r where r.unit_id=u.id and r.terminal_outcome='failed'
   and (r.ended_at,r.id)>coalesce((select row(x.ended_at,x.id) from public.ops_runs x where x.unit_id=u.id and x.terminal_outcome is not null and x.terminal_outcome<>'failed' order by x.ended_at desc,x.id desc limit 1),row('-infinity'::timestamptz,0::bigint))),
 coalesce((select e.to_state from public.ops_events e where e.unit_id=u.id and e.kind='transition' order by e.id desc limit 1),'scheduled'),
 coalesce((select max(e.id) from public.ops_events e where e.unit_id=u.id and e.kind='alert_sent' and e.to_state<>'succeeded'),0),
 -- Only a real recovery transport receipt answers a prior accepted alert. A transition does not.
 coalesce((select max(a.id) from public.ops_events a where a.unit_id=u.id and a.kind='alert_sent' and a.to_state<>'succeeded'
   and exists(select 1 from public.ops_events e where e.unit_id=u.id and e.kind='alert_sent' and e.to_state='succeeded' and e.id>a.id)),0)
from public.ops_units u;
update public.ops_monitor m set last_alert_key=(select 'alert:'||coalesce(e.run_id::text,'none')||':'||e.to_state from public.ops_events e where e.unit_id=m.unit_id and e.kind='alert_sent' and e.to_state<>'succeeded' order by e.id desc limit 1),
  last_recovery_key=case when recovered_alert>0 then 'recovery:'||recovered_alert else null end;

create function public.ops_report_atomic(report jsonb, observed_at timestamptz default clock_timestamp()) returns jsonb
language plpgsql security invoker set search_path=pg_catalog,public set statement_timeout='5s' as $$
declare u public.ops_units; r public.ops_runs; live public.ops_runs; m public.ops_monitor;
 v text:=report->>'verb'; k text:=report->>'run_key'; outcome text; reason text; v_evidence jsonb; t timestamptz:=observed_at;
begin
 if jsonb_typeof(report)<>'object' or octet_length(report::text)>65536 or t is null or not isfinite(t)
   or coalesce(length(report->>'unit'),0) not between 1 and 128 or coalesce(length(k),0) not between 1 and 256
   or v is null or v not in ('start','finish','heartbeat') then
   return jsonb_build_object('ok',false,'status',400,'error','invalid or oversized report');
 end if;
 if (report?'summary' and length(report->>'summary')>280) or (report?'error' and length(report->>'error')>4000)
   or (report?'facts' and (jsonb_typeof(report->'facts')<>'object' or octet_length((report->'facts')::text)>16384))
   or (report?'cost' and octet_length((report->'cost')::text)>4096)
   or (report?'ok' and jsonb_typeof(report->'ok')<>'boolean')
   or (report?'exit_reason' and report->>'exit_reason' not in ('code','infra','timeout','no_signal','question'))
   or (report?'trigger' and report->>'trigger' not in ('cron','manual','retry','webhook','heartbeat')) then
   return jsonb_build_object('ok',false,'status',400,'error','invalid report fields');
 end if;
 v_evidence:=coalesce(report->'evidence','[]');
 if jsonb_typeof(v_evidence)<>'array' then return jsonb_build_object('ok',false,'status',400,'error','invalid evidence');end if;
 if jsonb_array_length(v_evidence)>20 or exists(select 1 from jsonb_array_elements(v_evidence) x where jsonb_typeof(x)<>'string' or length(x#>>'{}')>2048) then
   return jsonb_build_object('ok',false,'status',400,'error','invalid evidence');
 end if;
 select * into u from public.ops_units where id=report->>'unit' for update;
 if not found then return jsonb_build_object('ok',false,'status',404,'error','unknown unit');end if;
 if u.max_run_s not between 0 and 86400 then return jsonb_build_object('ok',false,'status',400,'error','invalid unit lease bound');end if;
 insert into public.ops_monitor(unit_id) values(u.id) on conflict do nothing;
 select * into m from public.ops_monitor where unit_id=u.id;
 select * into r from public.ops_runs where unit_id=u.id and run_key=k;
 if v='start' then
   if r.started_at is not null then return jsonb_build_object('ok',true,'run',to_jsonb(r),'replay',true);end if;
   select * into live from public.ops_runs where id=m.active_run_id;
   if live.started_at is not null and live.ended_at is null and live.lease_until>=t then
     return jsonb_build_object('ok',false,'status',409,'error','unit has a live run','run',to_jsonb(live));
   end if;
   if r.id is null then
     insert into public.ops_runs(unit_id,run_key,trigger,started_at,lease_until,state,facts,updated_at)
       values(u.id,k,coalesce(report->>'trigger','cron'),t,t+u.max_run_s*interval '1 second','running',report->'facts',t) returning * into r;
   else
     update public.ops_runs set started_at=t,lease_until=t+u.max_run_s*interval '1 second',state='running',trigger=coalesce(report->>'trigger',trigger),updated_at=t where id=r.id returning * into r;
   end if;
   update public.ops_monitor set active_run_id=r.id,revision=revision+1 where unit_id=u.id;
   insert into public.ops_events(unit_id,run_id,at,actor,kind,to_state,body) values(u.id,r.id,t,'unit','start','running',jsonb_build_object('run_key',k));
 elsif v='heartbeat' and u.kind='machine' then
   -- Last-seen reporting is intentionally mutable, not an automation terminal outcome.
   if r.id is null then
     insert into public.ops_runs(unit_id,run_key,trigger,started_at,ended_at,state,facts,updated_at)
       values(u.id,k,'heartbeat',t,t,'seen',report->'facts',t) returning * into r;
   else
     update public.ops_runs set started_at=greatest(started_at,t),ended_at=greatest(ended_at,t),state='seen',lease_until=null,facts=coalesce(report->'facts',facts),updated_at=greatest(updated_at,t) where id=r.id returning * into r;
   end if;
   update public.ops_monitor set revision=revision+1 where unit_id=u.id;
   insert into public.ops_events(unit_id,run_id,at,actor,kind,to_state,body) values(u.id,r.id,t,'unit','heartbeat','seen',coalesce(report->'facts','{}'));
 else
   if r.id is null or r.started_at is null then return jsonb_build_object('ok',false,'status',404,'error','no started run for this key');end if;
   if v='finish' and r.terminal_outcome is not null then return jsonb_build_object('ok',true,'run',to_jsonb(r),'replay',true);end if;
   if r.ended_at is not null or m.active_run_id is distinct from r.id or r.lease_until is null or r.lease_until<t then
     return jsonb_build_object('ok',false,'status',409,'error','run no longer owns a live lease');
   end if;
   if v='heartbeat' then
     update public.ops_runs set lease_until=t+u.max_run_s*interval '1 second',facts=coalesce(report->'facts',facts),updated_at=t where id=r.id returning * into r;
     insert into public.ops_events(unit_id,run_id,at,actor,kind,body) values(u.id,r.id,t,'unit','heartbeat',jsonb_build_object('lease_until',r.lease_until));
   else
     reason:=case when coalesce((report->>'ok')::boolean,true) then null else coalesce(report->>'exit_reason','code') end;
     outcome:=case when reason='question' then 'needs_you' when reason='infra' then 'crashed' when reason is not null then 'failed'
       when jsonb_array_length(v_evidence)>0 then 'succeeded' else 'unverified' end;
     update public.ops_runs set ended_at=t,lease_until=null,state=outcome,terminal_outcome=outcome,exit_reason=reason,
       summary=report->>'summary',error=report->>'error',evidence=v_evidence,cost=report->'cost',updated_at=t where id=r.id returning * into r;
     update public.ops_monitor set active_run_id=null,failures=case when outcome='failed' then least(failures::bigint+1,2147483647)::integer else 0 end where unit_id=u.id;
     insert into public.ops_events(unit_id,run_id,at,actor,kind,from_state,to_state,body)
       values(u.id,r.id,t,'unit','finish','running',outcome,jsonb_build_object('evidence',v_evidence,'summary',r.summary,'error',r.error));
   end if;
   update public.ops_monitor set revision=revision+1 where unit_id=u.id;
 end if;
 return jsonb_build_object('ok',true,'run',to_jsonb(r),'replay',false);
end $$;

-- Older sweep writers cannot erase the terminal evidence after this migration.
create function public.ops_terminal_guard() returns trigger language plpgsql security invoker set search_path=pg_catalog,public as $$
begin
 if old.terminal_outcome is not null and
   (new.terminal_outcome,new.ended_at,new.exit_reason,new.evidence,new.summary,new.error,new.cost)
   is distinct from (old.terminal_outcome,old.ended_at,old.exit_reason,old.evidence,old.summary,old.error,old.cost) then
   raise exception 'terminal outcome is immutable' using errcode='23514';
 end if;
 return new;
end $$;
create trigger ops_terminal_immutable before update on public.ops_runs for each row execute function public.ops_terminal_guard();

revoke all on public.ops_monitor from public,anon,authenticated;
grant select,insert,update,delete on public.ops_monitor to service_role;
grant select,insert,update on public.ops_units,public.ops_runs,public.ops_events to service_role;
grant usage,select on sequence public.ops_runs_id_seq,public.ops_events_id_seq to service_role;
revoke all on function public.ops_report_atomic(jsonb,timestamptz),public.ops_terminal_guard() from public,anon,authenticated;
grant execute on function public.ops_report_atomic(jsonb,timestamptz),public.ops_terminal_guard() to service_role;

create function public.ops_monitor_init() returns trigger language plpgsql security invoker set search_path=pg_catalog,public as $$
begin insert into public.ops_monitor(unit_id) values(new.id);return new;end $$;
create trigger ops_monitor_init after insert on public.ops_units for each row execute function public.ops_monitor_init();

-- Acknowledgment admission shares the unit lock with snapshot commits. Pauses already UPDATE
-- that row. Reports, acknowledgments and mail completion cannot race a committed snapshot.
create function public.ops_ack_lock() returns trigger language plpgsql security invoker set search_path=pg_catalog,public as $$
begin
 if new.kind in ('ack','snooze') then perform 1 from public.ops_units where id=new.unit_id for update;end if;
 return new;
end $$;
create trigger ops_ack_lock before insert on public.ops_events for each row execute function public.ops_ack_lock();

create table public.ops_alert_outbox (
 id bigint primary key default nextval('public.ops_events_id_seq'),
 unit_id text not null references public.ops_units(id) on delete cascade,
 run_id bigint references public.ops_runs(id) on delete set null,
 logical_key text not null,
 provider_key text not null unique default ('cortex-ops/'||gen_random_uuid()::text),
 kind text not null check(kind in ('alert','recovery')),
 target_alert bigint not null default 0,
 to_state text not null,
 subject text not null check(length(subject)<=500),
 body text not null check(octet_length(body)<=16000),
 envelope jsonb,
 created_at timestamptz not null,
 state text not null default 'pending' check(state in ('pending','sending','accepted','terminal')),
 attempts integer not null default 0 check(attempts between 0 and 6),
 first_claim_at timestamptz,
 next_attempt_at timestamptz not null,
 lease_until timestamptz,
 claim_token uuid,
 finished_at timestamptz,
 provider_id text,
 last_error text,
 unique(unit_id,logical_key)
);
alter table public.ops_alert_outbox enable row level security;
create policy ops_outbox_service on public.ops_alert_outbox to service_role using(true) with check(true);
create index ops_outbox_due on public.ops_alert_outbox(next_attempt_at,id) where state in ('pending','sending');

create function public.ops_sweep_snapshot(unit_id text) returns jsonb
language sql stable security invoker set search_path=pg_catalog,public set statement_timeout='5s' as $$
 select data||jsonb_build_object('token',md5(data::text)) from (
 select jsonb_build_object('unit',to_jsonb(u),'run',
   (select to_jsonb(r) from public.ops_runs r where r.unit_id=u.id order by r.started_at desc nulls last,r.id desc limit 1),
   'ack',(select jsonb_build_object('at',e.at,'until',e.body->'until','id',e.id) from public.ops_events e where e.unit_id=u.id and e.kind in ('ack','snooze') order by e.at desc,e.id desc limit 1),
   'owed_run',(select to_jsonb(r) from public.ops_runs r where r.id=(m.owed->>'run_id')::bigint),
   'monitor',to_jsonb(m)) data
 from public.ops_units u join public.ops_monitor m on m.unit_id=u.id where u.id=$1) q;
$$;

create function public.ops_sweep_record(unit_id text, expected_token text, visual_state text, alert jsonb, observed_at timestamptz)
returns jsonb language plpgsql security invoker set search_path=pg_catalog,public set statement_timeout='5s' as $$
declare s jsonb;m public.ops_monitor; changed boolean; logical text; intent_id bigint; alert_kind text; d jsonb;t timestamptz:=observed_at;silenced boolean;
begin
 if t is null or not isfinite(t) or visual_state not in ('scheduled','late','missed','running','succeeded','unverified','failed','crashed','needs_you','acknowledged','paused','seen','quiet') then raise exception 'invalid sweep';end if;
 perform 1 from public.ops_units where id=unit_id for update;
 if not found then return jsonb_build_object('state','missing');end if;
 s:=public.ops_sweep_snapshot(unit_id);
 if s->>'token' is distinct from expected_token then return jsonb_build_object('state','conflict');end if;
 select * into m from public.ops_monitor where ops_monitor.unit_id=ops_sweep_record.unit_id;
 changed:=m.visual<>visual_state;
 silenced:=visual_state in ('acknowledged','paused') or not (s->'unit'->>'pages')::boolean or s->'unit'->>'kind'='machine';
 if m.suppressed is distinct from silenced then update public.ops_monitor set suppressed=silenced,revision=revision+1 where ops_monitor.unit_id=ops_sweep_record.unit_id;end if;
 if changed then
   insert into public.ops_events(unit_id,run_id,at,actor,kind,from_state,to_state,body)
     values(unit_id,(s->'run'->>'id')::bigint,t,'sweep','transition',m.visual,visual_state,'{}');
   update public.ops_monitor set visual=visual_state,revision=revision+1 where ops_monitor.unit_id=ops_sweep_record.unit_id;
 end if;
 if alert is not null and alert<>'null'::jsonb and not silenced then
   if jsonb_typeof(alert)<>'object' or octet_length(alert::text)>20000 or length(alert->>'subject')>500 or octet_length(alert->>'text')>16000 then raise exception 'invalid alert';end if;
   d:=m.owed;
   alert_kind:=coalesce(d->>'kind',alert->>'kind');
   if alert_kind='recovery' then
     if d is null and (m.accepted_alert<=m.recovered_alert or visual_state<>'succeeded') then return jsonb_build_object('state','recorded','transition',changed);end if;
     logical:='recovery:'||coalesce(d->>'target',m.accepted_alert::text);
     if logical=m.last_recovery_key then return jsonb_build_object('state','recorded','transition',changed);end if;
   elsif alert_kind='alert' then
     logical:='alert:'||coalesce(d->>'run_id',s->'run'->>'id','none')||':'||coalesce(d->>'to',visual_state);
     if logical=m.last_alert_key then return jsonb_build_object('state','recorded','transition',changed);end if;
   else raise exception 'invalid alert kind';end if;
   if d is null then
     d:=jsonb_build_object('kind',alert_kind,'run_id',s->'run'->'id','from',m.visual,'to',visual_state,'at',t,'target',m.accepted_alert);
     update public.ops_monitor set owed=d,revision=revision+1 where ops_monitor.unit_id=ops_sweep_record.unit_id;
   end if;
   -- Capacity and cleanup share one small Ops-only admission lock. Reporting never takes it.
   perform pg_advisory_xact_lock(18462026,3);
   delete from public.ops_alert_outbox where state in ('accepted','terminal') and finished_at<t-interval '30 days';
   if (select count(*) from public.ops_alert_outbox)>=200 then
     -- Do NOT advance the logical cursor: the unchanged visual state still owes this alert.
     update public.ops_monitor set mail_status='outbox_capacity' where ops_monitor.unit_id=ops_sweep_record.unit_id;
     if m.mail_status is distinct from 'outbox_capacity' then insert into public.ops_events(unit_id,run_id,at,actor,kind,body) values(unit_id,(d->>'run_id')::bigint,t,'sweep','alert_failed','{"error":"outbox_capacity: alert remains owed"}');end if;
     return jsonb_build_object('state','capacity','transition',changed);
   end if;
   insert into public.ops_alert_outbox(unit_id,run_id,logical_key,kind,target_alert,to_state,subject,body,created_at,next_attempt_at)
     values(unit_id,(d->>'run_id')::bigint,logical,alert_kind,case when alert_kind='recovery' then (d->>'target')::bigint else 0 end,d->>'to',alert->>'subject',alert->>'text',(d->>'at')::timestamptz,t)
     on conflict on constraint ops_alert_outbox_unit_id_logical_key_key do nothing returning id into intent_id;
   update public.ops_monitor set last_alert_key=case when alert_kind='alert' then logical else last_alert_key end,
     last_recovery_key=case when alert_kind='recovery' then logical else last_recovery_key end,owed=null,mail_status='pending',revision=revision+1 where ops_monitor.unit_id=ops_sweep_record.unit_id;
 end if;
 return jsonb_build_object('state','recorded','transition',changed,'intent',intent_id);
end $$;

-- Claims are one at a time. At most six claims, including lost responses/worker deaths.
-- The first claim begins the conservative 23-hour provider retry window, before any send.
create function public.ops_alert_claim(observed_at timestamptz, envelope jsonb) returns jsonb
language plpgsql security invoker set search_path=pg_catalog,public set statement_timeout='5s' as $$
declare a public.ops_alert_outbox; t timestamptz:=observed_at; bad text;
begin
 if t is null or not isfinite(t) then raise exception 'invalid claim time';end if;
 select * into a from public.ops_alert_outbox o where state in ('pending','sending') and next_attempt_at<=t
   -- Current pause/ack inputs, never a cached visual suppression bit: expiry can unblock
   -- delivery before this unit gets another observation turn.
   and (lease_until is null or lease_until<t)
   and exists(select 1 from public.ops_units u where u.id=o.unit_id and u.pages and u.kind<>'machine' and (u.paused_until is null or u.paused_until<=t))
   and not exists(select 1 from (select e.at,e.body from public.ops_events e where e.unit_id=o.unit_id and e.kind in ('ack','snooze') order by e.at desc,e.id desc limit 1) ack
     where (ack.body->>'until' is null or (ack.body->>'until')::timestamptz>t)
       -- A newer run spends this acknowledgment only for its own alert, never for an
       -- already queued alert belonging to an older acknowledged run.
       and ack.at>=coalesce((select r.started_at from public.ops_runs r where r.id=o.run_id),'-infinity'::timestamptz))
   order by next_attempt_at,id for update skip locked limit 1;
 if not found then return null;end if;
 if a.attempts>=6 then bad:='attempts_exhausted';
 elsif a.first_claim_at is not null and t>=a.first_claim_at+interval '23 hours' then bad:='provider_window_expired';
 end if;
 if bad is not null then
   update public.ops_alert_outbox set state='terminal',finished_at=t,lease_until=null,claim_token=null,last_error=bad where id=a.id;
   insert into public.ops_events(unit_id,run_id,at,actor,kind,to_state,body) values(a.unit_id,a.run_id,t,'sweep','alert_failed',a.to_state,jsonb_build_object('error',bad,'outbox',a.id,'terminal',true,'provider_key',a.provider_key,'first_claim_at',a.first_claim_at,'attempts',a.attempts));
   return jsonb_build_object('state','terminal','unit_id',a.unit_id);
 end if;
 if envelope is null or envelope='null'::jsonb then
   update public.ops_alert_outbox set next_attempt_at=t+interval '15 minutes',last_error='mail_unavailable' where id=a.id;
   if a.last_error is distinct from 'mail_unavailable' then
     insert into public.ops_events(unit_id,run_id,at,actor,kind,to_state,body) values(a.unit_id,a.run_id,t,'sweep','alert_failed',a.to_state,jsonb_build_object('error','mail_unavailable','outbox',a.id));
   end if;
   return jsonb_build_object('state','unavailable','unit_id',a.unit_id);
 end if;
 if jsonb_typeof(envelope)<>'object' or octet_length(envelope::text)>2048 or coalesce(length(envelope->>'from'),0) not between 1 and 512
   or coalesce(length(envelope->>'to'),0) not between 1 and 320 or coalesce(length(envelope->>'credential'),0)<>64 then raise exception 'invalid mail envelope';end if;
 if a.envelope is not null and a.envelope->>'credential' is distinct from envelope->>'credential' then
   update public.ops_alert_outbox set next_attempt_at=t+interval '15 minutes',last_error='mail_credentials_changed' where id=a.id;
   if a.last_error is distinct from 'mail_credentials_changed' then
     insert into public.ops_events(unit_id,run_id,at,actor,kind,to_state,body) values(a.unit_id,a.run_id,t,'sweep','alert_failed',a.to_state,jsonb_build_object('error','mail_credentials_changed','outbox',a.id));
   end if;
   return jsonb_build_object('state','unavailable','unit_id',a.unit_id);
 end if;
 update public.ops_alert_outbox set state='sending',envelope=coalesce(ops_alert_outbox.envelope,ops_alert_claim.envelope),
   first_claim_at=coalesce(first_claim_at,t),attempts=attempts+1,lease_until=t+interval '60 seconds',claim_token=gen_random_uuid()
   where id=a.id returning * into a;
 return to_jsonb(a);
end $$;

create function public.ops_alert_complete(alert_id bigint, token uuid, result jsonb, observed_at timestamptz) returns text
language plpgsql security invoker set search_path=pg_catalog,public set statement_timeout='5s' as $$
declare a public.ops_alert_outbox; t timestamptz:=observed_at; accepted boolean; terminal boolean; safe_error text; receipt_id bigint;
begin
 if t is null or not isfinite(t) or jsonb_typeof(result)<>'object' or octet_length(result::text)>1024 then raise exception 'invalid completion';end if;
 -- No row lock is held while acquiring the unit: the same order as sweep commits.
 select * into a from public.ops_alert_outbox where id=alert_id;
 if not found then return 'missing';end if;
 perform 1 from public.ops_units where id=a.unit_id for update;
 select * into a from public.ops_alert_outbox where id=alert_id for update;
 if a.state<>'sending' or a.claim_token is distinct from token or a.lease_until<t then return 'stale';end if;
 accepted:=coalesce((result->>'ok')::boolean,false) and coalesce(length(result->>'id'),0) between 1 and 256;
 terminal:=not coalesce((result->>'retryable')::boolean,true) or a.attempts>=6 or t>=a.first_claim_at+interval '23 hours';
 safe_error:=case when result->>'error' in ('transport_unavailable','invalid_response','response_too_large','request_too_large','invalid_idempotent_request','concurrent_idempotent_requests','provider_rejected','provider_unavailable','mail_unavailable','provider_window_expired') then result->>'error' else 'transport_unavailable' end;
 update public.ops_alert_outbox set state=case when accepted then 'accepted' when terminal then 'terminal' else 'pending' end,
   finished_at=case when accepted or terminal then t else null end,provider_id=case when accepted then result->>'id' else null end,
   last_error=case when accepted then null else safe_error end,lease_until=null,claim_token=null,
   next_attempt_at=t+make_interval(secs=>least(14400,60*power(4,a.attempts-1))::integer) where id=a.id;
 insert into public.ops_events(unit_id,run_id,at,actor,kind,to_state,body) values(a.unit_id,a.run_id,t,'sweep',case when accepted then 'alert_sent' else 'alert_failed' end,a.to_state,
   case when accepted then jsonb_build_object('id',result->>'id','outbox',a.id,'meaning','provider_accepted_not_inbox_delivery')
   else jsonb_build_object('status',coalesce((result->>'status')::integer,0),'error',safe_error,'terminal',terminal,'outbox',a.id,'provider_key',a.provider_key,'first_claim_at',a.first_claim_at,'attempts',a.attempts) end) returning id into receipt_id;
 if accepted then
   -- The unit lock serializes these receipts. The recovery target remains the acceptance
   -- observed when that recovery was enqueued, so it cannot cover a later acceptance.
   update public.ops_monitor set accepted_alert=case when a.kind='alert' then greatest(accepted_alert,receipt_id) else accepted_alert end,
     recovered_alert=case when a.kind='recovery' then greatest(recovered_alert,a.target_alert) else recovered_alert end,revision=revision+1 where unit_id=a.unit_id;
 end if;
 return case when accepted then 'accepted' when terminal then 'terminal' else 'pending' end;
end $$;

revoke all on public.ops_alert_outbox from public,anon,authenticated;
grant select,insert,update,delete on public.ops_alert_outbox to service_role;
revoke all on function public.ops_monitor_init(),public.ops_ack_lock(),public.ops_sweep_snapshot(text),public.ops_sweep_record(text,text,text,jsonb,timestamptz),public.ops_alert_claim(timestamptz,jsonb),public.ops_alert_complete(bigint,uuid,jsonb,timestamptz) from public,anon,authenticated;
grant execute on function public.ops_monitor_init(),public.ops_ack_lock(),public.ops_sweep_snapshot(text),public.ops_sweep_record(text,text,text,jsonb,timestamptz),public.ops_alert_claim(timestamptz,jsonb),public.ops_alert_complete(bigint,uuid,jsonb,timestamptz) to service_role;

create function public.ops_delivery_status(unit_id text) returns text
language sql stable security invoker set search_path=pg_catalog,public set statement_timeout='5s' as $$
 select case when m.owed is not null then 'outbox_capacity' else coalesce(
   (select case when a.state='terminal' then 'terminal:'||coalesce(a.last_error,'unknown')
                when a.state='accepted' then 'provider_accepted' else coalesce(a.last_error,'pending') end
    from public.ops_alert_outbox a where a.unit_id=m.unit_id
    order by (a.state in ('pending','sending')) desc,a.id desc limit 1),
   -- Payload pruning must not turn a completed receipt back into "pending".
   (select case when e.kind='alert_sent' then 'provider_accepted'
                when e.body->>'terminal'='true' then 'terminal:'||coalesce(e.body->>'error','unknown')
                else e.body->>'error' end
    from public.ops_events e where e.unit_id=m.unit_id and e.kind in ('alert_sent','alert_failed')
    order by e.at desc,e.id desc limit 1),m.mail_status) end
 from public.ops_monitor m where m.unit_id=$1;
$$;
revoke all on function public.ops_delivery_status(text) from public,anon,authenticated;
grant execute on function public.ops_delivery_status(text) to service_role;
