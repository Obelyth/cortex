# Develop Cortex in GitHub Codespaces

The [development container](https://github.com/Obelyth/cortex/blob/d78d74921ba6988bede7782c66137fd6ac45e8d7/.devcontainer/devcontainer.json) provides Node
22.23.2, npm and Git, using the [official Node image](https://github.com/nodejs/docker-node).
Terminals and setup commands run as the unprivileged `node` user. The only
automatic repository command is `npm ci --ignore-scripts`: it downloads locked
dependencies without running package lifecycle scripts.

This is a development workspace. Creating it does not start Cortex, run
onboarding, create a notes repository, configure providers, apply migrations or
deploy an application. No production credentials are required or copied, and the
configuration requests no additional repository permissions. Account or
organization Codespaces secrets and personal dotfiles are separate settings;
do not make production secrets available to this workspace.

## Open and verify the workspace

1. Open your Cortex repository on GitHub and select the branch you want to edit.
2. Choose **Code → Codespaces → Create codespace**. Review GitHub's
   [Codespaces billing](https://docs.github.com/en/billing/concepts/product-billing/github-codespaces)
   and your available usage before creating it.
3. Wait for the dependency install to finish, then use the terminal:

   ```bash
   node --version
   npm test
   npm run typecheck
   ```

The expected Node version is `v22.23.2`, within the app's supported
`>=22.18.0 <23` range. If installation fails, resolve the reported error and rerun
`npm ci --ignore-scripts`; a partially installed workspace is not ready.
Tests that explicitly require an external database retain their own prerequisites.

To start the development server yourself:

```bash
npm run dev -- --hostname 0.0.0.0
```

Open port **3000** from the **Ports** panel. New forwarded ports use GitHub's
private default; confirm **Port Visibility → Private** in that panel, especially
when reusing an existing Codespace. The configuration does not enforce a policy
against later visibility changes. Keep this development server private. See
[GitHub's port forwarding guide](https://docs.github.com/en/codespaces/developing-in-a-codespace/forwarding-ports-in-your-codespace).

An unauthenticated request to `/` returning **404** is expected. Cortex has no
public demo page, and missing access settings leave protected routes closed.

## Optional development brain

The running app reads a GitHub notes repository identified by `BRAIN_REPO`.
`brain-template/` contains starter Markdown files, not a local runtime backend.
`BRAIN_DIR` is used by evaluation scripts and does not connect the server to those
files. You can edit source and run the regular tests without a notes repository
or model API keys.

For integration work, follow the [local development instructions](../README.md#local-development)
with a separate development notes repository and development-only credentials in
the ignored `.env.local` file. Never point write tests at your production brain.
Codespaces supplies its own `GITHUB_TOKEN` for the application repository; that
does not establish access to a separate notes repository, and an existing
environment value takes precedence over `.env.local`. To let the development
notes token in `.env.local` reach Next.js, start only the app process with that
inherited token removed:

```bash
env -u GITHUB_TOKEN npm run dev -- --hostname 0.0.0.0
```

Keep the generated Codespaces token available to GitHub tooling in the terminal.
Do not request broad repository access merely to open this workspace. The
console's hosted secret-entry and deployment controls retain their normal
provider requirements; a forwarded HTTPS URL does not make Codespaces a Vercel
deployment.

Stop the server with **Ctrl+C** and stop the Codespace through GitHub when you
finish. Follow [GitHub's stop/restart instructions](https://docs.github.com/en/codespaces/developing-in-a-codespace/stopping-and-starting-a-codespace)
to manage its running state.
