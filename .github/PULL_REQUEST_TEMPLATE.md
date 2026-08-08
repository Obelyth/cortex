<!--
Delete any section that does not apply. An empty heading is worse than a missing one.
-->

## What this changes

<!-- The behaviour that is different afterwards, not a list of files. -->

## Why

<!-- What was wrong, or what became possible. If a measurement drove this, put the number here. -->

## How it was verified

<!--
Not "tests pass" — what you actually ran, and what it said.
-->

- [ ] `npm test`
- [ ] `npm run typecheck`
- [ ] Exercised against a real brain, or explicitly not applicable

## Claims

This repo's rule is that **a claim must be true or absent**. Please confirm:

- [ ] Every number in the description and in code comments is measured, not estimated. If a
      figure is a projection, it says so.
- [ ] No comment describes behaviour the code does not have, including a fix that is planned
      rather than present.
- [ ] If this supersedes something, the old claim is corrected in place rather than left
      standing above the new one.

## Privacy

- [ ] No real note paths, note contents, credentials, tokens, or path secrets appear in the
      diff — including in test fixtures and code comments describing past incidents.
- [ ] If a fixture needed a secret-shaped value, it is obviously synthetic.

> `tests/no-brain-leakage.test.ts` enforces most of this when a brain is checked out beside the
> repo, but it matches whole note *lines*. **It is not a secret scanner** — a token sitting inside
> a longer line is invisible to it, so the checkbox above is doing real work that the suite cannot.

## Retrieval changes only

- [ ] Measured on the labelled set with `scripts/eval-retrieval.ts`, and the numbers are in the
      description.
- [ ] It beats the incumbent, or it does not become the default.

<!--
Precedent, so this does not read as a formality: full-text search was built, measured at 91.2%
recall@10 against BM25's 97.6%, and deliberately did not become the default. Shipping the
measurement instead of the feature is a good outcome here.
-->
