-- The corpus mirror, the sync ledger, and the access log.
--
-- GIT IS THE AUTHORITY FOR EVERY ROW IN `notes`. This schema stores nothing that cannot be
-- rebuilt from the brain repo at a commit: `commit_sha` records exactly which commit each row's
-- content came from, and the reconciler's contract is that backfill equals "reconcile from empty".
-- If this database vanished, the mirror is one tarball fetch from whole again. (The classes that
-- WILL be authoritative here — the bubble, scores — arrive in later phases with point-in-time
-- recovery as their safety net; nothing in this migration is one of them.)

-- One row per live note, byte-identical to the file at `commit_sha`.
--
-- Content is stored verbatim and never rewritten: the deterministic verifier proves quotes
-- against file bytes, so a mirror that normalised line endings or trimmed whitespace would break
-- citations on exactly the notes it touched. `bytes` is generated, not written, so it cannot
-- drift from the content it measures.
create table if not exists notes (
  path        text primary key,
  content     text not null,
  bytes       integer not null generated always as (octet_length(content)) stored,
  commit_sha  text not null,
  mirrored_at timestamptz not null default now()
);

-- What head the mirror believes it reflects. A single row, enforced by the check — two rows
-- claiming different heads would make "is the mirror current" unanswerable.
create table if not exists sync_state (
  id        boolean primary key default true,
  head_sha  text not null,
  synced_at timestamptz not null default now(),
  constraint sync_state_singleton check (id)
);

-- Note-level access log — the temperature groundwork (spec §7.4).
--
-- Nothing in phase 2 reads this table. It exists now because scores need history and usage
-- history cannot be backfilled: by the time the library is big enough to need grading, the
-- grades need months of data behind them. One row per note actually served to a caller.
-- Aggregation, decay and pruning arrive with pg_cron in phase 4; until then this only grows,
-- which at row-per-read scale is well within a Pro project's headroom.
create table if not exists note_access (
  id      bigint generated always as identity primary key,
  at      timestamptz not null default now(),
  path    text not null,
  -- which tool served the note: brain_read | brain_corpus | brain_ask | brain_context
  tool    text not null,
  -- which door the call came through: terminal | connector | guest | "" when unknown
  surface text not null default '',
  -- how the note was chosen: paths | question | listing | full | boot | "" when n/a
  mode    text not null default ''
);

-- The two questions phase 4 will ask: "how has THIS note been used" and "what was used lately".
create index if not exists note_access_path_at on note_access (path, at desc);
create index if not exists note_access_at on note_access (at desc);

-- Deny-by-default for the anon/publishable key: RLS enabled, no policies. The server talks to
-- these tables with the service key, which bypasses RLS; nothing else has any business here.
alter table notes enable row level security;
alter table sync_state enable row level security;
alter table note_access enable row level security;
