# Dependency and CI maintenance

This repository does not include a Dependabot update schedule. Enable GitHub
security alerts for your own repository and review dependencies regularly:

```bash
npm audit --omit=dev
npm outdated
```

Security-alert settings belong to each repository; a fork must check its own
settings. Updating a library that handles authentication, MCP routes or database
migrations requires a reviewed branch and runtime checks of the affected behavior.

## Portable checks

The `ci` workflow runs type checking, the synthetic test suite and a production
build on GitHub-hosted Linux. An optional `CI_RUNNER` repository variable can select
another Linux runner with Docker available. No application, cloud-provider or
private-notes credentials are required.

Its separate `native` job starts PostgreSQL 17 and Valkey 8 with disposable test
data over local Unix sockets. It discovers every `tests/*.pg.test.ts` and
`tests/*.integration.test.ts` file, enforces the suite-count floor, and rejects
missing reports, failed tests, skipped tests or incomplete file coverage.
Ordinary unit runs may skip these native tests when their services are absent;
the native job must execute them all.

Tag-triggered releases call the same workflow before publishing. A release tag
must belong to the repository's default branch. Source packaging and provenance
attestation use the repository's own GitHub token in a separate publishing job.

## Optional SonarQube Cloud

Sonar analysis is disabled until the repository owner sets these Actions settings:

- Repository variable `SONAR_ENABLED`: `true`.
- Repository variables `SONAR_PROJECT_KEY` and `SONAR_ORGANIZATION`: the owner's
  Sonar project and organization identifiers.
- Repository secret `SONAR_TOKEN`: that project's analysis credential.

Enabled analysis fails if its configuration is incomplete. Pull requests from
forks skip credentialed analysis; the portable CI gates still run. Only require
the Sonar status in branch protection when you have configured that service and
chosen how to review fork contributions. Sonar properties retain the repository's
analysis exclusions; the workflow supplies the owner-specific identifiers.

## Dashboard workflow permissions

`cortex-dashboard-checks.yml` accepts only its fixed checks and migration
operations and verifies the requested commit. Its checks job has no provider or
database secrets. Production migration checks and applies use the user-owned
`cortex-database` GitHub environment. Configure its required reviewers and allowed
application branch before storing `SUPABASE_DB_URL` and, if needed,
`CORTEX_DATABASE_CA` there. Never place those database credentials in the deployed
app or give the ordinary checks job access to them.

The public workflows do not fetch a private notes repository. The synthetic
suite is not a claim about the accuracy or contents of any operator's real notes.
