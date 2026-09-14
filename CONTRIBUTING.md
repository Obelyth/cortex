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
[Dependency and CI maintenance](https://github.com/Obelyth/cortex/blob/d78d74921ba6988bede7782c66137fd6ac45e8d7/.github/DEPENDENCIES.md) and the source-of-truth
[CI workflow](https://github.com/Obelyth/cortex/blob/d78d74921ba6988bede7782c66137fd6ac45e8d7/.github/workflows/ci.yml). Use `npm run test:watch` while iterating.

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

1. Fetch `origin` and create a release branch from the current `origin/main`.
   Do not make release commits directly on `main`.
2. Set the intended version in `package.json` and both root version fields in
   `package-lock.json`, for example with `npm version major --no-git-tag-version`.
   Keep them consistent: the update helper uses this version to locate the tag
   when recovering Git history for an extracted source archive.
3. Write `docs/releases/v<version>.md` with changes, installation instructions,
   compatibility limits, and required operator actions. Update README links and
   `.github/RELEASE_HEADER.md`, including its version-specific guide link. The
   renderer pins those links to the packaged commit.
4. Run the portable checks above, any changed launcher regressions, release-header
   rendering, and applicable privacy checks. Commit only the intended source files,
   push the release branch, and open a PR targeting `main`. Apply `action-required`
   when needed. Wait for all required checks and review before merging.
5. Configure the `release` environment's required maintainer approval and allowed
   `v*` tags as described in the [repository setup guide](docs/github-project-setup.md).
   Fetch the merged result and identify the PR's exact merge commit. Confirm it is
   on `origin/main` and its package version is the intended version. Create the
   matching annotated `v<version>` tag at that commit and push only that tag. Never
   move an existing published tag or tag an unmerged release branch.
6. Wait for the tag's verification jobs, then review the exact tag and source
   commit in **Actions → Review deployments** and approve the `release` environment.
   After publishing succeeds, download the archive, inspect its
   contents and blank template, and verify the provenance with
   `gh attestation verify <archive> --repo Obelyth/cortex`. A pushed tag alone is
   not a published or verified release. Remove the merged remote release branch
   once its work is preserved on `main`.

The `release` workflow re-runs typecheck, tests and the build at the tag, then
waits for the configured environment approval before publishing the reviewed
release text in `.github/RELEASE_HEADER.md` with links pinned
to that commit. Keep its changes and operator requirements current for each release.
The workflow does not append automatic author credits or contributor lists. A tag
whose checks fail publishes nothing.

### The action-required label

Before merging, label any PR whose change needs operator action beyond
`npm run update`, such as a new environment variable, a migration (`scripts/migrate.ts`), or rewiring
a client, with `action-required`. Generated release notes group those PRs into
an "Action required" section when manually generating notes (`.github/release.yml`).
The publishing workflow uses reviewed notes instead. State required actions
directly in the release header and version-specific guide. Do not rely on historic
PR labels being complete. Audit changes since the previous release for runtime,
authentication, database and provider compatibility before publishing. Treat these
instructions as part of the change, exactly like the docs the honest-data rule covers.
