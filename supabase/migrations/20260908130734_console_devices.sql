-- Explicit browser inventory, not reporters, health, authentication or hardware discovery.
-- Live rows stay until Forget. Intent validity lasts 24 hours; expired request metadata
-- is pruned on a later valid admission and can remain longer on an inactive deployment.
create table public.console_devices (
  id uuid primary key,
  label text not null check (char_length(btrim(label)) between 1 and 60 and octet_length(label) <= 240 and label !~ '[[:cntrl:]]'),
  category text check (category in ('computer','phone','tablet','other')),
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  last_seen_at timestamptz
);
create table public.console_device_requests (
  request_key uuid primary key,
  input_fingerprint text not null check (input_fingerprint ~ '^[0-9a-f]{64}$'),
  expires_at timestamptz not null,
  -- Deliberately no FK cascade: an absent target is a forgotten outcome for this intent.
  target_id uuid not null
);
alter table public.console_devices enable row level security;
alter table public.console_device_requests enable row level security;
revoke all on public.console_devices, public.console_device_requests from public, anon, authenticated;
grant select, insert, update, delete on public.console_devices, public.console_device_requests to service_role;
create policy console_devices_service on public.console_devices to service_role using (true) with check (true);
create policy console_device_requests_service on public.console_device_requests to service_role using (true) with check (true);

create function public.console_device_list() returns jsonb language sql security invoker set search_path='' as $$
  select jsonb_build_object('items',coalesce((select jsonb_agg(to_jsonb(d) order by d.created_at,d.id) from public.console_devices d),'[]'::jsonb));
$$;

create function public.console_device_register(request_key uuid, intent_expires timestamptz, chosen_label text, chosen_category text, input_fingerprint text, current_id uuid default null)
returns jsonb language plpgsql security invoker set search_path='' as $$
declare d public.console_devices; r public.console_device_requests; moment timestamptz;
begin
  -- All admissions and Forget share one deployment-local lock. A count check cannot race.
  perform pg_advisory_xact_lock(763541,1);
  moment := clock_timestamp();
  if intent_expires is null or intent_expires <= moment or intent_expires > moment + interval '24 hours' then return jsonb_build_object('outcome','expired'); end if;
  if request_key is null or input_fingerprint is null or input_fingerprint !~ '^[0-9a-f]{64}$' or chosen_label is null or char_length(btrim(chosen_label)) not between 1 and 60 or octet_length(chosen_label)>240 or chosen_label ~ '[[:cntrl:]]' or (chosen_category is not null and chosen_category not in ('computer','phone','tablet','other')) then return jsonb_build_object('outcome','invalid'); end if;
  delete from public.console_device_requests where expires_at <= moment;
  select * into r from public.console_device_requests q where q.request_key=console_device_register.request_key;
  if found then
    if r.input_fingerprint <> input_fingerprint or r.expires_at <> intent_expires then return jsonb_build_object('outcome','key_conflict'); end if;
    select * into d from public.console_devices where id=r.target_id;
    if not found then return jsonb_build_object('outcome','forgotten'); end if;
    return jsonb_build_object('outcome','registered','item',to_jsonb(d));
  end if;
  if (select count(*) from public.console_device_requests)>=200 then return jsonb_build_object('outcome','recent_capacity'); end if;
  if current_id is not null then
    select * into d from public.console_devices where id=current_id;
  end if;
  -- A fresh explicit intent may replace a stale binding; passive reads/visits never clear it.
  -- Old intents were resolved above, so this cannot resurrect their forgotten targets.
  if d.id is null then
    if (select count(*) from public.console_devices)>=50 then return jsonb_build_object('outcome','capacity'); end if;
    insert into public.console_devices(id,label,category) values(request_key,btrim(chosen_label),chosen_category) returning * into d;
  end if;
  insert into public.console_device_requests values(request_key,input_fingerprint,intent_expires,d.id);
  return jsonb_build_object('outcome','registered','item',to_jsonb(d));
end;
$$;

create function public.console_device_rename(device_id uuid, expected_updated timestamptz, chosen_label text)
returns jsonb language plpgsql security invoker set search_path='' as $$
declare d public.console_devices;
begin
  if chosen_label is null or char_length(btrim(chosen_label)) not between 1 and 60 or octet_length(chosen_label)>240 or chosen_label ~ '[[:cntrl:]]' then return jsonb_build_object('outcome','invalid'); end if;
  select * into d from public.console_devices where id=device_id for update;
  if not found then return jsonb_build_object('outcome','missing'); end if;
  if expected_updated is null or d.updated_at <> expected_updated then return jsonb_build_object('outcome','conflict'); end if;
  update public.console_devices set label=btrim(chosen_label),updated_at=greatest(clock_timestamp(),d.updated_at+interval '1 microsecond') where id=device_id returning * into d;
  return jsonb_build_object('outcome','renamed','item',to_jsonb(d));
end;
$$;

create function public.console_device_forget(device_id uuid, expected_updated timestamptz)
returns jsonb language plpgsql security invoker set search_path='' as $$
declare d public.console_devices;
begin
  perform pg_advisory_xact_lock(763541,1);
  select * into d from public.console_devices where id=device_id for update;
  if found then
    if expected_updated is null or d.updated_at <> expected_updated then return jsonb_build_object('outcome','conflict'); end if;
    delete from public.console_devices where id=device_id;
  end if;
  return jsonb_build_object('outcome','forgotten','id',device_id);
end;
$$;

create function public.console_device_visit(device_id uuid) returns jsonb language plpgsql security invoker set search_path='' as $$
declare d public.console_devices;
begin
  select * into d from public.console_devices where id=device_id for update;
  if not found then return jsonb_build_object('outcome','missing'); end if;
  if d.last_seen_at is not null and d.last_seen_at > clock_timestamp()-interval '5 minutes' then return jsonb_build_object('outcome','throttled'); end if;
  update public.console_devices set last_seen_at=clock_timestamp() where id=device_id;
  return jsonb_build_object('outcome','visited');
end;
$$;

revoke all on function public.console_device_list(), public.console_device_register(uuid,timestamptz,text,text,text,uuid), public.console_device_rename(uuid,timestamptz,text), public.console_device_forget(uuid,timestamptz), public.console_device_visit(uuid) from public, anon, authenticated;
grant execute on function public.console_device_list(), public.console_device_register(uuid,timestamptz,text,text,text,uuid), public.console_device_rename(uuid,timestamptz,text), public.console_device_forget(uuid,timestamptz), public.console_device_visit(uuid) to service_role;
