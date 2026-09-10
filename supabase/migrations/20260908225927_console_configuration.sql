-- Value-free, service-only configuration admission ledger.
-- Provider values and unkeyed hashes never enter this schema.

create table public.console_configuration_requests (
  request_key uuid primary key,
  input_fingerprint text not null check (input_fingerprint ~ '^[0-9a-f]{64}$'),
  capability text not null check (capability in (
    'notes', 'reader-anthropic', 'reader-openai', 'reader-google', 'mirror', 'cache', 'alerts'
  )),
  target text not null check (
    length(target) <= 300
    and target ~ '^vercel:prj_[A-Za-z0-9]{1,100}:(personal|team_[A-Za-z0-9]{1,100}):(production|preview)$'
  ),
  starting_revision bigint not null check (starting_revision >= 0),
  completed_revision bigint check (completed_revision >= 1),
  acknowledged_revision bigint check (acknowledged_revision >= 1),
  state text not null check (state in ('running', 'finished', 'uncertain')),
  claim_token uuid not null,
  result jsonb,
  acknowledged_at timestamptz,
  requested_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  check ((state = 'finished') = (completed_revision is not null)),
  check ((acknowledged_at is null) = (acknowledged_revision is null)),
  check (octet_length(coalesce(result::text, 'null')) <= 4096)
);

create table public.console_configuration_state (
  capability text not null check (capability in (
    'notes', 'reader-anthropic', 'reader-openai', 'reader-google', 'mirror', 'cache', 'alerts'
  )),
  target text not null check (
    length(target) <= 300
    and target ~ '^vercel:prj_[A-Za-z0-9]{1,100}:(personal|team_[A-Za-z0-9]{1,100}):(production|preview)$'
  ),
  revision bigint not null default 0 check (revision >= 0),
  current_request uuid not null references public.console_configuration_requests(request_key) on delete restrict,
  updated_at timestamptz not null default clock_timestamp(),
  primary key (capability, target)
);

create index console_configuration_requests_retention_idx
  on public.console_configuration_requests (updated_at)
  where state = 'finished' or (state = 'uncertain' and acknowledged_at is not null);

alter table public.console_configuration_requests enable row level security;
alter table public.console_configuration_state enable row level security;
revoke all on table public.console_configuration_requests from public, anon, authenticated, service_role;
revoke all on table public.console_configuration_state from public, anon, authenticated, service_role;
grant select, insert, update, delete on table public.console_configuration_requests to service_role;
grant select, insert, update, delete on table public.console_configuration_state to service_role;
create policy console_configuration_requests_service_only on public.console_configuration_requests
  for all to service_role using (true) with check (true);
create policy console_configuration_state_service_only on public.console_configuration_state
  for all to service_role using (true) with check (true);

