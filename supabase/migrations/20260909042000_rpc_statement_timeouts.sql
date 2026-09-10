-- Forward repair: every service RPC carries its own statement timeout. The 8-second fetch abort
-- in the application cancels nothing on the server; PostgREST hoists a function's
-- statement_timeout into the calling transaction, and a direct native call alone does not.
-- These twelve functions shipped without one (two of them hold pg_advisory_xact_lock(763541,1)
-- unbounded). ALTER FUNCTION ... SET changes the setting only; no body or grant is touched.
-- corpus_snapshot() received its larger 30 s bound in 20260909041500_pinned_live_corpus_snapshot.sql.
alter function public.bubble_open_scoped(integer, integer, text, boolean) set statement_timeout = '5s';
alter function public.bubble_console_add(uuid, text, text, text) set statement_timeout = '5s';
alter function public.bubble_console_edit(bigint, bigint, text, text, text, boolean) set statement_timeout = '5s';
alter function public.bubble_console_list(text, timestamptz, bigint, integer) set statement_timeout = '5s';
alter function public.bubble_console_item(bigint) set statement_timeout = '5s';
alter function public.console_device_list() set statement_timeout = '5s';
alter function public.console_device_register(uuid, timestamptz, text, text, text, uuid) set statement_timeout = '5s';
alter function public.console_device_rename(uuid, timestamptz, text) set statement_timeout = '5s';
alter function public.console_device_forget(uuid, timestamptz) set statement_timeout = '5s';
alter function public.console_device_visit(uuid) set statement_timeout = '5s';
alter function public.edges_usage_identity() set statement_timeout = '5s';
