-- Full-text search — the arm that makes "cold is one query away" true rather than aspirational.
--
-- Phase 4 stopped rendering cold notes into every conversation. That is only honest if there is a
-- real way to find them again, and the incumbent way is BM25 computed in memory: to narrow 86
-- notes to 10, the server loads all 86 and scores them. The database can do that with an index.
--
-- STORED, not computed on the fly: the tsvector is a generated column so it can be indexed, and
-- so it can never drift from the content beside it. A search index that disagrees with the note
-- is a search index that hides material, which is the failure this whole system is built against.
--
-- Weights encode where a match matters most. The path carries the note's name and directory
-- ('harbor', 'projects'), which is the strongest signal a query can hit; the body is the mass of
-- the evidence. Postgres ranks A above B above C, so a question naming a note finds that note
-- even when a dozen others discuss it.
alter table notes
  add column if not exists fts tsvector
  generated always as (
    setweight(to_tsvector('english', coalesce(replace(replace(path, '/', ' '), '-', ' '), '')), 'A')
    || setweight(to_tsvector('english', coalesce(content, '')), 'C')
  ) stored;

create index if not exists notes_fts on notes using gin (fts);

/*
 * search_notes — rank the corpus against a question, cheaply, in the database.
 *
 * websearch_to_tsquery, not plainto_tsquery: it understands quoted phrases and OR the way a
 * person actually types a question, and — critically — it does not throw on punctuation. A
 * search function that errors on an apostrophe would take down the read path it is meant to
 * serve, so the parse is the forgiving one and every failure below degrades to fewer results,
 * never to an exception.
 *
 * Returns rank AND temperature so the caller can decide policy. This function deliberately does
 * NOT filter by temperature: cold material is exactly what search exists to reach, and a search
 * that hid cold notes would close the only door phase 4 left open for them.
 */
create or replace function search_notes(q text, k integer default 10)
returns table (path text, rank real, temperature text)
language sql
stable
as $$
  with query as (
    select websearch_to_tsquery('english', coalesce(nullif(trim(q), ''), 'zzzznomatchzzzz')) as tsq
  )
  select n.path,
         ts_rank(n.fts, query.tsq) as rank,
         coalesce(s.temperature, 'hot') as temperature
  from notes n
  cross join query
  left join note_scores s on s.path = n.path
  where n.path like '%.md'
    and n.fts @@ query.tsq
  order by ts_rank(n.fts, query.tsq) desc, n.path asc
  limit greatest(1, least(coalesce(k, 10), 100));
$$;

revoke execute on function search_notes(text, integer) from public;
revoke execute on function search_notes(text, integer) from anon;
revoke execute on function search_notes(text, integer) from authenticated;

comment on function search_notes(text, integer) is
  'Ranks live notes against a question using the stored FTS index. Never filters by temperature — '
  'reaching cold material is the reason this exists.';
