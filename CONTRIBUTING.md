# Contributing

Cortex is a small codebase with a high bar for claims. Changes are welcome; the
rules below exist so the product stays trustworthy, which is the product.

## Running the checks

Use Node **22.18.0 or newer and earlier than 23**. Installing dependencies with
`npm ci` requires network access to the package registry or a populated package
cache.

```
npm ci
npm run typecheck
npm test
npm run build
```

The portable CI job installs dependencies, then runs the same type check,
synthetic test suite, and production build. These checks do not require
application, cloud-provider, private-notes, or deployed-server credentials. CI
also runs every native integration suite against disposable PostgreSQL 17 and
Valkey 8 services and rejects skipped tests or incomplete file coverage. See
[Dependency and CI maintenance](.github/DEPENDENCIES.md) and the source-of-truth
[CI workflow](.github/workflows/ci.yml). Use `npm run test:watch` while iterating.

## The honest-data rule

Every claim in this repo, including README tables, UI copy, code comments, error
messages, and evaluation numbers, must be true or absent. If you cannot verify a claim,
delete it; do not hedge it. A stale claim is worse than no claim, because this
product's pitch is that it proves what it says. When a change makes a
documented statement false, updating the statement is part of the change, not a
follow-up.

## Tests accompany behavior changes

A change to behavior ships with a test in the same pull request, and the test
must fail without the change. Docs-only and copy-only changes are exempt.
Verifier scripts and docs that assert facts about the server (tool rosters,
endpoint shapes, stamp semantics) are behavior for this purpose. If your
change breaks one, fix it in the same PR rather than leaving a check that lies.

## No secrets in fixtures

Never commit a real credential, and never commit a literal that could be
mistaken for one. When a test needs a key-shaped string, assemble it at
runtime, for example with `"k".repeat(32)` or a prefix joined to padding, so nothing in the
tree trips a secret scanner or reads as a redacted real pair. Fixture repo
owners are neutral (`acme/brain`), never a real account. Local env files stay
out of the tree: copy `.env.example` to `.env.local` and nowhere else.

## Pull requests

- Branch from `main`; never commit to `main` directly.
- Keep PRs small and single-purpose; say what changed and why.
- CI must be green. Do not bypass a red check. Fix it or explain why it is
  wrong before merging.
- Comments explain why, not what. No emoji anywhere in the repo.
- Security issues go through [SECURITY.md](SECURITY.md), not a public issue or
  pull request.

## Releasing (maintainers)

A release is a provenance snapshot of `main`, nothing more. Updates still ship
from `main`, and `npm run update` is how a running copy takes them. See
[Updates and recovery](README.md#updates-and-recovery). To cut one:

```
git checkout main && git pull
npm version <major|minor|patch> --no-git-tag-version
git commit -am "release: v<X.Y.Z>" && git push   # via a PR, per the rules above
git tag v<X.Y.Z> && git push origin v<X.Y.Z>
```

The `release` workflow re-runs typecheck, tests and the build at the tag, then
publishes the GitHub Release with generated notes behind a fixed setup header
(`.github/RELEASE_HEADER.md`). A tag whose checks fail publishes nothing.

### The action-required label

Before merging, label any PR whose change needs operator action beyond
`npm run update`, such as a new environment variable, a migration (`scripts/migrate.ts`), or rewiring
a client, with `action-required`. Generated release notes group those PRs into
an "Action required" section at the top (`.github/release.yml`), which is the
only place an operator is told about manual steps before updating. The header
promises that no section means no manual steps, so a missing label on a PR that
needed one makes the next release lie. Treat the label as part of the change,
exactly like the docs the honest-data rule covers.
