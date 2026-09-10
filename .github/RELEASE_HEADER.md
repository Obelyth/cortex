This release packages the source at its tag. Read any **Action required** section below before upgrading an existing installation.

**New installation:** follow the [setup guide for this source snapshot]({{RELEASE_SOURCE}}/README.md). The protected five-tab dashboard starts with a blank brain: only an empty profile and index, with no sample projects, notes, history, credentials, or selected working context. Basic browsing does not require a paid model key.

Browser setup needs GitHub and Vercel accounts. The optional interactive wizard additionally needs Node 22.18 or newer within 22.x (tested with 22.23.2), Git, and authenticated GitHub and Vercel CLIs. Vercel CLI must be 50.5.1 or newer. Configure your Git author identity before creating a brain through the wizard.

```bash
npm ci
npm run onboard
```

The wizard asks before creating a private brain, importing notes, saving provider settings, or deploying. It verifies the production domain before checking the MCP door. Provider grants and optional database setup remain explicit administrator steps; a matching tool roster does not prove model answers or email delivery.

**Database:** use the [pristine bootstrap guide for this source snapshot]({{RELEASE_SOURCE}}/docs/database-bootstrap.md) only for a new, empty database. Existing installations need a reviewed migration check and forward migration plan, never pristine bootstrap.

**Updates:** `npm run update` is an optional interactive source and deployment helper. Back up notes and database state separately, review local changes and release instructions, and check the resulting deployment. It does not apply database migrations.

The attached `cortex-<tag>.tar.gz` is the tree packaged by the release workflow. Verify its provenance attestation with `gh attestation verify cortex-<tag>.tar.gz --owner Obelyth`. Subscribe to GitHub **Watch → Custom → Releases** for future releases.

---
