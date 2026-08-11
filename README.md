<div align="center">
  <img src="public/brand/obelyth-emblem.png" alt="OBELYTH" width="96" />

# CORTEX <sub><sup>by OBELYTH</sup></sub>

**One memory, every surface.**

A private markdown brain, served to every surface you trust over MCP —
with a read path that proves its own citations instead of asking to be trusted.

*Read. Cite. Abstain.*

*Any model may read it. Claude earned the default.*

[**Roadmap →**](ROADMAP.md)

</div>

---

Your notes live in a **private GitHub repo** you own — plain markdown, no database, git history as the undo button. This server makes that repo reachable from **Claude Code on any machine, claude.ai on the web, the iPhone app, desktop, and any MCP client you trust** — the same ten tools, the same corpus, everywhere. Assistants you *don't* trust get a third door: they may ask and propose, never write. Every write is a commit. Every answer is verified against the file it cites.

```
        iOS      Web      Desktop      Claude Code      Cursor · CLIs
          \       |          |            /                /
           `------+----------+-----------+---------------'
                        YOUR ORCHESTRATOR                      guests
                  Claude first-class · any MCP client        ask · propose
                    reads · writes · reviews                   (scoped)
                          |                                      |
                        CORTEX  ·  MCP  ·  verify  ←─────────────'
                          |             this repo, deployed on Vercel
                     your brain         ← private repo · markdown · git
