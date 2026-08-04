<div align="center">
  <img src="public/brand/obelyth-emblem.png" alt="OBELYTH" width="96" />

# CORTEX <sub><sup>by OBELYTH</sup></sub>

**One memory, every surface.**

A private markdown brain, served to every Claude surface over MCP —
with a read path that proves its own citations instead of asking to be trusted.

*Read. Cite. Abstain.*

</div>

---

Your notes live in a **private GitHub repo** you own — plain markdown, no database, git history as the undo button. This server makes that repo reachable from **Claude Code on any machine, claude.ai on the web, the iPhone app, and desktop** — the same six tools, the same corpus, everywhere. Every write is a commit. Every answer is verified against the file it cites.

```
        iOS        Web        Desktop       Claude Code
          \         |            |            /
           `--------+------------+-----------'
                        CLAUDE
                 reads · cites · abstains
                          |
                        CORTEX          ← this repo, deployed on Vercel
                     MCP  ·  verify
                          |
                     your brain         ← private repo · markdown · git
```

## Quickstart

```bash
# needs Node >= 20, plus gh and vercel CLIs (both logged in)
git clone https://github.com/Obelyth/cortex && cd cortex
npm install
npm run onboard
```

The onboarding walks you through everything in a few minutes (with `gh` and `vercel` already authenticated): it creates your private brain repo from the included template, generates your two secrets locally, tells you exactly which one browser step it cannot do for you (a fine-grained PAT scoped to only the brain repo), deploys to Vercel, **verifies the deployment against the live tool roster**, and prints the two wiring commands for your devices. Safe to re-run.

Already have notes? Bring them in afterwards — dry-run by default:

```bash
npm run ingest -- --from ~/my-notes --repo <you>/brain            # preview
npm run ingest -- --from ~/my-notes --repo <you>/brain --commit   # file it
```

Every ingested note gets a provenance line, because a brain that cannot say where a claim came from cannot be trusted to answer with it.

## The six tools

| tool | what it does |
|---|---|
| `brain_corpus` | **Preferred read.** Returns the notes into the calling conversation so the caller reads them directly. No model call; nothing leaves your storage. |
| `brain_ask` | Optional verified ask. Fetches the corpus, hands a server-side Anthropic reader the notes, then checks the quote against the file — deterministically, no model in that verify loop. |
| `brain_context` | The boot call: profile, index, and the last week of logs. |
| `brain_read` | One note, by path. Paths are allowlisted by shape. |
| `brain_write` | Create, replace, or append. Returns the commit SHA — a save without a SHA did not happen. |
| `brain_capture` | Timestamped append to today's log. The zero-friction path from a phone. |

## What a stamp means

The verifier is deterministic — no model, no network. It compares text to a file at a commit and reports exactly what that proves:

| stamp | meaning |
|---|---|
| `VERIFIED` | This exact text is in that file at that commit. Proves the text exists — **not** that the answer follows from it, and the stamp says so. |
| `SUPERSEDED` | The quote is real and the passage is retracted. The brain keeps corrections *on the page* (`SUPERSEDED`, `CORRECTION`, `DEPRECATED`, `(was: "…")`, `Do not answer`), and the verifier enforces them — verbatim is exactly what a stale answer looks like. |
| `PARTIALLY VERIFIED` | Verbatim in more than one note; the source is ambiguous. |
| `NOT IN BRAIN` | The reader found nothing and said so. The abstain case — an honest no beats a confident guess. |
| `UNVERIFIED` | Not in the cited file, spans a boundary, too short to prove, real text the reader was never shown, or a citation of a file that is not in the corpus. Shown anyway, labelled. |

Why this architecture: measured on its own labelled eval, **ranking a generated index answered correctly 55% of the time; a frontier model reading the actual notes, 97%**. So this server does not rank summaries — it ships the notes.

## What deploys

- **The MCP endpoint**, two doors onto one bearer-gated handler: `/api/mcp` with `Authorization: Bearer <MCP_TOKEN>` for clients that send headers (Claude Code), and `/api/s/<CONNECTOR_PATH_SECRET>/mcp` for clients that cannot (claude.ai custom connectors — a paid claude.ai plan feature; add once on the web and iOS and desktop inherit it). Both fail closed: a bad bearer gets a standard `401`; a wrong path secret gets an **empty 404**, because the secret door does not advertise that anything lives there.
- **A public site** — Overview, Tools, Guide, and a demo map (the real ring renderer over synthetic placeholders; nothing real ships on it).
- **The secret-gated console** — five screens at `/s/<CONNECTOR_PATH_SECRET>/console`: overview (corpus load, write rhythm, ingest feed of real commits), corpus (every note with its retracted passages tick by tick), attention (a triaged queue — credential-shaped lines, unmarked retired-tool claims, cold verification stamps), the live map (your machine's rings around Claude, memory ring rebuilt from the corpus on every request — also standalone at `/s/<secret>/map`), and a wiring guide. Gated because they are inventories; linked from nothing public. `/s/<secret>/health` survives as a redirect into the console.

### Machine rings on the map (optional)

The map's outer rings render from an optional sidecar committed to **your brain repo** at
`tools/atlas-snapshot.json`. Without it the map still works: you get the live memory ring and a
"machine rings absent" caption — absence is a supported state, not an error. To add rings,
commit a snapshot shaped like this (only `capturedAt`, `layers[].key`, `layers[].ring`, and
`nodes[].id`/`nodes[].layer` are validated; a malformed file is rejected whole and the map
degrades to memory-only):

```json
{
  "capturedAt": "2026-08-01",
  "center": "claude",
  "layers": [{ "key": "applications", "label": "APPLICATIONS", "ring": 1, "color": "#aeb8c4" }],
  "nodes": [{ "id": "app:zsh", "label": "zsh", "layer": "applications", "group": "shell", "machine": "all" }],
  "edges": [{ "source": "app:zsh", "target": "claude", "kind": "uses" }]
}
```

The console map's machine filter (all / mac / linux …) appears only when nodes carry per-machine
tags — a snapshot that tags everything `"all"` hides it. The sidecar rides the same authenticated
tarball as your notes, and the corpus loader routes it to the map only: the reader tools never see it.

## Not just Claude

Cortex speaks **standard MCP over streamable HTTP** — Claude is its first-class client, not a
dependency. Any MCP-capable agent connects through one of the same two doors:

- **Header-capable clients** (Cursor, Codex CLI, Gemini CLI, Claude Code, most IDE agents): point
  them at `/api/mcp` with `Authorization: Bearer <MCP_TOKEN>`.

  Cursor (`~/.cursor/mcp.json` or project `.cursor/mcp.json`) — full read + write:

  ```json
  {
    "mcpServers": {
      "cortex": {
        "url": "https://<host>/api/mcp",
        "headers": {
          "Authorization": "Bearer <MCP_TOKEN>"
        }
      }
    }
  }
  ```

  Then refresh MCP in Cursor Settings → Tools & MCP. Prefer `brain_corpus` for reads;
  `brain_write` / `brain_capture` for commits.

- **Header-less clients** (ChatGPT custom connectors, claude.ai, and anything else that only
  takes a URL): the secret-URL door, `/api/s/<CONNECTOR_PATH_SECRET>/mcp`.

`brain_corpus` is the default read path for every client — the calling model reads the notes
itself, no Anthropic key required. `brain_ask` is optional when you want a verified stamp; that
path alone calls Anthropic and needs `ANTHROPIC_API_KEY`. The verifier never involves a model.

## Privacy posture, in one paragraph

Your notes never touch this repo — they stay in *your* private brain repo and are fetched at request time with a PAT scoped to that one repo. Credential-shaped strings are redacted at egress on every read path. `brain_ask` is the only model egress, its tool description discloses exactly what is sent, and the reader model list is allowlisted so a caller cannot pick an arbitrary model on your key. The site never links the gated pages; the demo map strips the icon roster and fails its own build if that strip ever drifts.

## Upkeep

`ops/groundskeeper/` is a nightly maintenance task template for Claude Code's scheduler: health-check both auth paths (set-equality on the tool roster — a count check once silently disabled the reference deployment for four nights), absorb daily logs into project pages, fact-check pages against live state, leave a digest. The gated console's attention screen is the same story on demand.

## Environment

| var | required | what breaks without it |
|---|---|---|
| `BRAIN_REPO` | yes | every tool — no repo to read |
| `GITHUB_TOKEN` | yes | every tool — 401 from the Contents API. Fine-grained PAT, Contents R/W, only the brain repo |
| `MCP_TOKEN` | yes | all requests 401 |
| `CONNECTOR_PATH_SECRET` | for claude.ai | the header-less alias and both gated pages 404 |
| `ANTHROPIC_API_KEY` | for `brain_ask` | `brain_ask` errors; everything else works. Each `brain_ask` bills this key — order of $0.25–$0.80/call depending on corpus size and model |
| `BRAIN_BRANCH` | no | defaults to `main` |
| `BRAIN_TZ` | no | defaults to `UTC` — set your IANA zone or daily logs date to the wrong day |
| `SENTRY_DSN` | no | error reporting disabled |

## Development

```bash
npm run dev          # http://localhost:3000
npm test             # vitest
npm run build
```

Design: the surface follows the **OBELYTH** design system — deep-slate foundation, matte off-white text, one restrained electric-cyan accent reserved for focus, links and live data, 1px hairlines doing the work of separation. Dark-only. Hanken Grotesk (UI) and JetBrains Mono (every ID and metric) are self-hosted — no third-party font CDN in the loading path. The display slot ships empty (the reference deployment's display face is licensed and not redistributable); `app/layout.tsx` documents how to wire your own. For local development, copy `.env.example` values into `.env.local` (already gitignored).

## License

[AGPL-3.0](LICENSE) — Copyright (c) 2026 OBELYTH. Deploy it, fork it, run your own brain on it. If you offer a modified Cortex to others over a network, the AGPL asks you to share your changes the same way.

---

<div align="center">
  <sub>CORTEX BY OBELYTH — DATA. INFRASTRUCTURE. ASSURED.</sub>
</div>
