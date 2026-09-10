-- Keep every actor installation-neutral, including new console actions.
alter table public.ops_events drop constraint ops_events_actor_check;
alter table public.ops_events add constraint ops_events_actor_check
  check(actor in ('unit','sweep','operator','guest','console'));

-- This empty table does not mark an existing installation pristine. Only the explicit,
-- proven-empty administrator bootstrap inserts the one marker inside its transaction.
create table public.cortex_installation (
  id boolean primary key default true check(id),
  mode text not null check(mode='pristine'),
  installed_at timestamptz not null default now()
);
alter table public.cortex_installation enable row level security;
revoke all on public.cortex_installation from public,anon,authenticated;
grant select on public.cortex_installation to service_role;

-- Supabase projects no longer share one implicit public-schema privilege baseline. Cortex is
-- service-only, so make both sides explicit for every object created by the migration chain.
revoke usage on schema public from public,anon,authenticated;
grant usage on schema public to service_role;
revoke all on all tables in schema public from public,anon,authenticated;
grant select,insert,update,delete on all tables in schema public to service_role;
revoke insert,update,delete on public.schema_migrations,public.cortex_installation from service_role;
revoke all on all sequences in schema public from public,anon,authenticated;
grant usage,select on all sequences in schema public to service_role;
revoke execute on all functions in schema public from public,anon,authenticated;
grant execute on all functions in schema public to service_role;
