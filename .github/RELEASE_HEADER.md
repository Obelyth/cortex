This release packages the source at its tag. Read any **Action required** section below before upgrading an existing installation.

## What changed in v2.0.1

- Privacy: documentation examples and MCP tool descriptions now use neutral placeholder names, hosts, values and wording, and test fixtures and code comments were rewritten as self-contained examples.
- Security updates: the lockfile moves brace-expansion, fast-uri and ip-address to their patched releases, which resolves six Dependabot advisories. None of the three runs in the deployed server.
- Documentation fixes: the security policy describes what the health check actually probes, the environment example documents the timezone default and a missing setting, the maintenance template lists every trusted tool, and broken links in the setup and repository guides now point at their public sources.
- Release publishing: only the release workflow publishes a release, after the checks at the tag pass and a maintainer approves it in the `release` environment (the approval step is new since v2.0.0). The pull-request housekeeping workflow added since v2.0.0 does not run on version tags.
- Overview shows its introduction and the working-notes workspace as separate sections in both themes. Controls and their meanings are unchanged.
- For contributors: a GitHub Codespaces setup (Node 22, non-root, locked install) that does not start the server, run migrations or deploy; a documentation hub, a repository settings guide and an updated design reference; an optional Claude pull-request review workflow and housekeeping checks; documented export privacy checks; and evaluation scripts that take their label file from `--labels`.

## Action required

- **From v2.0.0:** if `BRAIN_TZ` is unset or empty, daily log boundaries now use UTC. Before redeploying, set `BRAIN_TZ` to the IANA timezone your daily logs should follow. Nothing else is required.
- **From v1.2.0 or earlier:** every v2.0.0 requirement still applies. Local tools and builds require Node 22.18.0 or newer within 22.x. Configure `CONSOLE_PASSCODE` separately from the connector secret before deploying. Back up notes and database state separately; existing v1.2.0 databases need an administrator-reviewed integration plan, and pristine bootstrap or fabricated migration records must never be used on an existing database. Read the [v2.0.0 upgrade requirements for this exact source]({{RELEASE_SOURCE}}/docs/releases/v2.0.0.md#action-required-for-existing-installations). The `BRAIN_TZ` change above applies too.

Read the [v2.0.1 release guide for this exact source]({{RELEASE_SOURCE}}/docs/releases/v2.0.1.md) before continuing.

## Install and verify

**New installation:** follow the [setup guide for this source snapshot]({{RELEASE_SOURCE}}/README.md). The protected five-tab dashboard starts with a blank brain: only an empty profile and index, with no sample projects, notes, history, credentials, or selected working context. Basic browsing does not require a paid model key.

Browser setup needs GitHub and Vercel accounts. The optional interactive wizard additionally needs Node 22.18 or newer within 22.x (tested with 22.23.2), Git, and authenticated GitHub and Vercel CLIs. Vercel CLI must be 50.5.1 or newer. Configure your Git author identity before creating a brain through the wizard.

Download the attached source archive and extract it before running commands. Linux
and macOS share this package. From the extracted directory, Linux users can run
`bash "Cortex Setup.sh"`; macOS users can open `Cortex Setup.command`. These are
setup launchers for the hosted web application, not desktop app binaries. The
manual alternative, with the prerequisites already installed and signed in, is:

```bash
npm ci --ignore-scripts
npm run onboard
```

The wizard asks before creating a private brain, importing notes, saving provider settings, or deploying. It verifies the production domain before checking the MCP door. Provider grants and optional database setup remain explicit administrator steps; a matching tool roster does not prove model answers or email delivery.

**Database:** use the [pristine bootstrap guide for this source snapshot]({{RELEASE_SOURCE}}/docs/database-bootstrap.md) only for a new, empty database. Existing installations need a reviewed migration check and forward migration plan, never pristine bootstrap.

**Updates:** `npm run update` is an optional interactive source and deployment helper. Back up notes and database state separately, review local changes and release instructions, and check the resulting deployment. It does not apply database migrations.

The attached `cortex-<tag>.tar.gz` is the tree packaged by the release workflow. Verify its provenance attestation with `gh attestation verify cortex-<tag>.tar.gz --repo Obelyth/cortex`. Subscribe to GitHub **Watch → Custom → Releases** for future releases.
