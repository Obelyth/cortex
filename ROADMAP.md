<div align="center">

# Roadmap

**Where Cortex is going, and in what order.**

*Dates are directional; the sequence is the commitment. Everything here follows the same
rule as the codebase: a claim must be true or absent — shipped means verified in
production, and nothing below ships without its tests.*

</div>

---

## Shipped — the verified brain

The foundation this roadmap stands on, live today:

- Ten tools over MCP, three doors with distinct trust levels — terminal, connector, guest
- A deterministic verifier: every answer stamped `VERIFIED` / `CORRECTED` / `SUPERSEDED` /
  `NOT IN BRAIN` against the file at its commit
- Pluggable readers — Claude, OpenAI, Gemini on an allowlist; Claude holds the default it
  earned on the labeled eval
- The guest door: scoped ask + proposals, every default failing closed
- A seven-screen console — instruments that answer when clicked, one settings home,
  secrets rendered as presence, never values
- Guided onboarding (`npm run onboard`), ingest with provenance, nightly groundskeeper
  runbook, canonical tool roster pinned by tests

### The context tier — shipped 2026-08

A brain that grows without every conversation paying for the growth. Each of these is opt-in:
with `SUPABASE_URL` unset the server behaves exactly as it did before any of it existed.

- **The router.** Notes describe themselves in frontmatter, and boot loads one line per note —
  path, description, tags, date — instead of raw recent logs. **The always-loaded set is now
  about 4% of the corpus**, and it is the console's headline number precisely because it is the
  one that must not creep.
- **A Postgres serving tier.** The corpus is mirrored to Supabase and served from there, with
  **git remaining the sole authority** — every write is still a commit, and reconciliation is a
  compare between the mirrored head and the live one. Unreachable, behind, or empty all fall
  back to the tarball path rather than serving something wrong.
- **The bubble.** Working memory that survives across sessions and surfaces, so work resumes
  where it stopped instead of being re-explained. The one data class Postgres is authoritative
  for; notes never are.
- **Temperatures.** Hot / warm / cold from access recency and frequency, so the always-loaded
  set is bounded by *score* rather than by existence. Cold material is elided from the router,
  never from the brain, and stays one query away.
- **A retrieval eval.** `scripts/eval-retrieval.ts` scores any narrowing strategy against a
  labelled set, deterministically and without model calls, so a change to retrieval is a
  measurement rather than an argument. It has already declined a feature — see below.

## Q3 2026 — Continuity & Proof

**The brain stops being a place you ask and becomes the place work resumes.**

- **`@obelyth/verify`** — the citation verifier as a standalone package: nonced boundaries,
  block-scoped quotes, retraction-aware stamps, benchmarked in the open. Citation-proof for
  any RAG pipeline or vault — bring your own store, keep the receipts. *Pulled forward from
  2027 (2026-08-11): the verifier is the invention, and it no longer waits behind the
  features it justifies. Cortex becomes its reference implementation on day one.*
- **`brain_handoff`** — one call returns a project's whole working context: its page,
  recent logs, relevant notes, open threads — as one cited bundle. Start in Claude Code,
  continue in Cursor, same context. The groundskeeper keeps bundles warm overnight.
- **The eval, in your hands** — a labels template ships in `brain-template/`, and the
  console surfaces your own `npm run eval` results. "Claude earned the default" becomes
  your deployment's own measurement, on your corpus. Any reader can take the chair by
  winning on your test.

## Q4 2026 — Teams & Signals

**One brain, many hands, each on its own permissions.**

- **The keyring** — guest access generalizes to named principals: per-collaborator keys,
  each with its own scope, budget, and citation policy, each attributed in the call log
  and managed from settings. A team brain with per-seat trust.
- **The brain speaks first** — webhook events for the moments that need a human: a
  proposal waiting, a contradiction detected, drift found by the groundskeeper. Push,
  where today is pull.
- **`brain_wrapup`** — the corrections discipline as tooling: session outcomes applied
  through edit-mode with the `(was: "…")` house style, so every client — not just the
  well-behaved ones — writes history the verifier understands.

## 2027 — Ecosystem

**The primitive escapes the product.**

- **`@obelyth/verify` moved up to Q3 2026** — a roadmap is only as credible as its past
  tense, so the move is recorded rather than erased. What remains here is what follows a
  shipped primitive: integrations, adapters for stores that are not this one, and whatever
  adoption teaches. This section grows from evidence, not ambition.

## Deliberately not on this roadmap

Stated so their absence reads as judgment, not oversight:

- **A vector database.** Keyword narrowing measures ~99% recall at realistic corpus sizes. The
  trigger was always a measurement rather than a fashion — and the measurement has now been
  taken, so this line has earned some detail.

  Postgres full-text search was **built, indexed, and scored against BM25 on 170 labelled
  questions**. It lost: 91.2% recall@10 against BM25's 97.6%, and a hybrid of the two *lost* at
  the tighter k=5 budget that the reader actually gets, because interleaving spends scarce
  candidate slots on the weaker arm. It shipped as a query surface and **did not become the
  default**, which is the rule working rather than a disappointment.

  The useful part is what neither lexical arm could reach: **3 questions out of 170 — 1.8%**.
  Every one asked in the vocabulary of a *situation* against a note written in the vocabulary of
  a *rule*. That is precisely the gap embeddings close, and 1.8% does not pay for an embedding
  pipeline, a backfill, and a staleness story. **When that fraction grows, this line changes** —
  and now there is a script that will say so.

- **Full-text search as the default narrower.** Kept here rather than quietly dropped: it exists
  in the codebase, it is indexed, and `search_notes()` is callable. Nothing routes through it,
  because it lost. The index earns its place as the only path that can rank without loading
  every note into memory, which matters at a corpus size this project has not reached.
- **Model-routing cleverness.** Automatic reader escalation waits until more than one
  reader has passed the eval. Routing between an earned default and an unmeasured
  challenger is not cleverness; it is noise.

---

<div align="center">
  <sub>Tracked live on the <a href="https://github.com/Obelyth/cortex/projects">project board</a> and in milestones. CORTEX BY OBELYTH — DATA. INFRASTRUCTURE. ASSURED.</sub>
</div>