create function public.console_configuration_record(
  request_row public.console_configuration_requests,
  visible_revision bigint
)
returns jsonb
language sql
stable
security invoker
set search_path = ''
set statement_timeout = '5s'
as $$
  select jsonb_build_object(
    'capability', request_row.capability,
    'target', request_row.target,
    'revision', visible_revision,
    'status', request_row.state,
    'request_key', request_row.request_key,
    'result', request_row.result,
    'acknowledged', request_row.acknowledged_at is not null,
    'updated_at', to_char(request_row.updated_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
  )
$$;

create function public.console_configuration_result_valid(
  capability_name text,
  completion_state text,
  result_value jsonb
)
returns boolean
language plpgsql
immutable
security invoker
set search_path = ''
set statement_timeout = '5s'
as $$
declare
  allowed text[];
  accepted text[];
  failed_names text[];
  result_keys text[];
begin
  allowed := case capability_name
    when 'notes' then array['BRAIN_REPO', 'GITHUB_TOKEN']
    when 'reader-anthropic' then array['ANTHROPIC_API_KEY']
    when 'reader-openai' then array['OPENAI_API_KEY']
    when 'reader-google' then array['GEMINI_API_KEY']
    when 'mirror' then array['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY']
    when 'cache' then array['KV_REST_API_URL', 'KV_REST_API_TOKEN']
    when 'alerts' then array['RESEND_API_KEY', 'OPS_ALERT_TO', 'OPS_ALERT_FROM']
    else null
  end;
  if allowed is null or completion_state is null or completion_state not in ('finished', 'uncertain')
    or result_value is null or jsonb_typeof(result_value) is distinct from 'object'
    or octet_length(result_value::text) > 4096 then
    return false;
  end if;
  select array_agg(key order by key) into result_keys from jsonb_object_keys(result_value) key;
  if result_keys is distinct from array['accepted', 'failed', 'state'] then return false; end if;
  if jsonb_typeof(result_value->'accepted') is distinct from 'array' or jsonb_array_length(result_value->'accepted') > 8
    or jsonb_typeof(result_value->'failed') is distinct from 'array' or jsonb_array_length(result_value->'failed') > 8 then
    return false;
  end if;
  if exists (
    select 1 from jsonb_array_elements(result_value->'accepted') item
    where jsonb_typeof(item) is distinct from 'string'
  ) or exists (
    select 1 from jsonb_array_elements(result_value->'failed') item
    where jsonb_typeof(item) is distinct from 'object'
      or (select array_agg(key order by key) from jsonb_object_keys(item) key) is distinct from array['code', 'name']
      or jsonb_typeof(item->'name') is distinct from 'string'
      or jsonb_typeof(item->'code') is distinct from 'string'
      or item->>'code' not in ('provider_rejected', 'completion_unconfirmed')
      or not ((item->>'name') = any(allowed))
  ) then return false; end if;
  select coalesce(array_agg(value order by value), array[]::text[]) into accepted
    from jsonb_array_elements_text(result_value->'accepted') value;
  select coalesce(array_agg(item->>'name' order by item->>'name'), array[]::text[]) into failed_names
    from jsonb_array_elements(result_value->'failed') item;
  if exists (select 1 from unnest(accepted) name where not (name = any(allowed)))
    or cardinality(accepted) + cardinality(failed_names) <> cardinality(allowed)
    or cardinality(array(select distinct name from unnest(accepted || failed_names) name)) <> cardinality(allowed)
    or exists (select 1 from unnest(allowed) name where not (name = any(accepted || failed_names))) then
    return false;
  end if;
  if completion_state = 'uncertain' then
    return coalesce(result_value->>'state' = 'uncertain'
      and cardinality(accepted) = 0
      and not exists (
        select 1 from jsonb_array_elements(result_value->'failed') item
        where item->>'code' <> 'completion_unconfirmed'
      ), false);
  end if;
  return coalesce(result_value->>'state' in ('saved-pending-deployment', 'partial')
    and ((result_value->>'state' = 'saved-pending-deployment') = (cardinality(failed_names) = 0))
    and not exists (
      select 1 from jsonb_array_elements(result_value->'failed') item
      where item->>'code' <> 'provider_rejected'
    ), false);
exception when others then
  return false;
end
$$;

alter table public.console_configuration_requests
  add constraint console_configuration_requests_result_shape check (
    (state = 'running' and result is null and acknowledged_at is null)
    or (state = 'finished' and result is not null and acknowledged_at is null
      and public.console_configuration_result_valid(capability, 'finished', result))
    or (state = 'uncertain' and (result is null
      or public.console_configuration_result_valid(capability, 'uncertain', result)))
  );

create function public.console_configuration_admit(
  request_key uuid,
  input_fingerprint text,
  capability_name text,
  target_name text,
  expected_revision bigint
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
set statement_timeout = '5s'
as $$
#variable_conflict use_variable
declare
  v_request_key uuid := request_key;
  v_fingerprint text := input_fingerprint;
  v_capability text := capability_name;
  v_target text := target_name;
  v_expected bigint := expected_revision;
  existing public.console_configuration_requests;
  state_row public.console_configuration_state;
  active_row public.console_configuration_requests;
  inserted public.console_configuration_requests;
  token uuid;
  key_millis bigint;
  key_time timestamptz;
begin
  perform pg_catalog.pg_advisory_xact_lock(785423771);

  select * into existing from public.console_configuration_requests r where r.request_key = v_request_key;
  if found then
    if existing.input_fingerprint is distinct from v_fingerprint
      or existing.capability is distinct from v_capability
      or existing.target is distinct from v_target
      or existing.starting_revision is distinct from v_expected then
      return jsonb_build_object('outcome', 'key_conflict');
    end if;
    return jsonb_build_object(
      'outcome', 'replay',
      'record', public.console_configuration_record(existing, coalesce(existing.completed_revision, existing.acknowledged_revision, existing.starting_revision))
    );
  end if;

  if v_request_key is null or v_fingerprint is null or v_fingerprint !~ '^[0-9a-f]{64}$'
    or v_capability is null or v_capability not in ('notes', 'reader-anthropic', 'reader-openai', 'reader-google', 'mirror', 'cache', 'alerts')
    or v_target is null
    or length(v_target) > 300
    or v_target !~ '^vercel:prj_[A-Za-z0-9]{1,100}:(personal|team_[A-Za-z0-9]{1,100}):(production|preview)$'
    or v_expected is null or v_expected < 0
    or substring(v_request_key::text, 15, 1) <> '7'
    or substring(v_request_key::text, 20, 1) not in ('8', '9', 'a', 'b') then
    return jsonb_build_object('outcome', 'invalid');
  end if;

  key_millis := (('x' || substring(v_request_key::text, 1, 8) || substring(v_request_key::text, 10, 4))::bit(48)::bigint);
  key_time := pg_catalog.to_timestamp(key_millis::double precision / 1000.0);
  if key_time < pg_catalog.clock_timestamp() - interval '5 minutes'
    or key_time > pg_catalog.clock_timestamp() + interval '1 minute' then
    return jsonb_build_object('outcome', 'expired');
  end if;

  delete from public.console_configuration_requests r
   where r.updated_at < pg_catalog.clock_timestamp() - interval '30 days'
     and (r.state = 'finished' or (r.state = 'uncertain' and r.acknowledged_at is not null))
     and not exists (
       select 1 from public.console_configuration_state s where s.current_request = r.request_key
     );
  if (select count(*) from public.console_configuration_requests) >= 2000 then
    return jsonb_build_object('outcome', 'capacity');
  end if;

  select * into state_row from public.console_configuration_state s
    where s.capability = v_capability and s.target = v_target for update;
  if found then
    if state_row.revision <> v_expected then return jsonb_build_object('outcome', 'stale'); end if;
    select * into active_row from public.console_configuration_requests r where r.request_key = state_row.current_request;
    if active_row.state = 'running' or (active_row.state = 'uncertain' and active_row.acknowledged_at is null) then
      return jsonb_build_object('outcome', 'active');
    end if;
  elsif v_expected <> 0 then
    return jsonb_build_object('outcome', 'stale');
  end if;

  token := gen_random_uuid();
  insert into public.console_configuration_requests(
    request_key, input_fingerprint, capability, target, starting_revision, state, claim_token
  ) values (v_request_key, v_fingerprint, v_capability, v_target, v_expected, 'running', token)
  returning * into inserted;
  insert into public.console_configuration_state(capability, target, revision, current_request)
    values(v_capability, v_target, v_expected, v_request_key)
    on conflict(capability, target) do update
      set current_request = excluded.current_request, updated_at = pg_catalog.clock_timestamp();
  return jsonb_build_object(
    'outcome', 'admitted',
    'record', public.console_configuration_record(inserted, v_expected),
    'claimToken', token
  );
end
$$;

create function public.console_configuration_publish(
  capability_name text,
  target_name text,
  request_key uuid,
  claim_token uuid,
  completion_state text,
  result_value jsonb
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
set statement_timeout = '5s'
as $$
#variable_conflict use_variable
declare
  v_capability text := capability_name;
  v_target text := target_name;
  v_key uuid := request_key;
  v_token uuid := claim_token;
  v_completion text := completion_state;
  v_result jsonb := result_value;
  receipt public.console_configuration_requests;
  state_row public.console_configuration_state;
begin
  select * into receipt from public.console_configuration_requests r where r.request_key = v_key for update;
  if not found or v_capability is null or v_target is null or v_key is null or v_token is null
    or v_completion is null or v_result is null then
    return jsonb_build_object('outcome', 'stale', 'record', null);
  end if;
  select * into state_row from public.console_configuration_state s
    where s.capability = receipt.capability and s.target = receipt.target for update;
  if receipt.capability is distinct from v_capability or receipt.target is distinct from v_target
    or receipt.claim_token is distinct from v_token or receipt.state is distinct from 'running'
    or state_row.current_request is distinct from receipt.request_key then
    return jsonb_build_object(
      'outcome', 'stale',
      'record', public.console_configuration_record(receipt, coalesce(receipt.completed_revision, receipt.acknowledged_revision, receipt.starting_revision))
    );
  end if;
  if not public.console_configuration_result_valid(v_capability, v_completion, v_result) then
    return jsonb_build_object(
      'outcome', 'invalid',
      'record', public.console_configuration_record(receipt, receipt.starting_revision)
    );
  end if;
  if v_completion = 'finished' then
    update public.console_configuration_state s
      set revision = s.revision + 1, updated_at = pg_catalog.clock_timestamp()
      where s.capability = v_capability and s.target = v_target
      returning * into state_row;
    update public.console_configuration_requests r
      set state = 'finished', completed_revision = state_row.revision, result = v_result, updated_at = pg_catalog.clock_timestamp()
      where r.request_key = v_key returning * into receipt;
  else
    update public.console_configuration_requests r
      set state = 'uncertain', result = v_result, updated_at = pg_catalog.clock_timestamp()
      where r.request_key = v_key returning * into receipt;
  end if;
  return jsonb_build_object(
    'outcome', 'published',
    'record', public.console_configuration_record(receipt, coalesce(receipt.completed_revision, receipt.acknowledged_revision, receipt.starting_revision))
  );
end
$$;

create function public.console_configuration_acknowledge(
  capability_name text,
  target_name text,
  request_key uuid
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
set statement_timeout = '5s'
as $$
#variable_conflict use_variable
declare
  v_capability text := capability_name;
  v_target text := target_name;
  v_key uuid := request_key;
  receipt public.console_configuration_requests;
  state_row public.console_configuration_state;
begin
  select * into receipt from public.console_configuration_requests r where r.request_key = v_key for update;
  if not found or v_capability is null or v_target is null or v_key is null then
    return jsonb_build_object('outcome', 'not_unresolved');
  end if;
  select * into state_row from public.console_configuration_state s
    where s.capability = receipt.capability and s.target = receipt.target for update;
  if receipt.capability is distinct from v_capability or receipt.target is distinct from v_target
    or state_row.current_request is distinct from receipt.request_key
    or receipt.state not in ('running', 'uncertain') or receipt.acknowledged_at is not null then
    return jsonb_build_object('outcome', 'not_unresolved');
  end if;
  update public.console_configuration_state s
    set revision = s.revision + 1, updated_at = pg_catalog.clock_timestamp()
    where s.capability = v_capability and s.target = v_target returning * into state_row;
  update public.console_configuration_requests r
    set state = 'uncertain', acknowledged_at = pg_catalog.clock_timestamp(),
      acknowledged_revision = state_row.revision, updated_at = pg_catalog.clock_timestamp()
    where r.request_key = v_key returning * into receipt;
  return jsonb_build_object(
    'outcome', 'acknowledged',
    'record', public.console_configuration_record(receipt, state_row.revision)
  );
end
$$;

create function public.console_configuration_get(
  request_key uuid default null,
  capability_name text default null,
  target_name text default null
)
returns setof jsonb
language sql
stable
security invoker
set search_path = ''
set statement_timeout = '5s'
as $$
  select rows.value from (
    select public.console_configuration_record(r, coalesce(r.completed_revision, r.acknowledged_revision, r.starting_revision)) as value
      from public.console_configuration_requests r
     where request_key is not null and r.request_key = request_key
    union all
    select public.console_configuration_record(r, s.revision) as value
      from public.console_configuration_state s
      join public.console_configuration_requests r on r.request_key = s.current_request
     where request_key is null
       and (capability_name is null or s.capability = capability_name)
       and (target_name is null or s.target = target_name)
  ) rows
  order by rows.value->>'updated_at' desc
  limit 32
$$;

revoke all on function public.console_configuration_record(public.console_configuration_requests, bigint) from public, anon, authenticated;
revoke all on function public.console_configuration_result_valid(text, text, jsonb) from public, anon, authenticated;
revoke all on function public.console_configuration_admit(uuid, text, text, text, bigint) from public, anon, authenticated;
revoke all on function public.console_configuration_publish(text, text, uuid, uuid, text, jsonb) from public, anon, authenticated;
revoke all on function public.console_configuration_acknowledge(text, text, uuid) from public, anon, authenticated;
revoke all on function public.console_configuration_get(uuid, text, text) from public, anon, authenticated;
grant execute on function public.console_configuration_admit(uuid, text, text, text, bigint) to service_role;
grant execute on function public.console_configuration_publish(text, text, uuid, uuid, text, jsonb) to service_role;
grant execute on function public.console_configuration_acknowledge(text, text, uuid) to service_role;
grant execute on function public.console_configuration_get(uuid, text, text) to service_role;
grant execute on function public.console_configuration_record(public.console_configuration_requests, bigint) to service_role;
grant execute on function public.console_configuration_result_valid(text, text, jsonb) to service_role;
