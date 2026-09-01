# Dependencies

There is deliberately no `dependabot.yml` here.

## Why it was removed

It opened seven PRs in a week. Two of them were genuinely breaking — `mcp-handler` v2 changed
`createMcpHandler`'s arity and moved `McpServer` to a different package, and TypeScript 7 changed
what a side-effect import needs — and both sat red in the queue looking like neglect rather than
like the migrations they were. The rest were noise that still had to be read to find out which
kind they were.

A bot that opens a PR per bump makes the *decision* per bump, at a moment nobody chose, and the
cost of that is a queue you learn to skim. Skimming a queue that occasionally contains a
door-layer migration is the actual risk.

## What replaced it

**Security alerts are still on**, and they are a different mechanism — they were never controlled
by that file. GitHub still raises an advisory the moment one lands, and
`gh api repos/Obelyth/cortex/vulnerability-alerts` confirms it. Removing the config removed
the *version-bump PRs*, not the *warnings*.

The routine check belongs to the groundskeeper, alongside the other things it already looks at:

```bash
npm audit --omit=dev          # advisories that actually matter for what ships
npm outdated                  # drift, read as a list rather than as seven PRs
```

Anything that comes out of those gets fixed deliberately, in a session with attention on it,
which is the only way a breaking migration gets tested rather than merged.

## The rule that made this necessary

A major bump touching the door layer — `lib/handler.ts`, `lib/tools.ts`, the route handlers under
`app/api/` — is a **migration**, not an update. It gets its own branch, and the three doors get exercised at
runtime before it merges — a green typecheck proves nothing about who can reach what.
