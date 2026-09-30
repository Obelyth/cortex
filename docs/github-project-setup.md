# GitHub repository setup

GitHub settings belong to each repository. A template copy does not establish
your provider accounts, billing, secrets, environment protections or wiki.
This guide explains which settings the included workflows actually use.

## Environments with a purpose

| Environment | Consumer | Recommended protection | Credentials |
| --- | --- | --- | --- |
| `cortex-database` | The migration job in `cortex-dashboard-checks.yml`, for both checks and applies | Only your approved application branch; required maintainer approval; disable administrator bypass | `SUPABASE_DB_URL` and, when needed, `CORTEX_DATABASE_CA` |
| `release` | The publishing job in `release.yml`, after the test and build jobs | Tags matching `v*`, not branches; required maintainer approval; disable administrator bypass | The publishing job uses GitHub's short-lived workflow token; do not add a personal token |
| `github-pages` | GitHub Pages, if enabled separately | Preserve the branch or workflow restrictions used by your Pages configuration | No Cortex runtime credentials |

In **Settings → Environments**, create the environments you use and configure
their deployment branch and tag rules and required reviewers before running the
workflows. A workflow naming an environment does not create its protections for
you. An empty environment is not a configured service.

Protection availability depends on repository visibility and your GitHub plan.
On Free, Pro and Team, required reviewers are available only for public
repositories. A private template copy must have a plan that supports the required
controls; if they are unavailable, stop before adding database credentials,
dispatching migrations or pushing a release tag. An environment name alone is
not an approval barrier. Check [GitHub's protection-rule availability](https://docs.github.com/en/actions/reference/workflows-and-actions/deployments-and-environments#required-reviewers).

For a solo maintainer, leave **Prevent self-review** off so that the person who
starts a run can explicitly approve it. This is a deliberate manual checkpoint,
not independent two-person review. With a second authorized maintainer, enable
self-review prevention. Disabling administrator bypass keeps the approval gate
from being skipped; it does not remove an administrator's ability to edit settings.

After tests finish, a release waits for approval in **Actions → the release run
→ Review deployments**. Review the exact tag and commit before approving. The
workflow still checks that the release commit belongs to the default branch and
publishes signed provenance for the source archive. Do not create a throwaway
version tag to test this gate: a successful approval publishes a real release.

Database credentials belong only in the protected database environment, never in
repository-wide secrets, Codespaces or the public source. Adding this environment
does not initialize a database or reconcile historical migrations. Follow the
[database guide](database-bootstrap.md) before permitting an apply.

### What about Preview and Production?

Cortex's dashboard calls Vercel directly for preview and production deployments.
Those operations retain Cortex's explicit confirmation and provider checks, but
they do not execute a GitHub Actions job. Creating GitHub environments named
`preview` or `production` would not add an approval gate to those API calls.

Configure deployment protection and the corresponding environment variables in
Vercel. Never copy production secrets into a development Codespace. A GitHub
environment and a Vercel environment are different controls, even if their names
match.

## Codespaces

The [development container](https://github.com/Obelyth/cortex/blob/d78d74921ba6988bede7782c66137fd6ac45e8d7/.devcontainer/devcontainer.json) configures a
Node workspace with locked dependency installation. Read the
[Codespaces guide](codespaces.md) for startup, access settings and stopping the
workspace. Opening it can consume your GitHub Codespaces allowance; it is not a
managed Cortex subscription and does not create a production deployment.

## Wiki

The editable source for the documentation hub is in [docs/wiki](wiki/Home.md).
It links to the maintained setup and security documents instead of keeping a
second copy of their configuration tables.

GitHub requires an initial wiki page to be created in its browser editor. Enable
**Wikis** in repository settings, restrict editing to collaborators, and create
**Home** using the prepared page. After that first save, the separate
`REPOSITORY.wiki.git` repository can be cloned and updated with the files in
`docs/wiki`. Preserve unrelated existing wiki pages and history. Only its default
branch is published. See [GitHub's wiki instructions](https://docs.github.com/en/communities/documenting-your-project-with-wikis/adding-or-editing-wiki-pages).

The checked-in documentation hub remains usable even before the separate wiki
has been initialized. Wiki publication is separate from an application release.

## Sponsor button

A Sponsor button requires a real, maintainer-selected funding destination in
`.github/FUNDING.yml` on the default branch. GitHub Sponsors, supported funding
platforms, or a public custom funding URL can be used. Do not put API tokens,
payment credentials, an unconfirmed checkout address or a placeholder into that
file. Creating the button does not enroll an account in GitHub Sponsors or create
a hosted-service subscription. See [GitHub's funding configuration](https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/customizing-your-repository/displaying-a-sponsor-button-in-your-repository).

## Topics and version tags

Repository topics are discovery labels such as `mcp-server`, `self-hosted`,
`persistent-memory` and `obelyth`. Edit them in the repository's **About** panel.
They are not Git version tags: pushing a `v*` Git tag starts the release workflow.
Reserve those tags for intentional, reviewed releases.