```

## Quickstart

Three ways to your own copy, same five minutes after any of them:

- **Use this template** on GitHub — your own repo, no fork relationship — then clone it.
- Grab a [release](https://github.com/Obelyth/cortex/releases) — a snapshot of `main` with the full check suite re-run at the tag.
- Or clone this repo directly.

```bash
# needs Node >= 20, plus gh and vercel CLIs (both logged in)
git clone https://github.com/Obelyth/cortex && cd cortex
npm install
npm run onboard
```

The setup wizard walks you through everything in a few minutes (with `gh` and `vercel` already authenticated): it creates your private brain repo from the included template, **asks whether to start fresh or index an existing folder of notes** (preview first, nothing written until you confirm), generates your two secrets locally, tells you exactly which one browser step it cannot do for you (a fine-grained PAT scoped to only the brain repo), deploys to Vercel, **verifies the deployment against the live tool roster**, and prints the two wiring commands for your devices. Safe to re-run — re-running is also the rotation runbook (see Upkeep).

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https%3A%2F%2Fgithub.com%2FObelyth%2Fcortex)

The button deploys the **public site only** — landing, tools, guide and the synthetic demo map run with zero environment, and every gated route answers 404 until you configure it. Your brain comes from the wizard: clone the repo the button created for you and run `npm run onboard` in it.

More to bring in later? Ingest is dry-run by default:

```bash
npm run ingest -- --from ~/my-notes --repo <you>/brain            # preview
npm run ingest -- --from ~/my-notes --repo <you>/brain --commit   # file it
```

Every ingested note gets a provenance line, because a brain that cannot say where a claim came from cannot be trusted to answer with it.

## The ten tools

Trusted doors get all ten. The guest door gets exactly two — a scoped `brain_ask` and `brain_propose`.

| tool | what it does |
|---|---|
| `brain_ask` | The flagship. Fetches the whole live corpus as one tarball, hands a reader model the actual notes, then checks the quote it cited against the file — deterministically, no model in that loop. The reader is pluggable per call or per deployment: an allowlisted registry of Claude, OpenAI and Gemini models, all held to one contract — a refusal or truncation throws rather than masquerading as `NOT IN BRAIN`. |
| `brain_corpus` | Returns the notes into the calling conversation instead. No model call; nothing leaves your storage. |
| `brain_context` | The boot call: profile, a one-line router entry per note, and the working bubble. Bounded on purpose — it is paid on every session on every surface, and it currently loads about 4% of the corpus. |
| `brain_read` | One note, by path. Paths are allowlisted by shape. |
| `brain_write` | Create, replace, append — or `edit`: surgical in-place replacement, refused loudly if the target is absent or ambiguous. Returns the commit SHA — a save without a SHA did not happen. |
| `brain_capture` | Timestamped append to today's log. The zero-friction path from a phone. |
| `brain_bubble` | Working memory: what is in flight right now, carried across sessions and surfaces so work resumes instead of being re-explained. The one thing Postgres is authoritative for — notes never are. |
| `brain_propose` | Guest-only. Leaves a suggestion in a review queue — commits nothing, ever. |
| `brain_proposals` · `brain_accept` · `brain_reject` | The review half, trusted doors only. Accepting is what commits. |

## What a stamp means

The verifier is deterministic — no model, no network. It compares text to a file at a commit and reports exactly what that proves:

| stamp | meaning |
|---|---|
| `VERIFIED` | This exact text is in that file at that commit. Proves the text exists — **not** that the answer follows from it, and the stamp says so. |
| `CORRECTED` | The quote sits *beside* an in-place correction marker — it **is** the current claim, kept with the wording it replaced. Answer from the current claim. Split out of `SUPERSEDED` because telling a reader to discard the freshest fact in the brain is how a stamp loses its credibility. |
| `SUPERSEDED` | The quote is real and the passage is retracted. The brain keeps corrections *on the page* (`SUPERSEDED`, `CORRECTION`, `DEPRECATED`, `(was: "…")`, `Do not answer`), and the verifier enforces them — verbatim is exactly what a stale answer looks like. |
| `PARTIALLY VERIFIED` | Verbatim in more than one note; the source is ambiguous. |
| `NOT IN BRAIN` | The reader found nothing and said so. The abstain case — an honest no beats a confident guess. |
| `UNVERIFIED` | Not in the cited file, spans a boundary, too short to prove, real text the reader was never shown, or a citation of a file that is not in the corpus. Shown anyway, labelled. |

Why this architecture: measured on its own labelled eval, **ranking a generated index answered correctly 55% of the time; a frontier model reading the actual notes, 97%**. So this server does not rank summaries — it ships the notes.

## What deploys

- **The MCP endpoint**, three doors: `/api/mcp` with `Authorization: Bearer <MCP_TOKEN>` for clients that send headers (Claude Code, Cursor, the CLIs), `/api/s/<CONNECTOR_PATH_SECRET>/mcp` for trusted clients that cannot (claude.ai custom connectors — add once on the web and iOS and desktop inherit it), and `/api/g/<GUEST_PATH_SECRET>/mcp` for assistants you do not control — a smaller handler that registers only the scoped ask and the propose, so its `tools/list` is the honest answer to "what may I do here". All fail closed: a bad bearer gets a standard `401`; a wrong path secret gets an **empty 404**, because a secret door does not advertise that anything lives there; the guest door does not exist until its secret is set.
- **A public site** — Overview, Tools, Guide, and a demo map (the real ring renderer over synthetic placeholders; nothing real ships on it).
- **The secret-gated console** — seven screens at `/s/<CONNECTOR_PATH_SECRET>/console`: overview (corpus load, calls, verdicts per reader, ingest feed of real commits), readers (each model's own record on your corpus, eval states, who is reading now), corpus (every note expandable to its own title, outline and retracted passages, tick by tick), attention (a triaged queue plus the guest proposal review), the live map (your machine's rings, memory ring rebuilt from the corpus on every request — also standalone at `/s/<secret>/map`), a setup guide that reads your deployment's real state and emits ready-to-paste client configs, and settings — every control in one place: default reader, provider switches, guest scope and budgets, appearance; secrets render as presence, never values. Gated because they are inventories; linked from nothing public. `/s/<secret>/health` survives as a redirect into the console.

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

Cortex is **model-agnostic by architecture and Claude-first by evidence**. The reader allowlist
spans Claude, OpenAI and Gemini; the only readers that have passed our labeled eval — 97% on 185
questions against a live corpus — are Claude's, so Claude holds the default until another model
earns it on the same test. That is the difference between a preference and a measurement.

We didn't build Claude's second brain. We built *yours* — and chose the reader we could prove.
Any MCP-capable agent connects through the same doors:

- **Header-capable clients** (Cursor, Codex CLI, Gemini CLI, most IDE agents): point them at
  `/api/mcp` with `Authorization: Bearer <MCP_TOKEN>` — the same wiring as Claude Code, in each
  client's own MCP config syntax. Cursor (`~/.cursor/mcp.json`), full read + write:

  ```json
  {
    "mcpServers": {
      "cortex": {
        "url": "https://<host>/api/mcp",
        "headers": { "Authorization": "Bearer <MCP_TOKEN>" }
      }
    }
  }
  ```

- **Header-less clients** (ChatGPT custom connectors, and anything else that only takes a URL):
  the secret-URL door, `/api/s/<CONNECTOR_PATH_SECRET>/mcp` — the same mechanism claude.ai uses,
  subject to each vendor's own connector availability and policies.
- **Assistants you do not control** — a collaborator's model, or one you use without trusting it
  with the pen: the guest door, `/api/g/<GUEST_PATH_SECRET>/mcp`. They ask (answered server-side
  by a Claude reader, drawn only from the note areas you share, under a daily budget, without
  source paths or excerpts) and they propose (into a review queue — accepting is what commits).
  The corpus itself is never handed over.

The reader behind `brain_ask` is pluggable — Claude, OpenAI and Gemini models on an allowlist,
chosen per call or from the console, so a GPT or Gemini shop can run an all-one-vendor stack.
`ANTHROPIC_API_KEY` still earns its place: it is the default reader and the one that answers
guests. `brain_corpus` remains the no-egress path — the *calling* model reads the notes itself,
whoever it is. The verifier never involves a model at all, which is why swapping readers never
touches the trust story.

## Privacy posture, in one paragraph

Your notes never touch this repo — they stay in *your* private brain repo and are fetched at request time with a PAT scoped to that one repo. Credential-shaped strings are redacted at egress on every read path. `brain_ask` is the only model egress, its tool description discloses exactly what is sent, and the reader model list is allowlisted so a caller cannot pick an arbitrary model on your key. The site never links the gated pages; the demo map strips the icon roster and fails its own build if that strip ever drifts. Reporting and the full trust model: [SECURITY.md](SECURITY.md).

## Upkeep

`ops/groundskeeper/` is a nightly maintenance task template for Claude Code's scheduler: health-check both auth paths (set-equality against `lib/tool-roster.json`, the one canonical roster, pinned to the server by its own test — a hardcoded count once silently disabled the reference deployment for four nights), absorb daily logs into project pages, fact-check pages against live state, leave a digest. The gated console's attention screen is the same story on demand.

### Rotating secrets

1. Run `npm run onboard` and answer **no** when it offers to keep the existing secrets. It generates fresh values, sets them on the project, redeploys, and reprints the wiring commands.
2. Re-wire every surface: the claude.ai custom connector gets the new URL; each machine re-runs its `claude mcp add` line. Until then, wired surfaces hold the revoked values and fail closed.
3. `GUEST_PATH_SECRET` is not managed by the wizard: set a new value in the Vercel project env and redeploy — or unset it, which is how a guest is revoked entirely.
4. Treat a leaked **trusted** credential as a compromise, not a nuisance: rotate first, then audit the brain repo's recent commits for writes you did not make.

## Environment

| var | required | what breaks without it |
|---|---|---|
| `BRAIN_REPO` | yes | every tool — no repo to read |
| `GITHUB_TOKEN` | yes | every tool — 401 from the Contents API. Fine-grained PAT, Contents R/W, only the brain repo |
| `MCP_TOKEN` | yes | all requests 401 |
| `CONNECTOR_PATH_SECRET` | for claude.ai | the header-less alias and both gated pages 404 |
| `ANTHROPIC_API_KEY` | yes, for `brain_ask` | `brain_ask` errors; everything else works. Each `brain_ask` bills this key — order of $0.25–$0.80/call depending on corpus size and model |
| `OPENAI_API_KEY` / `GEMINI_API_KEY` | no | those readers error on selection; unset, they simply cannot be chosen |
| `READER_MODEL` | no | deployment default reader; outranked by the console's own setting |
| `KV_REST_API_URL` / `KV_REST_API_TOKEN` | for settings, guest, proposals, call log | console controls degrade to env defaults and say so; the guest door refuses every call — a budget that cannot be metered is not a budget |
| `GUEST_PATH_SECRET` | no | guest door inert. Must differ from the connector secret |
| `BRAIN_BRANCH` | no | defaults to `main` |
| `BRAIN_TZ` | no | defaults to `UTC` — set your IANA zone or daily logs date to the wrong day |
| `SENTRY_DSN` | no | error reporting disabled |
| `SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY` | no | the Postgres mirror, working-state bubble and note temperatures stay off; every reader degrades to the GitHub tarball path. Server-side only — never `NEXT_PUBLIC_`. Apply the schema once with `npx tsx scripts/migrate.ts --apply` (dry-run without the flag; needs `SUPABASE_DB_URL` locally, never deployed) |

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
