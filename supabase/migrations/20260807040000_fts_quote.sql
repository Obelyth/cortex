-- Quote the lexemes before handing them to to_tsquery.
--
-- The disjunctive rewrite concatenated raw lexemes into a query string, which means the CONTENT of
-- a lexeme was being parsed as query SYNTAX. Fuzzing found no input that broke it — the english
-- configuration strips quotes and operators during tokenisation, so "a'|'b", "don't 'quote' me"
-- and "x' | 'y" all reduce to harmless words. That is empirical safety: a statement about the
-- inputs that were tried, not about the ones that exist.
--
-- quote_literal makes it structural. Every lexeme becomes a quoted term with its internal quotes
-- doubled, so no lexeme content can ever be read as an operator, regardless of the text search
-- configuration this function is later pointed at. The failure mode being closed is not "wrong
-- results" but "exception on the read path", which is the one outcome the original comment
-- promised could not happen.
--
-- Lexemes are already dictionary-normalised, so re-processing them as quoted terms is idempotent;
-- the retrieval eval is unchanged by this migration (91.2% recall@10, verified before and after).
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
  where n.path like '%.md'
    and n.fts @@ query.tsq
  order by ts_rank(n.fts, query.tsq) desc, n.path asc
  limit greatest(1, least(coalesce(k, 10), 100));
$$;

revoke execute on function search_notes(text, integer) from public;
revoke execute on function search_notes(text, integer) from anon;
revoke execute on function search_notes(text, integer) from authenticated;

comment on function search_notes(text, integer) is
  'Ranks live notes against a question using the stored FTS index, disjunctively over quoted '
  'lexemes. Never filters by temperature: reaching cold material is the reason this exists. '
  'NOT the default narrower — BM25 beat it on the labelled set (see spec 10.1).';
