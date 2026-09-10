# Security Policy

## Supported Versions

| Version | Supported |
| ------- | --------- |
| latest `main` | :white_check_mark: |
| anything older | :x: |

Cortex ships from `main`; there are no backported fixes. Redeploy to update.
`npm run update` is the runbook in
[Updates and recovery](README.md#updates-and-recovery).
Tagged releases are provenance snapshots of `main`. The release workflow reruns
the full check suite at the tag before publishing, and tagged releases receive no backports either.

## Reporting a Vulnerability

If you discover a security vulnerability or issue, please report it by emailing our support team at **support@obelyth.cloud**, or open a [private GitHub security advisory](https://github.com/Obelyth/cortex/security/advisories/new).

Please include as much detail as possible, including steps to reproduce, which door is implicated, and potential impact. Do not open a public issue for security vulnerabilities.

You can expect an acknowledgement within 48 hours, and we will keep you informed as we investigate and resolve the report.

## The trust model, plainly

Cortex guards one asset: your brain repository, which contains private notes served to AI clients through three access paths with distinct trust levels.

- **Secrets in URLs are credentials.** The connector and guest MCP paths authenticate by URL because some clients cannot send headers. Anyone holding the connector URL has trusted read and write access to the brain. Anyone holding the guest URL can spend the daily guest budget and file proposals. Human console access additionally requires the console passcode, which gives that browser a device stamp. The path credential alone is not enough to use console controls. Share credentials accordingly, rotate them on any suspicion using [Updates and recovery](README.md#updates-and-recovery), and remember that URLs can leak through browser history, screen shares, and pasted configuration.
- **The guest path is the only sandbox.** It serves two tools: a scoped, budgeted ask answered by a server-side reader, and a proposal tool that commits nothing. Source paths and verbatim quotes are off by default; the owner may enable them in the guest policy. Scope is enforced by removing notes from the corpus before the reader runs. The guest client does not receive the corpus. Every policy default fails closed, and an unreachable store locks the guest path rather than removing its meter.
- **The verifier is not a guard against bad writes.** It proves quotes against commits; it does not review what trusted paths write. A leaked trusted credential permits writes. Treat it as a compromise, not a nuisance.
- **Egress is disclosed, not hidden.** `brain_ask` sends the question and selected notes to the chosen reader provider. Anthropic is the default; OpenAI or Google is used only if you select one of their readers. `brain_corpus` returns the corpus to the trusted calling client without a separate Cortex reader-model call. That client may then send the notes to its own model provider.
- **Console configuration is write-only.** When its one-time prerequisites are in place, the console accepts supported configuration and secrets and sends them to the pinned Vercel project. Those prerequisites include the Vercel management grant, Vercel-managed HTTPS ingress, and the database schema used for configuration receipts. Secret values are never read back or stored in receipts. Receipts contain names and outcomes, not values. Saving configuration does not deploy it. Answers pass through a redactor before leaving the server.
- **Browser metadata is defense in depth.** Cortex sends referrer and noindex protections to reduce accidental URL disclosure and search indexing. These headers do not authenticate a request and do not replace the path credential, console passcode, or device stamp.

## Hardening checklist

- Use distinct random values for every access secret; `openssl rand -hex 32` is one suitable generator.
- Keep the brain repository private; scope its token to that one repo.
- Set `GUEST_PATH_SECRET` only while you actually have a guest; unset + redeploy revokes.
- Run `ops/groundskeeper/healthcheck.sh` on a schedule. It asserts both MCP paths against `lib/tool-roster.json` and fails loudly on drift.
