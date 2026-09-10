<div align="center">
  <img src="public/brand/obelyth-emblem.png" alt="OBELYTH" width="96" />

# CORTEX <sub><sup>by OBELYTH</sup></sub>

**One memory, every surface.**

A protected dashboard and MCP server for your private Markdown notes.

[![release](https://img.shields.io/github/v/release/Obelyth/cortex?label=release)](https://github.com/Obelyth/cortex/releases/latest)
[![ci](https://img.shields.io/github/actions/workflow/status/Obelyth/cortex/ci.yml?branch=main&label=ci)](https://github.com/Obelyth/cortex/actions/workflows/ci.yml)
[![license](https://img.shields.io/github/license/Obelyth/cortex?label=license)](LICENSE)

</div>

Cortex keeps durable notes in a private GitHub repository you control. Note writes become Git commits. An optional Supabase database adds a rebuildable notes mirror, working notes, device records, and operations history. Working notes and operations records are not recoverable from the notes repository, so back up that database separately.

The public release starts blank: no personal corpus, example project, sample history, provider credentials, or preselected working project. You can browse and edit notes and preview context without a paid model key. Generating an answer through Ask requires a configured reader provider and may incur charges.

## The dashboard

The protected dashboard has five tabs:

| Tab | Use it for |
| --- | --- |
| Ops | Review readiness and operational receipts; explicitly request available checks, migrations, or deployments. |
| Overview | See activity and manage Working context. Choose a project, inspect its context, and edit or page through working notes here. |
| Ask | Browse the notes catalog, open notes, capture or edit content, and optionally ask a reader model a question. |
| Trends | Inspect recorded usage, memory growth, and retrieval patterns. A new installation has no history to chart. |
| Settings | Set supported preferences, inspect provider readiness, enter supported configuration, and get client connection instructions. |

Working context starts at **None**. Choosing a project is a read-only preview; clearing it does not delete notes or working state. Ask links back to that project's context on Overview. These navigation actions do not queue a job, write a note, or call a model. Writes and operational actions have separate controls.

There is no public demo site on a deployed instance. Open `/s/<CONNECTOR_PATH_SECRET>/console` on your verified deployment domain and enter `CONSOLE_PASSCODE`. An unstamped browser visiting the bare domain receives a 404. After unlocking, that device can use the bare domain to return to the dashboard. Keep the path secret and passcode private.

## Start with a private, blank brain

You need Node **22.x** (tested with **22.23.2**), Git, a GitHub account, and a Vercel account to follow the hosted setup. Provider setup and permission grants are one-time administrator steps; the dashboard cannot grant itself access to your accounts.

1. Make your own copy of [Obelyth/cortex](https://github.com/Obelyth/cortex), using GitHub's template action or a clone. This is the **application source**, not the notes repository. Keep secrets and notes out of it.
2. Create a separate **private** GitHub repository for the brain. Put the two files from [brain-template](brain-template) at its root and make an initial commit. They contain only an empty `profile.md` and an `INDEX.md` listing that profile. Do not upload the enclosing `brain-template` directory. No other directories are needed until you create notes.
3. Create a fine-grained GitHub token restricted to that brain repository, with **Contents: Read and write**. Set `BRAIN_REPO` to its `owner/repository` and `BRAIN_BRANCH` to its actual default branch. Do not assume the branch is `main` for an existing repository.
4. Import your application source into Vercel. In the project's environment settings, set `BRAIN_REPO`, `BRAIN_BRANCH`, `GITHUB_TOKEN`, `MCP_TOKEN`, `CONNECTOR_PATH_SECRET`, and `CONSOLE_PASSCODE` for Production. Generate separate random values for the three access credentials and store them in a password manager. [.env.example](.env.example) explains each exact field name and whether it is a secret or configuration value.
5. Deploy the configured project. Copy its actual production domain from the Vercel project dashboard, confirm it points to the successful deployment, then open the protected console path above. Never construct a host by guessing a project name.
6. Open **Settings** and **Ops** to see what is ready and what is unavailable. Missing optional services should remain unconfigured until you want them. No model, database, email account, or guest connector is required to start browsing the private notes repository.

Saving an environment variable does not update an already-running deployment. Deploy the environment where you saved it. If Vercel Deployment Protection blocks an MCP client, review the production access policy in Vercel; the client must be able to reach Cortex's own authentication. Keep preview deployment protection enabled.

### Optional setup wizard

The wizard performs the repository and Vercel steps interactively. Install and sign in to the [GitHub CLI](https://cli.github.com/) and [Vercel CLI](https://vercel.com/docs/cli) first; Vercel CLI 50.5.1 or newer is needed for its authenticated deployment check. Creating a brain through the wizard also requires your Git author name and email to be configured; setup checks this before creating the remote repository. The browser-based steps above do not require local Git configuration.

```bash
git clone https://github.com/Obelyth/cortex.git
cd cortex
npm ci
npm run onboard
```

It checks that an existing brain is private, uses its real default branch, and keeps existing notes. A new brain gets only the blank skeleton. Importing an existing folder is optional, with a preview before an explicit commit confirmation. The wizard generates access credentials, lets you select a Vercel project, lists the field names it will change, and asks before saving settings and deploying production. Existing access credentials are retained by default; rotation requires a separate confirmation.

Before using the connector secret, the wizard checks Vercel's authenticated deployment record and confirms that an assigned production domain resolves to that same project and deployment. It does not follow redirects during the MCP check. A matching tool roster proves that endpoint answered, not that a database is healthy, a model works, or email has been delivered. The wizard makes no paid-model call and never initializes a database.

Pasted and generated credentials are visible in the setup terminal. Use a private terminal, save them securely, and clear its scrollback. Do not paste a setup transcript into an issue or chat.

## Add services when you need them

| Capability | One-time setup |
| --- | --- |
| Generated answers | Add a key for an allowlisted reader provider. The default reader uses `ANTHROPIC_API_KEY`; other supported providers and `READER_MODEL` are documented in `.env.example`. Reader calls can send selected notes to that provider. |
| Durable preferences and guest metering | Create an Upstash store and set its exact `KV_REST_API_URL` and `KV_REST_API_TOKEN`. |
| Working notes, mirror, devices, and Ops receipts | Create a dedicated Supabase project, perform the [new-database bootstrap](docs/database-bootstrap.md), then set `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` server-side. |
| Dashboard checks and deployments | Set the separate application-repository and provider grants described below. Merely entering project IDs does not grant access. |
| Ops alert email | Configure `RESEND_API_KEY`, `OPS_ALERT_TO`, and an authorized `OPS_ALERT_FROM`. These are an API key value, recipient address, and sender address respectively. Resend Contacts do not set the recipient. `CORTEX_RESEND_API_KEY` and `OPS_ALERTS_FROM` are not the names the app reads. |

After each provider change, deploy that environment and inspect readiness again. **Saved**, **present in the running app**, **permission checked**, and **delivery tested** are different states. Settings shows secrets as presence, never their stored values. Its Alerts form requires the complete three-field group; saving it sends no email. A refresh reads status or the latest receipt and does not deploy or run a delivery test.

### Enable dashboard operations

Basic browsing does not require these grants. To let **Ops** dispatch checks, migrations, or deployments, an administrator must first configure:

- **Application source:** `CORTEX_APP_REPO` and `CORTEX_APP_BRANCH`, separate from `BRAIN_REPO`. The fixed `.github/workflows/cortex-dashboard-checks.yml` must exist on the application's default branch and the approved configured branch.
- **GitHub Actions permission:** a dedicated selected-repository `CORTEX_ACTIONS_TOKEN` with Actions read/write and Contents read. Do not broaden the brain token to cover this.
- **Vercel permission:** a dedicated `CORTEX_VERCEL_TOKEN`, the exact `CORTEX_VERCEL_PROJECT_ID` from project settings, and `CORTEX_VERCEL_TEAM_ID` only for a team-owned project. IDs identify resources; the token authorizes actions. Link the app source repository and enable Vercel System Environment Variables in project settings.
- **Receipt storage:** the bootstrapped database above. Initial management credentials and receipt storage must be configured in provider settings and deployed before the browser can save supported service settings.
- **Database upgrades:** `CORTEX_MIGRATION_TARGET` identifies the approved database. Put the administrator connection string `SUPABASE_DB_URL` and, when needed, trusted `CORTEX_DATABASE_CA` in the GitHub environment named `cortex-database`, not in the deployed app. Restrict that environment to the approved application branch and require review. The [database guide](docs/database-bootstrap.md) distinguishes bootstrap from upgrades.

The dashboard reports missing prerequisites. A configured token's presence is not proof of provider access. Review the requested operation and its target before confirming it, then use its receipt to check what actually happened.

## Connect a trusted client

Use **Settings** for connection instructions based on your running deployment. Cortex exposes three MCP entry points:

| Entry point | Access |
| --- | --- |
| `/api/mcp` with `Authorization: Bearer <MCP_TOKEN>` | Trusted reads and writes. |
| `/api/s/<CONNECTOR_PATH_SECRET>/mcp` | The same trusted access for URL-only clients. The URL itself is a credential. |
| `/api/g/<GUEST_PATH_SECRET>/mcp` | Restricted ask and propose only, enabled separately with a distinct secret and required backing services. Proposals enter a review queue; they do not commit notes. |

Connect only clients you trust with the corresponding access. Do not give a trusted URL to an assistant that should only propose changes. Client-specific support for remote MCP and URL-only authentication varies.

The exact tool roster is [lib/tool-roster.json](lib/tool-roster.json). Trusted connections have these eleven tools:

| Tool | Purpose |
| --- | --- |
| `brain_context` | Return bounded profile, note routing, and working context for a session. |
| `brain_handoff` | Assemble a project-specific context bundle with source references. |
| `brain_read` | Read a note by path. |
| `brain_corpus` | Return the notes to the calling client. |
| `brain_write` | Create, replace, append to, or precisely edit a note with a Git commit. |
| `brain_capture` | Append a timestamped entry to the daily log. |
| `brain_bubble` | Read and deliberately update database-backed working notes. |
| `brain_ask` | Ask a configured reader model and check its quoted citations. |
| `brain_proposals` | List proposed changes for trusted review. |
| `brain_accept` | Accept a proposal and commit the approved change. |
| `brain_reject` | Reject a proposal without committing it to the notes. |

The guest connection exposes only scoped `brain_ask` and `brain_propose`. `brain_propose` submits to the review queue and cannot commit a note.

`ANTHROPIC_API_KEY` is required when a Claude reader is selected for `brain_ask`. OpenAI and Gemini readers require their respective provider keys instead. No reader key is required for basic boot, browsing, or context previews. A client receiving notes through a model-free tool may still send them to its own model provider.

The citation verifier checks quoted text against a source file. A verified quote proves the text appears there, not that the text is true or that the answer follows from it. Corrections and superseded passages are identified separately. There is no recall or accuracy guarantee for your corpus. See [SECURITY.md](SECURITY.md) for reporting and security details.

## Local development

```bash
npm ci
cp .env.example .env.local
npm run dev
```

Fill in your own brain repository and access settings in `.env.local`; never commit that file. Open `http://localhost:3000/s/<CONNECTOR_PATH_SECRET>/console` with your passcode. Without those settings, protected routes remain closed. Hosted secret-entry and deployment-management controls require their provider prerequisites and are not unlocked by pretending a local process is Vercel.

```bash
npm test
npm run typecheck
npm run build
```

Ordinary tests use synthetic data, not your notes or live provider credentials. Optional native-database tests have separate opt-in requirements; see their test files and the database guide. Never point test fixtures or bootstrap at an existing personal database.

## Updates and recovery

Read the release's **Action required** section before updating, especially for existing-database changes. Back up the brain repository and database separately. An update does not replace that backup plan.

`npm run update` is an optional interactive source-update and deployment helper. Review its planned merge and any local changes before confirming. It does not apply database migrations. Follow release-specific manual steps, then check the deployment and its Ops receipts; a successful build alone does not prove every configured integration works.

To rotate access credentials, use provider environment settings and redeploy, or rerun onboarding and explicitly choose rotation. Reconnect trusted clients with the new credentials and unlock browser devices again. Revoking a GitHub or provider token is a separate action in that provider's account settings.

[Releases](https://github.com/Obelyth/cortex/releases) · [Security](SECURITY.md) · [License](LICENSE)
