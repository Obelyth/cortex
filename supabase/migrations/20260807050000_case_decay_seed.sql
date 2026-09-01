-- Three defects found by a full-repo review, plus the honest labelling of three mechanisms that
-- are built but not wired. All of them are cases of the schema and the code — or the schema and
-- itself — disagreeing quietly rather than failing.
--
-- Written as a NEW migration rather than as edits to the files that introduced these definitions,
-- because the runner keys its ledger on filename: editing an applied migration in place leaves
-- the database holding the original definition while the ledger reports it applied. (That gap is
-- now refused outright — scripts/migrate.ts records a checksum per file.)


-- 1. SEED THE SINGLETON, so the compare-and-swap actually locks something.
--
-- sync_apply's guarantee is "exactly one winner", and it rests on
-- `select head_sha into current_head from sync_state where id is true for update`. FOR UPDATE
-- locks ROWS. On a mirror that has never synced there is no row, so it locks nothing: two
-- instances both read current_head = NULL, both pass the `is distinct from` check, and both
-- apply. The loser's older file set lands second and re-inserts paths the winner had deleted —
-- phantom notes that can never appear in a future diff, so they are served as live forever.
--
-- An empty-string head is "synced to nothing", which is exactly what a fresh mirror means, and
-- it is `distinct from` every real sha so the first genuine sync still proceeds normally.
insert into sync_state (id, head_sha) values (true, '') on conflict (id) do nothing;


-- 2. "IS THIS A NOTE" MUST MEAN THE SAME THING IN SQL AS IN TYPESCRIPT.
--
-- lib/corpus.ts:isLive() tests /\.md$/i, case-INsensitively, and says why: a note saved as
-- `Setup.MD` is a note, and the old exact-match test dropped it silently. Every SQL consumer
-- used `like '%.md'`, which in Postgres is case-SENSITIVE. So an uppercase-extension note was a
-- live, mirrored, served corpus row with no score row: no temperature, never returned by
-- search_notes, never a deletion candidate — and the console showed N notes while hot+warm+cold
-- summed to N-1, with nothing on screen explaining the gap.
--
-- 3. BOUND THE DECAY WINDOW.
--
-- access_agg aggregated the ENTIRE note_access table on every evaluation, with a power() and an
-- extract() per row, and note_access is append-only with no prune (the pg_cron rollup promised
-- in the mirror migration never shipped). This view is read once per boot call and five more
-- times per console overview render, and neither existing index can serve an unbounded GROUP BY.
--
-- 180 days is six half-lives at the 30-day constant: a read older than that contributes under 2%
-- of its original weight, so the cutoff changes scores in the fourth decimal place while making
-- the aggregate an index range scan on note_access_at instead of a full table scan.
drop view if exists note_scores;
create view note_scores as
with access_agg as (
  select
    path,
    count(*)                                                as reads,
    max(at)                                                 as last_read,
    sum(power(0.5, extract(epoch from (now() - at)) / 2592000.0)) as decayed_reads
  from note_access
  where at > now() - interval '180 days'
  group by path
),
base as (
  select
    n.path,
    coalesce(n.last_commit_at, n.mirrored_at)               as written_at,
    coalesce(a.reads, 0)                                    as reads,
    a.last_read,
    coalesce(a.decayed_reads, 0)                            as decayed_reads,
    case
      when n.path = 'profile.md'          then 1.00
      when n.path ilike 'projects/%'      then 0.70
      when n.path ilike 'log/%'           then 0.35
      -- archive/ is excluded from the corpus by lib/corpus.ts's SKIP_PREFIX and is no longer a
      -- writable path, so this branch cannot match a mirrored row. Kept as the documented floor
      -- in case the archive is ever admitted to the reader tier.
      when n.path ilike 'archive/%'       then 0.05
      else 0.50
    end                                                     as dir_prior,
    power(0.5, extract(epoch from (now() - coalesce(n.last_commit_at, n.mirrored_at))) / 1814400.0) as write_score
  from notes n
  left join access_agg a on a.path = n.path
  where n.path ilike '%.md'
),
scored as (
  select
    b.*,
    -- Normalised against the busiest note. The `> 0` guard is what keeps a corpus with no access
    -- history at all from dividing by zero — the state every new deployment starts in.
    case when max(b.decayed_reads) over () > 0
         then b.decayed_reads / max(b.decayed_reads) over ()
         else 0 end                                         as access_score,
    round((0.45 * (case when max(b.decayed_reads) over () > 0
                        then b.decayed_reads / max(b.decayed_reads) over ()
                        else 0 end)
         + 0.30 * b.write_score
         + 0.25 * b.dir_prior)::numeric, 4)                 as score
  from base b
)
select
  s.path,
  s.reads,
  s.last_read,
  s.written_at,
  round(s.access_score::numeric, 4) as access_score,
  round(s.write_score::numeric, 4)  as write_score,
  s.dir_prior,
  p.temperature                     as pinned,
  s.score,
  case
    -- A pin is the operator's judgement and outranks every computed band, in both directions.
    when p.temperature is not null then p.temperature
    when s.score >= 0.45 then 'hot'
    when s.score >= 0.20 then 'warm'
    -- THE GUARD: nothing written in the last 7 days is cold, whatever its score. A new note has
    -- no reads BECAUSE it is new, and demoting it would be a self-fulfilling prophecy. Redundant
    -- at today's weights (the arithmetic above cannot produce a sub-0.20 score inside the window)
    -- and deliberately kept, because it becomes load-bearing the moment those weights move.
    when s.written_at > now() - interval '7 days' then 'warm'
    else 'cold'
  end                               as temperature
