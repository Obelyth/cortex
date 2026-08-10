-- The first search_notes ANDed its terms, and the eval caught it in one run: 33.5% recall
-- against the incumbent BM25's 97.6%.
--
-- websearch_to_tsquery('english', 'is harbor local-first or is it on vercel') produces
-- 'harbor' & 'local-first' <-> ... | 'vercel' — conjunctive. A question containing ONE word the
-- note happens not to use matches nothing at all, while BM25 ORs the terms and ranks by how many
-- landed. The comparison was never FTS versus BM25; it was AND versus OR wearing FTS's name.
--
-- So the query becomes disjunctive: every lexeme the question reduces to, OR'd, ranked by
-- ts_rank. Recall stops depending on the question's least common word, and the weights (path A,
-- body C) still decide the order.
--
-- Building the query from to_tsvector's own lexemes rather than by splitting on whitespace is
-- deliberate: it applies the SAME stemming and stopword list the index was built with, so the
-- query can never contain a form the index does not. Hand-splitting is how a search function
-- develops a private, slightly-wrong idea of what a word is.
create or replace function search_notes(q text, k integer default 10)
returns table (path text, rank real, temperature text)
language sql
stable
as $$
  with lex as (
    -- Lexemes of the question, in the index's own vocabulary. Empty for a question that is all
    -- stopwords, which the guard below turns into "no results" rather than an error.
    select string_agg(lexeme, ' | ') as ored
    from unnest(to_tsvector('english', coalesce(q, '')))
  ),
  query as (
    select to_tsquery('english', coalesce(nullif(lex.ored, ''), 'zzzznomatchzzzz')) as tsq
    from lex
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
  'Ranks live notes against a question using the stored FTS index, DISJUNCTIVELY — an AND query '
  'made recall depend on the question''s rarest word. Never filters by temperature: reaching cold '
  'material is the reason this exists.';
