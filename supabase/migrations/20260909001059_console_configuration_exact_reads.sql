-- Correct the read function's parameter/column ambiguity without changing its public signature.
-- The historical migration may already be applied, so this is intentionally forward-only.

create or replace function public.console_configuration_get(
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
    select public.console_configuration_record(r, coalesce(r.completed_revision, r.acknowledged_revision, r.starting_revision)) as value,
      r.updated_at as sort_at
      from public.console_configuration_requests r
     where $1 is not null and r.request_key = $1
    union all
    select public.console_configuration_record(r, s.revision) as value,
      r.updated_at as sort_at
      from public.console_configuration_state s
      join public.console_configuration_requests r on r.request_key = s.current_request
     where $1 is null
       and ($2 is null or s.capability = $2)
       and ($3 is null or s.target = $3)
  ) rows
  order by rows.sort_at desc
  limit 32
$$;

revoke all on function public.console_configuration_get(uuid, text, text) from public, anon, authenticated;
grant execute on function public.console_configuration_get(uuid, text, text) to service_role;
