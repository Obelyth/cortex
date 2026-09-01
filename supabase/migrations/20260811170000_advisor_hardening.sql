-- Two findings from Supabase's own security linter (2026-08-11 advisor run), closed here.
-- Neither is exploitable today — every table already carries deny-all RLS and the server reaches
-- Postgres with the service role only — but both are defaults that bite the day something else
-- changes, which is exactly when nobody is looking at function definitions.
--
-- 1. FOUR FUNCTIONS RESOLVE NAMES THROUGH THE CALLER'S search_path (linter 0011).
--
-- A function without a pinned search_path looks tables and operators up in whatever path the
-- CALLING role happens to have. For a SECURITY INVOKER function called by the service role that
-- is harmless right now — but it means the function's meaning depends on session state it does
-- not control, and a future caller (a new role, a pooler default, an extension schema) can
-- change what `notes` resolves to without touching this code. Pin it: these functions mean the
-- public schema, so say so in the definition.
alter function public.bubble_open(max_age_days integer, max_items integer)
  set search_path = public, pg_catalog;
alter function public.propose_deletions(min_age_days integer)
  set search_path = public, pg_catalog;
alter function public.search_notes(q text, k integer)
  set search_path = public, pg_catalog;
alter function public.sync_apply(expected_head text, new_head text, upserts jsonb, removes text[])
  set search_path = public, pg_catalog;

-- 2. EVERY RPC IS CALLABLE BY anon/authenticated OVER REST (linters 0028/0029 flagged the
--    SECURITY DEFINER one; the same default grant covers the rest).
--
-- Supabase's default privileges hand EXECUTE on new public functions to anon and authenticated,
-- so all five functions are reachable at /rest/v1/rpc/<name> with the publishable key. The four
-- INVOKER functions currently dead-end on deny-all RLS, and rls_auto_enable() only turns RLS ON
-- (its failure mode is over-protection) — but this database has exactly one legitimate caller,
-- the server on the service role. A door nobody should walk through gets locked, not monitored.
-- service_role keeps its own grant; nothing the server does changes.
revoke execute on function public.bubble_open(max_age_days integer, max_items integer)
  from anon, authenticated;
revoke execute on function public.propose_deletions(min_age_days integer)
  from anon, authenticated;
revoke execute on function public.search_notes(q text, k integer)
  from anon, authenticated;
revoke execute on function public.sync_apply(expected_head text, new_head text, upserts jsonb, removes text[])
  from anon, authenticated;
revoke execute on function public.rls_auto_enable()
  from anon, authenticated;
