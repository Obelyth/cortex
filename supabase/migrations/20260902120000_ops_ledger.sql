-- The ops ledger: what is expected to run (ops_units), what actually ran (ops_runs), and the
-- append-only receipt trail (ops_events). Spec: docs/superpowers/specs/2026-09-02-cortex-
-- mission-control-design.md §4. States are never stored as a reporter's adjective — the server
-- derives them from the clock and evidence (lib/ops-state.ts) and the stored `state` column on
-- ops_runs is the last derived value, kept so the sweep can detect transitions.
--
-- RLS is enabled with no policies on purpose: only the service-role key (server) reaches these
-- tables; anon and authenticated see nothing. Same posture as bubble_items.

create table if not exists ops_units (
  id            text primary key,
  kind          text not null check (kind in ('routine','machine','agent','operator','item')),
  name          text not null,
  owner         text not null default 'none' check (owner in ('manager','indexer','retrieval','none')),
  period_s      integer,                 -- null = no schedule (items, agents)
  grace_s       integer not null default 1800,
  max_run_s     integer not null default 1200,
  pages         boolean not null default true,
  tolerance     integer not null default 1,   -- consecutive failures before a page
  paused_until  timestamptz,
  run_now       jsonb,                    -- {"kind":"dispatch"|"link","target":"..."}
  notes         text,
  created_at    timestamptz not null default now()
);
alter table ops_units enable row level security;

create table if not exists ops_runs (
  id            bigint generated always as identity primary key,
  unit_id       text not null references ops_units(id) on delete cascade,
  run_key       text not null,
  trigger       text not null default 'cron' check (trigger in ('cron','manual','retry','webhook','heartbeat')),
  scheduled_at  timestamptz,
  started_at    timestamptz,
  ended_at      timestamptz,
  lease_until   timestamptz,
  state         text not null default 'scheduled',
  exit_reason   text check (exit_reason in ('code','infra','timeout','no_signal','question')),
  attempt       integer not null default 1,
  summary       text check (char_length(summary) <= 280),
  error         text,
  evidence      jsonb not null default '[]'::jsonb,
  cost          jsonb,
  facts         jsonb,
  updated_at    timestamptz not null default now(),
  unique (unit_id, run_key)
);
create index if not exists ops_runs_unit_started on ops_runs (unit_id, started_at desc);
alter table ops_runs enable row level security;

create table if not exists ops_events (
  id            bigint generated always as identity primary key,
  unit_id       text not null references ops_units(id) on delete cascade,
  run_id        bigint references ops_runs(id) on delete set null,
  at            timestamptz not null default now(),
  actor         text not null check (actor in ('unit','sweep','operator','guest')),
  kind          text not null check (kind in ('start','finish','heartbeat','transition','ack','snooze','pause','resume','run_now','alert_sent','alert_failed','read')),
  from_state    text,
  to_state      text,
  body          jsonb not null default '{}'::jsonb
);
create index if not exists ops_events_at on ops_events (at desc);
create index if not exists ops_events_unit_at on ops_events (unit_id, at desc);
alter table ops_events enable row level security;
