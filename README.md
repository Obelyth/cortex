# Cortex

**One memory, every surface.** Cortex is a self-hosted MCP server that turns a private git
repository of markdown notes into a brain your AI assistants share — readable from Claude Code,
claude.ai, Cursor, Gemini CLI, ChatGPT, or anything else that speaks MCP, on permissions you
set per client.

What makes it worth running is the verifier: every answer out of your brain carries a stamp —
`VERIFIED`, `CORRECTED`, `SUPERSEDED`, `NOT IN BRAIN` — proven deterministically against the
file at its exact commit, not asserted by a model. A confident fabrication becomes a visible
event. An honest "not in brain" beats a plausible guess. That rule shapes everything here.

## Quickstart

Prerequisites: Node ≥ 20, the [GitHub CLI](https://cli.github.com) (`gh auth status` clean),
the [Vercel CLI](https://vercel.com/cli) (`vercel whoami` clean), and an Anthropic API key.

```bash
git clone https://github.com/Obelyth/cortex && cd cortex
npm install
npm run onboard
```

The onboard script does the whole first run: creates your **private** brain repository from
`brain-template/`, generates the two secrets, sets every required Vercel environment variable,
deploys to production, verifies the deployment by calling it (trust the check, not the deploy
log), and prints the exact wiring commands for your clients — Claude Code, claude.ai, Cursor,
and the console URL. Have notes already? `npm run ingest -- --from <folder>` carries them in.

## The nine tools

Trusted doors get all nine; the guest door gets exactly two (`brain_ask` scoped + `brain_propose`).

| tool | what |
|---|---|
| `brain_ask` | a reader answers, cites, and the verifier stamps the citation |
| `brain_corpus` | hands the notes to the calling model instead — no reader, no egress |
| `brain_context` | profile · index · the last week of logs, one call |
| `brain_read` | one note by path |
| `brain_write` | create, replace, append — or `edit`: surgical in-place replacement, refused loudly if ambiguous |
| `brain_capture` | timestamped append to today's log, from any device |
| `brain_propose` | guest-only: leave a suggestion for review — commits nothing |
| `brain_proposals` · `brain_accept` · `brain_reject` | review what guests left; accepting is what commits |

## The three doors

Which door a client uses is the permission model. Two questions decide it: do you trust the
client, and can it send a header?

| door | URL | who | may |
|---|---|---|---|
| Terminal | `/api/mcp` + `Authorization: Bearer <MCP_TOKEN>` | your orchestrator — any header-capable MCP client | read · write |
| Connector | `/api/s/<CONNECTOR_PATH_SECRET>/mcp` | trusted clients that cannot send headers (claude.ai connectors) | read · write |
| Guest | `/api/g/<GUEST_PATH_SECRET>/mcp` | assistants you do **not** control | ask (scoped) · propose — never write |

A guest never receives your notes. Its questions are answered server-side by a Claude reader,
drawn only from the note areas you share, without source paths or verbatim excerpts, under a
daily budget. Its suggestions wait in a review queue until you accept — accepting is what
commits. The guest door does not exist until `GUEST_PATH_SECRET` is set, and it requires the KV
store (the budget must be meterable, or it is not a budget).

## The stamps

| stamp | means |
|---|---|
| `VERIFIED` | The cited quote is verbatim in that file at that commit. Proves the text exists — not that the answer follows from it, and the wording says so. |
| `CORRECTED` | The quote sits beside an in-place correction marker: it *is* the current claim, kept with the wording it replaced. Answer from the current claim. |
| `SUPERSEDED` | The quote is real but the passage is retracted. History, not the current state. |
| `PARTIALLY VERIFIED` | The quote is real but appears in more than one note, so its source is not established. |
| `NOT IN BRAIN` | The corpus does not contain the answer. Said plainly instead of guessed around. |
| `UNVERIFIED` | The citation could not be proven. Treat the answer as unproven. |

## The readers

Which model reads your brain is a setting, not an assumption. The allowlist spans Claude,
OpenAI and Gemini models behind one contract: schema-constrained JSON out, and a refusal,
truncation or empty completion **throws** rather than masquerading as `NOT IN BRAIN`.
Resolution order: the call's own `model` argument → the console default → `READER_MODEL` → the
built-in. Guest questions are always read by a Claude model regardless of the default.

Honesty note you should keep: the Claude readers carry a measured eval result; the OpenAI and
Gemini readers are wired but **unmeasured**, and every surface says so until you run
`scripts/eval.ts` against your own corpus.

## The console

`/s/<CONNECTOR_PATH_SECRET>/console` — six screens: **overview** (calls, verdicts, per-reader
record), **readers** (default, provider switches, guest policy), **corpus** (every note,
expandable to its own outline and retracted passages), **attention** (triage + the guest
proposal queue), **map**, **guide** (a setup chooser that reads your deployment's real state
and emits ready-to-paste client configs). Secrets never render — presence only, always.

## Environment

`npm run onboard` sets the required rows. Full reference in [.env.example](.env.example):

| var | required | what breaks without it |
|---|---|---|
| `BRAIN_REPO` | yes | everything — no repo to read (`owner/name`, private) |
| `GITHUB_TOKEN` | yes | every tool — 401 from the Contents API |
| `MCP_TOKEN` | yes | all bearer requests 401; whitespace-only fails closed |
| `CONNECTOR_PATH_SECRET` | yes | the connector door and the console 404 |
| `ANTHROPIC_API_KEY` | yes, for `brain_ask` | the ask tool errors on every call |
| `KV_REST_API_URL` / `KV_REST_API_TOKEN` | for settings, guest, proposals, call log | controls degrade to env defaults and say so; the guest door refuses |
| `GUEST_PATH_SECRET` | no | guest door inert (must differ from the connector secret) |
| `OPENAI_API_KEY` / `GEMINI_API_KEY` | no | those readers error on selection |
| `READER_MODEL` | no | default reader falls to the built-in |
| `BRAIN_BRANCH` / `BRAIN_TZ` | no | default `main` / `UTC` |
| `SENTRY_DSN` | no | error reporting off |

## Scheduled upkeep

`ops/groundskeeper/` is the nightly maintenance runbook: a healthcheck script that verifies
both doors against the canonical tool roster (`lib/tool-roster.json` — pinned to the server by
`tests/tool-roster.test.ts`, so a roster change that forgets a verifier fails the build, not
your night), and a skill file for an agent that absorbs daily logs into project pages and
fact-checks drift. Wire it to any scheduler you like; it degrades safely — if the healthcheck
fails, the groundskeeper writes nothing and reports.

## Rotating a secret

The URL-borne secrets are credentials; treat a leak like a leak.

```bash
vercel env rm CONNECTOR_PATH_SECRET production   # same flow for MCP_TOKEN / GUEST_PATH_SECRET
vercel env add CONNECTOR_PATH_SECRET production  # paste a fresh `openssl rand -hex 32`
vercel deploy --prod --yes
```

Then re-wire the clients that used the old value (the guide screen re-emits the configs).
Revoking guest access entirely is `vercel env rm GUEST_PATH_SECRET production` + redeploy —
the door 404s from the next request.

Security policy and reporting: [SECURITY.md](SECURITY.md). License: [AGPL-3.0](LICENSE).

## Development

```bash
npm install
npm test          # vitest — the suites are the spec
npm run typecheck
npm run dev       # needs at least BRAIN_REPO, GITHUB_TOKEN, MCP_TOKEN, CONNECTOR_PATH_SECRET
```

The design laws, if you contribute: a claim must be true or absent; secrets never render;
detection may be broad but wording must be honest; and every verifier consumes
`lib/tool-roster.json` instead of hardcoding a roster. See [CONTRIBUTING.md](CONTRIBUTING.md).
