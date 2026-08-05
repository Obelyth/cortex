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

- Nine tools over MCP, three doors with distinct trust levels — terminal, connector, guest
- A deterministic verifier: every answer stamped `VERIFIED` / `CORRECTED` / `SUPERSEDED` /
  `NOT IN BRAIN` against the file at its commit
- Pluggable readers — Claude, OpenAI, Gemini on an allowlist; Claude holds the default it
  earned on the labeled eval
- The guest door: scoped ask + proposals, every default failing closed
- A seven-screen console — instruments that answer when clicked, one settings home,
  secrets rendered as presence, never values
- Guided onboarding (`npm run onboard`), ingest with provenance, nightly groundskeeper
  runbook, canonical tool roster pinned by tests

## Q3 2026 — Continuity & Proof

**The brain stops being a place you ask and becomes the place work resumes.**

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

- **`@obelyth/verify`** — the citation verifier as a standalone package: nonced
  boundaries, block-scoped quotes, retraction-aware stamps. Citation-proof for any RAG
  pipeline; Cortex becomes the reference implementation of a primitive others adopt.

## Deliberately not on this roadmap

Stated so their absence reads as judgment, not oversight:

- **A vector database.** Keyword narrowing measures ~99% recall at realistic corpus
  sizes. The trigger is corpus growth beyond context economics — a measurement, not a
  fashion. When it trips, this line changes.
- **Model-routing cleverness.** Automatic reader escalation waits until more than one
  reader has passed the eval. Routing between an earned default and an unmeasured
  challenger is not cleverness; it is noise.

---

<div align="center">
  <sub>Tracked live on the <a href="https://github.com/Obelyth/cortex/projects">project board</a> and in milestones. CORTEX BY OBELYTH — DATA. INFRASTRUCTURE. ASSURED.</sub>
</div>
