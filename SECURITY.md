# Security Policy

## Supported Versions

| Version | Supported |
| ------- | --------- |
| latest `main` | :white_check_mark: |
| anything older | :x: |

Cortex ships from `main`; there are no backported fixes. Redeploy to update —
`npm run update` is the runbook (README: Updating).
Tagged releases are provenance snapshots of `main` — the release workflow re-runs
the full check suite at the tag before publishing — and receive no backports either.

## Reporting a Vulnerability

If you discover a security vulnerability or issue, please report it by emailing our support team at **support@obelyth.cloud**, or open a [private GitHub security advisory](https://github.com/Obelyth/cortex/security/advisories/new).

Please include as much detail as possible, including steps to reproduce, which door is implicated, and potential impact. Do not open a public issue for security vulnerabilities.

You can expect an acknowledgement within 48 hours, and we will keep you informed as we investigate and resolve the report.

## The trust model, plainly

Cortex guards one asset: your brain repository — private notes served to AI clients through three doors with distinct trust levels.

- **Secrets in URLs are credentials.** The connector and guest doors authenticate by path because some clients cannot send headers. Anyone holding the connector URL has full read-write on your brain and the console; anyone holding the guest URL can spend your daily guest budget and file proposals. Share accordingly, rotate on any suspicion (runbook in the README), and know that URLs leak through browser history, screen shares, and pasted configs.
- **The guest door is the only sandbox.** It serves two tools: a scoped, budgeted, citation-free ask — answered server-side, the corpus is never handed over — and a propose that commits nothing. Scope is enforced by removing notes from the corpus *before* the reader runs. Every policy default fails closed; an unreachable store locks the door rather than unmetering it.
- **The verifier is not a guard against bad writes.** It proves quotes against commits; it does not review what trusted doors write. A leaked *trusted* credential means writes — treat it as a compromise, not a nuisance.
- **Egress is disclosed, not hidden.** `brain_ask` sends the question and the selected notes to the chosen reader's provider (Anthropic by default; OpenAI or Google only if you select those readers). `brain_corpus` sends nothing anywhere.
- **The console renders presence, never values.** No key, token, or secret is displayed, stored, or accepted by any console control, and answers pass a redactor before leaving the server.

## Hardening checklist

- Distinct values for all three secrets; `openssl rand -hex 32` or better.
- Keep the brain repository private; scope its token to that one repo.
- Set `GUEST_PATH_SECRET` only while you actually have a guest; unset + redeploy revokes.
- Run `ops/groundskeeper/healthcheck.sh` on a schedule — it asserts both doors against `lib/tool-roster.json` and fails loudly on drift.
