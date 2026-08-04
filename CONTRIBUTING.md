# Contributing

Cortex is a small codebase with a high bar for claims. Changes are welcome; the
rules below exist so the product stays trustworthy, which is the product.

## Running the checks

```
npm ci
npm run typecheck
npm test
npm run build
```

Those are the same three checks CI runs on every push and pull request. Node 20
or newer. The test suite runs green from a fresh clone: no environment
variables, no network, no deployed server required. Use `npm run test:watch`
while iterating.

## The honest-data rule

Every claim in this repo — README tables, UI copy, code comments, error
messages, eval numbers — must be true or absent. If you cannot verify a claim,
delete it; do not hedge it. A stale claim is worse than no claim, because this
product's pitch is that it proves what it says. When a change makes a
documented statement false, updating the statement is part of the change, not a
follow-up.

## Tests accompany behavior changes

A change to behavior ships with a test in the same pull request, and the test
must fail without the change. Docs-only and copy-only changes are exempt.
Verifier scripts and docs that assert facts about the server (tool rosters,
endpoint shapes, stamp semantics) are behavior for this purpose — if your
change breaks one, fix it in the same PR rather than leaving a check that lies.

## No secrets in fixtures

Never commit a real credential, and never commit a literal that could be
mistaken for one. When a test needs a key-shaped string, assemble it at
runtime — `"k".repeat(32)`, or a prefix joined to padding — so nothing in the
tree trips a secret scanner or reads as a redacted real pair. Fixture repo
owners are neutral (`acme/brain`), never a real account. Local env files stay
out of the tree: copy `.env.example` to `.env.local` and nowhere else.

## Pull requests

- Branch from `main`; never commit to `main` directly.
- Keep PRs small and single-purpose; say what changed and why.
- CI must be green. Do not bypass a red check — fix it or explain why it is
  wrong before merging.
- Comments explain why, not what. No emoji anywhere in the repo.
- Security issues go through [SECURITY.md](SECURITY.md), not a public issue or
  pull request.
