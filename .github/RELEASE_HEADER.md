This release packages the source at its tag. Read any **Action required** section below before upgrading an existing installation.

## What changed in v2.0.2

- Security update: Next.js moves from 16.3.4 to 16.3.8, outside the range affected by the critical advisory [GHSA-vcvr-r3jv-pc5j](https://github.com/advisories/GHSA-vcvr-r3jv-pc5j) (remote code execution in the Node.js `ImageResponse` from `next/og`, Next.js 16.2.0 up to but not including 16.3.6). Cortex does not import `next/og` and its icons are static image files, so v2.0.1 deployments do not run the affected code. This release updates anyway, so that the published source no longer pins an affected version. Only Next.js and its own `@next/*` packages change version.
- Smaller install: `@modelcontextprotocol/sdk` is no longer a dependency. Cortex used it for one type, which now comes from `@modelcontextprotocol/server`, the package the MCP route already runs on. The lockfile lists 82 fewer packages, including express, hono and cors. The MCP tools and their behavior are unchanged.
- For contributors: the optional SonarQube job skips, instead of failing, on runs that Dependabot starts, because GitHub gives those runs no Actions secrets. Every other run is analyzed as before.

## Action required

- **From v2.0.1:** nothing. Redeploy to run Next.js 16.3.8.
- **From v2.0.0:** the v2.0.1 timezone change applies. If `BRAIN_TZ` is unset or empty, daily log boundaries use UTC. Before redeploying, set `BRAIN_TZ` to the IANA timezone your daily logs should follow. Nothing else is required.
- **From v1.2.0 or earlier:** every v2.0.0 requirement still applies. Local tools and builds require Node 22.18.0 or newer within 22.x. Configure `CONSOLE_PASSCODE` separately from the connector secret before deploying. Back up notes and database state separately; existing v1.2.0 databases need an administrator-reviewed integration plan, and pristine bootstrap or fabricated migration records must never be used on an existing database. Read the [v2.0.0 upgrade requirements for this exact source]({{RELEASE_SOURCE}}/docs/releases/v2.0.0.md#action-required-for-existing-installations). The `BRAIN_TZ` change above applies too.

Read the [v2.0.2 release guide for this exact source]({{RELEASE_SOURCE}}/docs/releases/v2.0.2.md) before continuing.

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
