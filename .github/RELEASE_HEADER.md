This release packages the source at its tag. Read any **Action required** section below before upgrading an existing installation.

## What changed in v2.0.0

- A protected five-tab dashboard with dim Paper and dark Ink themes, consistent rounded surfaces, subtle dotted panels, calmer button motion and an optional orange-and-teal cursor outline.
- One place on Overview for working notes and project-context previews, starting at None; Ask links to the same workflow.
- Readiness and receipts for separately authorized checks, database migration commands and deployments, with explicit confirmation before execution.
- A blank private-brain starter and distinct new-database bootstrap and existing-database upgrade paths.
- Linux and macOS setup entry points in the same source archive. Both lead to the hosted web dashboard, not a desktop binary.

## Action required

- Local tools and builds require Node 22.18.0 or newer within 22.x, not Node 20 or a newer major version. Configure the hosting project's Node version accordingly.
- Configure `CONSOLE_PASSCODE` separately from the connector secret before deploying. The browser console fails closed without it; MCP access is separate.
- Back up notes and database state separately. Existing v1.2.0 databases predate the supported Ops migration baseline and require an administrator-reviewed integration plan before deployment. This release does not provide an automatic upgrade for them. Never run pristine bootstrap or fabricate migration records on an existing database.
- If historical migration records have no checksums, dashboard apply remains blocked pending evidence-backed administrator reconciliation. A read-only check or hashes of today's files cannot certify what ran in the past.
- Optional dashboard checks, deployments and configuration saves require their own provider grants and database receipts. They do not become authorized simply by installing new source.

Read the [v2.0.0 release and upgrade guide for this exact source]({{RELEASE_SOURCE}}/docs/releases/v2.0.0.md) before continuing.

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

The attached `cortex-<tag>.tar.gz` is the tree packaged by the release workflow. Verify its provenance attestation with `gh attestation verify cortex-<tag>.tar.gz --owner Obelyth`. Subscribe to GitHub **Watch → Custom → Releases** for future releases.

---