from scored s
left join note_pins p on p.path = s.path;

revoke all on note_scores from public;
revoke all on note_scores from anon;
revoke all on note_scores from authenticated;


-- The same case fix on the retrieval arm, so search and scoring agree about what a note is.
create or replace function search_notes(q text, k integer default 10)
returns table (path text, rank real, temperature text)
language sql
stable
as $$
  with lex as (
    select string_agg(quote_literal(lexeme), ' | ') as ored
    from unnest(to_tsvector('english', coalesce(q, '')))
  ),
  query as (
    select to_tsquery('english', coalesce(nullif(lex.ored, ''), '''zzzznomatchzzzz''')) as tsq
    from lex
  )
  select n.path,
         ts_rank(n.fts, query.tsq) as rank,
         coalesce(s.temperature, 'hot') as temperature
  from notes n
  cross join query
  left join note_scores s on s.path = n.path
  where n.path ilike '%.md'
    and n.fts @@ query.tsq
  order by ts_rank(n.fts, query.tsq) desc, n.path asc
  limit greatest(1, least(coalesce(k, 10), 100));
$$;

revoke execute on function search_notes(text, integer) from public;
revoke execute on function search_notes(text, integer) from anon;
revoke execute on function search_notes(text, integer) from authenticated;


-- 4. SAY WHICH MECHANISMS ARE NOT WIRED.
--
-- Three things in this schema are built, reviewed, revised — and unreachable from the running
-- server. A reader of these migrations reasonably concludes otherwise, and the console's own
-- "0 deletion candidates" reads as a healthy queue rather than as a queue nothing ever fills.
-- Labelled here rather than deleted, because each is a phase away from being wired and the work
-- is sound; what was wrong was the silence.
comment on function propose_deletions(integer) is
  'UNWIRED as of 2026-08-07: no caller in the application and no scheduler. deletion_candidates '
  'is therefore always empty, and nothing can write its `decision` column either, so the queue '
  'could not drain if it filled. Wire a pg_cron schedule plus console actions before treating '
  'the overview''s candidate count as meaningful.';

comment on table note_pins is
  'UNWIRED as of 2026-08-07: note_scores honours a pin above every computed band, but no tool or '
  'console control can create one — the only way to pin a note today is hand-written SQL.';

comment on function search_notes(text, integer) is
  'Ranks live notes against a question using the stored FTS index, disjunctively over quoted '
  'lexemes. Never filters by temperature: reaching cold material is the reason this exists. '
  'NOT the default narrower — BM25 beat it on the labelled set (see spec 10.1) — and NOT on any '
  'request path: as of 2026-08-07 its only caller is scripts/eval-retrieval.ts. The stored '
  'tsvector and its GIN index are maintained on every upsert for an offline evaluation.';
