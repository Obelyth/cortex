# The learning layer — passive-but-smart

**Decided 2026-08-11 by the deployment owner:** the brain learns as we go and thinks ahead, but stays
**passive**. The decision approved usage-learning (layer 1) and structure-learning (layer 2) and
rejected the proactive/push layer outright — "no AI slop." This spec is those two layers,
plus the response-caching work, because they share one insight: *the corpus at a commit is
immutable, so anything derived from it — a ranking, a graph, an answer — can be cached,
replayed, and rebuilt without ever becoming a second source of truth.*

## The laws (non-negotiable, they are why this brain beats the field)

1. **Learned ≠ asserted.** Everything this layer produces is *derived* — rebuildable from
   git + the access log, stored in Postgres alongside temperatures, never written into a
   note. No generated prose enters the corpus. Deleting every derived table loses nothing
   but warm-up time.
2. **Passive surfacing only.** Learning changes what gets *loaded, ranked, and assembled* —
   boot, handoff bundles, ask narrowing, the console. It never initiates contact and never
   writes. The attention inbox (which the owner opens themselves) is the outermost surface allowed.
3. **No model calls in v1.** Every mechanism below is lexical, structural, or statistical.
   Embeddings stay behind the measured trigger (the 1.8% situation-vocabulary gap in
   ROADMAP.md); fine-tuning on the corpus is permanently out — weights can't cite and can't
   unlearn, and receipts are the product.
4. **Measured gates, same as FTS.** A ranking change ships only if it beats the incumbent on
   `scripts/eval-retrieval.ts` (97.6% recall@10 to beat) or on the new prediction eval
   (below). FTS lost and stayed off the default path; this layer plays by the identical rule.

## Layer 1 — usage learning: the brain pre-assembles what you're about to need

**Data already collecting:** `note_access` (since 08-06), the bubble, the call log,
day-log tags, commit history. Nothing new to instrument.

- **Co-access edges.** A materialized view over `note_access`: P(note B touched | note A
  touched within the same session/hour window). Nightly `pg_cron` refresh, pure SQL.
  Cold-start prior: directory + shared tags + explicit `[[links]]`, so day one isn't random.
- **The product surface is `brain_handoff` (roadmap #5), made anticipatory.** A bundle =
  project page + open bubble items for that project + recent log mentions + top co-accessed
  and linked notes, ranked by temperature × co-access × link weight, budgeted like the boot
  call. The groundskeeper pre-warms bundles nightly for projects with open bubble items —
  "think ahead" means the bundle exists before the session that needs it.
- **Router gets a "likely next" tilt.** Ordering/elision already runs on temperature; add
  the co-access term for projects active in the bubble. Boot budget unchanged.

**Prediction eval (the gate for all of layer 1):** replay history — for each recorded
session, hide it, predict from prior state which notes it touches, score recall@k against
what it actually touched. Deterministic, zero model calls, free to run on every PR, exactly
like eval-retrieval. Temperature-only ranking is the baseline that must be beaten.

## Layer 2 — structure learning: the connections graph

**`note_edges` (src, dst, kind, weight, evidence)** — kinds: `link` (explicit `[[..]]`),
`tag`, `coaccess` (from layer 1), `lexical` (pairwise BM25 over blocks, free), `correction`
((was:) chains and supersede references spanning notes). **The `evidence` column is
load-bearing:** every edge names the block/lines that justify it, so the graph is provable
the same way an answer is. Rebuilt nightly from scratch; never hand-edited.

Surfaces, all passive:
- **Ask narrowing gets one graph hop:** candidates = BM25 top-k ∪ 1-hop neighbors of the
  top hits. Ships only if eval-retrieval says it beats 97.6/95.3 — otherwise it stays a
  query surface like `search_notes()`.
- **Handoff bundles** pull 1-hop neighbors of the project page.
- **Console:** the corpus screen gains a connections panel per note (edges + their
  evidence, click-through); the map can draw real edges instead of rings-only.
- **Inbox watch items, mechanical only:** a note whose live text links a SUPERSEDED note; a
  high-co-access pair with no explicit link (suggested link, evidence attached); a
  correction chain that spans notes. These enter the existing attention queue with the
  existing leave-by-the-note-changing mechanics. No model-inferred "insights" — that was
  layer 3, and it's rejected.

## Caching — the ask gets cheap

Serving is already ~free (compute cost is effectively a rounding error); the only real spend is
**reader input tokens on `brain_ask` (~32k/ask, measured)**. Two caches, both keyed on the
thing that makes them honest — the corpus head commit:

1. **Answer cache.** Key: `(normalised question, corpus head SHA, reader model, scope)` →
   stored answer + citations + verdict, in KV/Postgres. A hit costs zero model calls and is
   marked `cached · answered at <commit>` — honest by construction, because the corpus at
   that commit is immutable and the verification stamp was computed against it.
   Invalidation is free: any brain write moves the head, which changes the key. Roll out on
   the **guest door first** (repeat-heavy, budget-capped — a cache hit shouldn't charge the
   daily budget), then trusted doors.
2. **Prompt caching on the reader call.** Restructure the ask prompt as
   `[stable: system + note pack] [variable: question]` with a cache breakpoint after the
   pack. Between commits the pack is byte-identical, so burst usage (a session asking five
   questions, an eval run) pays the write once (+25%) and reads at −90%. Side effect: the
   204-label eval drops from ~6.5M effective input tokens to roughly a sixth of that.

**Deliberately uncached:** the console (its whole claim is that its numbers are true — the
stale-read lever stays unpulled, as decided 2026-08-09) and anything on the write path.

## Sequencing

- **v1 — the money and the graph skeleton:** answer cache + prompt caching (immediate,
  self-contained); `note_edges` nightly rebuild + the console connections panel.
- **v2 — prediction:** the prediction eval, co-access ranking into handoff bundles,
  groundskeeper pre-warm. This *is* the roadmap's `brain_handoff`, specced.
- **v3 — retrieval and hygiene:** graph-hop narrowing behind the eval gate; the three
  mechanical inbox checks.

## Non-goals, recorded

No fine-tuning or training on the corpus, ever — it breaks freshness, provenance, and
correction at once. No push/webhook nudges and no model-initiated writes (decided
2026-08-11 — this reframes roadmap #8: at most mechanical event delivery survives there,
and the brain never speaks first). No embeddings until the measured trigger moves. No new
MCP tools in v1 — the tool surface budget stands; `brain_handoff` arrives with v2 as
already committed on the roadmap.
