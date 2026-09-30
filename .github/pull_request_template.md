## Summary

<!-- pr-hygiene: summary. What this changes, in a sentence or two. Leave this comment in place and PR Hygiene writes it from the diff. -->

## Why

<!-- pr-hygiene: why. The problem or request this answers. -->

## Test plan

<!-- pr-hygiene: test-plan. How it was verified: commands run, what was checked by hand, what was not. -->

## Checklist

- [ ] CI is green
- [ ] The title starts with feat, fix, chore, docs, ci, refactor, test or perf
- [ ] Linked to its issue where one exists (`Closes #n`, or the number in the branch name)
- [ ] `npm test` and `npm run typecheck` pass locally
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

Delete this section when the change does not touch retrieval.

- [ ] Measured on the labelled set with `scripts/eval-retrieval.ts`, and the numbers are in the
      description.
- [ ] It beats the incumbent, or it does not become the default.
