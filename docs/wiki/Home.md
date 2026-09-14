# Cortex documentation

Cortex keeps the notes, decisions and project context you save available to
compatible AI tools across sessions. You run your own deployment and keep durable
notes in a private GitHub repository. The dashboard lets you inspect that memory,
manage working notes and review operational results.

## Start here

- [What Cortex does and how its dashboard works](https://github.com/Obelyth/cortex/blob/main/README.md#the-dashboard)
- [Set up a private, blank brain](https://github.com/Obelyth/cortex/blob/main/README.md#start-with-a-private-blank-brain)
- [Linux and macOS setup for v2.0.0](https://github.com/Obelyth/cortex/blob/v2.0.0/docs/releases/v2.0.0.md#linux-and-macos-setup)
- [Downloads and release notes](https://github.com/Obelyth/cortex/releases)

A fresh installation contains an empty profile and index, not somebody else's
notes. Self-hosting requires your own accounts and configuration. Managed Cortex
hosting is planned, not an available subscription in this release.

## Use your memory

**Overview** holds working notes and project-context previews. **Ask** lets you
browse notes and optionally ask a configured reader model. **Ops** shows readiness,
confirmed commands and their results. **Trends** shows recorded activity, and
**Settings** explains supported preferences and connections.

- [Connect compatible clients and choose trusted or guest access](https://github.com/Obelyth/cortex/blob/main/README.md#connect-a-trusted-client)
- [Add optional reader, database and email services](https://github.com/Obelyth/cortex/blob/main/README.md#add-services-when-you-need-them)
- [Enable dashboard checks, migrations and deployments](https://github.com/Obelyth/cortex/blob/main/README.md#enable-dashboard-operations)

Trusted clients can commit notes. Guest clients can ask scoped questions and
submit proposals for review, not directly write notes. A verified citation means
the quoted text appears in its source, not that the source is necessarily true.

## Install and upgrade carefully

- [Environment fields and their purposes](https://github.com/Obelyth/cortex/blob/main/.env.example)
- [New database bootstrap and existing-database boundaries](https://github.com/Obelyth/cortex/blob/main/docs/database-bootstrap.md)
- [v2.0.0 upgrade requirements](https://github.com/Obelyth/cortex/blob/v2.0.0/docs/releases/v2.0.0.md#action-required-for-existing-installations)
- [Backups, updates and recovery](https://github.com/Obelyth/cortex/blob/main/README.md#updates-and-recovery)
- [Security policy and private vulnerability reporting](https://github.com/Obelyth/cortex/blob/main/SECURITY.md)

Back up both the notes repository and the database. Do not run fresh-database
bootstrap against existing data or invent migration ledger entries. Never paste
tokens, private connection URLs or personal notes into public issues or this wiki.

## Develop and contribute

- [Open a GitHub Codespaces development workspace](https://github.com/Obelyth/cortex/blob/main/docs/codespaces.md)
- [Configure repository environments, funding and topics](https://github.com/Obelyth/cortex/blob/main/docs/github-project-setup.md)
- [Dependency and CI maintenance](https://github.com/Obelyth/cortex/blob/main/.github/DEPENDENCIES.md)
- [Contribution guide](https://github.com/Obelyth/cortex/blob/main/CONTRIBUTING.md)
- [Roadmap](https://github.com/Obelyth/cortex/blob/main/ROADMAP.md)
- [Report a non-sensitive bug](https://github.com/Obelyth/cortex/issues/new/choose)

This hub links to maintained source documentation. Links to `main` describe the
current development line; when installing a specific release, use the instructions
stored at its tag.
