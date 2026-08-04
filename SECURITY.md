# Security

Cortex guards one asset: your brain repository — private notes served to AI clients through
three doors with distinct trust levels. This page is the honest map of that surface.

## Reporting a vulnerability

Open a [GitHub security advisory](https://github.com/Obelyth/cortex/security/advisories/new)
(private by default). Include reproduction steps and which door is implicated. You will get an
acknowledgement within a week. Please do not open public issues for exploitable findings.

Only the latest release on `main` is supported. There are no backported fixes.

## The trust model, plainly

- **Secrets in URLs are credentials.** The connector and guest doors authenticate by path
  because some clients cannot send headers. Anyone holding the connector URL has full
  read-write on your brain and the console; anyone holding the guest URL can spend your daily
  guest budget and file proposals. Share accordingly, rotate on any suspicion (runbook in the
  README), and know that URLs leak through browser history, screen shares, and pasted configs.
- **The guest door is the only sandbox.** It serves two tools: a scoped, budgeted, citation-free
  ask (answered server-side — the corpus is never handed over) and a propose that commits
  nothing. Scope is enforced by removing notes from the corpus **before** the reader runs.
  Every policy default fails closed; an unreachable KV store locks the door rather than
  unmetering it.
- **The verifier is not a guard against bad writes.** It proves quotes against commits; it does
  not review what trusted doors write. A leaked *trusted* credential means writes — treat it as
  a compromise, not a nuisance.
- **Egress is disclosed, not hidden.** `brain_ask` sends the question and the selected notes to
  the chosen reader's provider (Anthropic by default; OpenAI/Google only if you select those
  readers). `brain_corpus` sends nothing anywhere — it returns notes to the calling client.
- **The console renders presence, never values.** No API key, token, or secret is displayed,
  stored, or accepted by any console control, and answers/evidence pass a redactor before
  leaving the server. Screenshots of the console and guide are designed to be credential-free.

## Out of scope

Compromise of your GitHub account, Vercel account, or provider API keys; prompt-injection
*content* inside your own notes (the server fences and flags it — see the nonced file
boundaries in `lib/ask.ts` — but what your trusted orchestrator does with your notes is your
orchestrator's behavior); and availability of the third-party model APIs.

## Hardening checklist

- Distinct values for all three secrets; `openssl rand -hex 32` or better.
- Keep the brain repository private and its token scoped to that one repo.
- Leave Vercel Deployment Protection **on** for preview deployments; the production doors carry
  their own auth.
- Set `GUEST_PATH_SECRET` only while you actually have a guest.
- Run `ops/groundskeeper/healthcheck.sh` on a schedule; it asserts both doors against
  `lib/tool-roster.json` and fails loudly on drift.
