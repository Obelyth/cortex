-- One round trip for the whole bubble read — and exact numbers, which the two-call shape could
-- not give. The review proved the seam: a limit with no count meant every surface presented the
-- fetched page as the universe, so item #101 was invisible everywhere while the sweep quietly
-- aged it out — the silent-loss failure, in the one table git cannot rebuild. And sweep-then-
-- select doubled the boot path's exposure to a slow store.
--
-- bubble_open sweeps, counts, and returns in a single transaction: the sweep count and the TRUE
-- open total ride with the page, so a render can state exactly what it is not showing.
create or replace function bubble_open(max_age_days integer default 14, max_items integer default 200)
returns jsonb
language plpgsql
as $$
declare
  swept integer;
  total integer;
  items jsonb;
begin
  update bubble_items
     set status = 'aged'
   where status = 'open'
     and touched_at < now() - make_interval(days => max_age_days);
  get diagnostics swept = row_count;

  select count(*)::integer into total from bubble_items where status = 'open';

  select coalesce(jsonb_agg(t), '[]'::jsonb) into items
  from (
    select id, kind, project, body, status, filed_into, surface, created_at, touched_at
      from bubble_items
     where status = 'open'
     order by touched_at desc
     limit max_items
  ) t;

  return jsonb_build_object('total', total, 'swept', swept, 'items', items);
end
$$;

revoke execute on function bubble_open(integer, integer) from public;
revoke execute on function bubble_open(integer, integer) from anon;
revoke execute on function bubble_open(integer, integer) from authenticated;

-- Superseded by bubble_open before anything shipped; two functions with overlapping duties is
-- how the next reader calls the wrong one.
drop function if exists bubble_sweep(integer);
