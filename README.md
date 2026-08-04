# CORTEX by OBELYTH

**One memory, every surface.**

> This is the private reference deployment. The public product — everything a
> customer needs to run their own, with guided onboarding and an ingest path —
> is **[Obelyth/cortex](https://github.com/Obelyth/cortex)**. Improvements land
> here first and are exported there sanitised; the export process is in this
> session's history, not automated yet.

Cortex is a private memory server. It serves a repository of markdown notes —
the *brain* — to every Claude surface over MCP, and it proves its own citations
instead of asking to be trusted.

Stateless Next.js on Vercel. `brain_ask` and `brain_corpus` pull the whole live corpus
as a single tarball (one head lookup, one tarball fetch); `brain_read` and
`brain_context` read individual files via the Contents API; writes go through the
Contents API, so every write is a commit. There is no database.

> Read. Cite. Abstain.

---

## The six tools

| tool | what it does |
|---|---|
| `brain_ask` | The retriever. Fetches the whole live corpus in one request, hands a reader model the actual notes, then checks the quote it cited against the file — deterministically, no model in the loop. |
| `brain_corpus` | Returns the notes into the calling conversation instead, with no model call at all. |
| `brain_context` | The boot call: profile, index, and the last week of log entries. |
| `brain_read` | One note, by path. |
| `brain_write` | Create, replace or append. Returns the commit SHA. |
| `brain_capture` | Timestamped append to today's log. Zero friction, any device. |

### Why reading beats ranking

The measurement that decided the architecture was taken on the brain's own eval set —
185 labelled questions at the time of the run (the set has since grown):

| approach | score |
|---|---|
| Ranking a generated index — one line per note, scored arithmetically | **55%** top-1 |
| Reading the actual note text with a frontier model | **97%** answer-correct |

The index path is retired. `brain_recall` and `brain_search` were deleted in Stage 5.
Writes now regenerate only a bare `INDEX.md` path listing, which exists for
`brain_context` and is never ranked.

---

## What a stamp means

The verifier is deterministic — no model, no network. It compares text to a file
and reports exactly what that proves, which is narrower than it sounds.

| stamp | meaning |
|---|---|
| `VERIFIED` | This exact text is in that file at that commit. It proves the text exists — **not** that the answer follows from it. No deterministic check can establish that, so the stamp says so out loud. |
| `SUPERSEDED` | The quote is real, and the passage is retracted. This brain keeps its corrections on the page, so verbatim is exactly what a stale answer looks like. |
| `CORRECTED` | The quote is real and current: it sits beside a `(was: "…")` marker rather than inside one, which is house style for a correction made in place. Read the current claim, not the retired wording next to it. Split out of `SUPERSEDED` — telling a reader to discard the freshest fact in the brain is how a stamp loses its credibility. |
| `PARTIALLY VERIFIED` | The quote is verbatim in more than one note, so it cannot establish which one the reader read. The answer stands; the provenance does not. |
| `NOT IN BRAIN` | The reader found nothing and said so. The abstain case, and the only stamp that is a success on its own terms. |
| `UNVERIFIED` | Not in the cited file, spanning a block boundary, too short to prove anything, or real text the reader was never shown. A fabrication and a paraphrase both land here. The answer is still shown, labelled — a silent drop would be worse than a visible doubt. |

Retraction is a written convention the reader path enforces: a passage marked
`SUPERSEDED`, `CORRECTION`, `DEPRECATED`, `(was: "…")` or `Do not answer` is caught
by `lib/verify.ts` and stamped rather than served as current fact.

---

## The guest door

The brain is portable: hand any assistant the guest URL and it can read everything. That
is the point — you should not lose your memory because you changed models. But a memory
anything can WRITE to is not a memory, it is a suggestion box with your name on it, and
the damage is silent: a false note does not announce itself, it gets read back a month
later as fact.

So a guest reads and proposes, and nothing more.

| door | path | may |
|---|---|---|
| terminal | `/api/mcp` + bearer | everything |
| connector | `/api/s/<CONNECTOR_PATH_SECRET>/mcp` | everything |
| guest | `/api/g/<GUEST_PATH_SECRET>/mcp` | `brain_ask` (scoped), `brain_propose` |

The guest toolset is *smaller*, not *refused*: nothing else is registered on that handler,
so nothing else appears in its `tools/list`. A tool that appears and then errors teaches a
model to keep trying, and tells it what exists to attack.

**Shared on ask, not openly shared.** A guest never receives the corpus — no
`brain_corpus`, no `brain_read`, no `brain_context`. All three hand over private text in
bulk, and the first hands over the *entire brain in one call*, which is the most exposure
this server can produce while looking like a cheap tool because it calls no model. What a
guest gets is the mediated path: it asks, a Claude reader reads, and a conclusion comes
back. Four limits make that real:

| limit | what it stops |
|---|---|
| **scope** | Out-of-scope notes are removed from the corpus *before* the reader runs, so no answer can be written from a sentence the guest was not entitled to. Filtering the answer afterwards would leave the note in the pack — read, quotable, and one string check away from leaking. Default `projects/` only. |
| **model** | A guest ask is always answered by a **Claude** reader, whatever the console default is. the operator can point his own default at any allowlisted model; the gate does not move. |
| **budget** | A daily ceiling metered in KV, incremented *before* the compare so two concurrent guests cannot both take the last slot, and charged *before* the corpus is fetched so a refused ask costs nothing. |
| **shape** | `k` is capped and `full=true` does not exist on that door. |

By default a guest also gets **no source path and no verbatim evidence** — only the answer
and its verdict. It still learns whether the answer was proven, which is what matters to
it; it does not learn the brain's filenames or collect an excerpt on every ask. Scope,
citations and the budget are all set on the console's readers screen.

Every default is the locked-down one. An unset key, an unreachable store, or a stored
policy that no longer parses all land on projects-only with no citations — a settings read
that quietly returned "no restrictions" would turn a store blip into full corpus access.

Proposals live in KV, **never in the repo**: every write to the brain is a commit, and a
commit per rejected proposal would turn the memory into a changelog of things that were
never true. They are reviewed on the console's attention screen, or by the trusted model
through `brain_proposals` / `brain_accept` / `brain_reject` — tools a guest cannot see.
Accepting performs the real write; rejecting leaves no trace.

**Proposal text is hostile until proven otherwise.** It was written by a model this server
does not control and is read back by the model deciding whether to commit it — a
prompt-injection channel aimed squarely at the reviewer. Every render to a model goes
through a per-request nonce fence, the same defence `ask.ts` uses for note bodies, and the
reviewing tool is told in its own description that a proposal asking to be accepted is by
that fact suspect.

## Auth

Two paths onto the same bearer-gated handler.

- **Bearer** — `MCP_TOKEN` at `/api/mcp`. Used by Claude Code.
- **Secret URL** — `/api/s/<CONNECTOR_PATH_SECRET>/mcp` for clients that cannot send
  headers (claude.ai custom connectors). A dedicated route validates the path secret
  and invokes the same handler with a synthetic request.

Both fail closed. A mismatched secret gets a 404, not a 401 — the server does not
advertise that anything lives there.

---

## Web

Three pages, and the split between them is a privacy boundary, not a design one.

| route | who sees it | what it is |
|---|---|---|
| `/` | public | The pitch: the diagram, the 55/97 measurement, what each stamp means. No note titles, no infrastructure names, no repo owner. |
| `/tools` | public | The six tools, documented for a reader. Documentation only — the tools are reachable exclusively over MCP. |
| `/guide` | public | How the system is wired and used: terminal and claude.ai setup, the rituals, how answers are proven. Secrets are placeholders. |
| `/map` | public | The DEMO map — the real renderer over synthetic placeholders. Static, fetches nothing, labelled DEMO. |
| `/s/<CONNECTOR_PATH_SECRET>/console` | secret-holders | The console: overview, readers, corpus, attention, map, guide. Six sibling screens, every link between them relative so the secret never appears in markup. |
| `/s/<CONNECTOR_PATH_SECRET>/health` | secret-holders | Corpus health — every note, its blocks, retracted passages quoted verbatim, cold verification stamps, credential-shaped lines. |
| `/s/<CONNECTOR_PATH_SECRET>/map` | secret-holders | The live operating map: Claude at the centre, four rings of what reaches it, with the real names on it. |

The three document pages share a masthead nav (Overview · Tools · Map · Guide); the demo
map is a self-contained document whose console slot becomes a ⌗ Cortex link home. The nav
never links the gated pages — a public menu must not advertise what the secret protects;
the demo map is the public stand-in for the real one.

The two gated pages are inventories — the console quotes private notes, the map names
every MCP server, hook, skill and note on the machine. That is what someone would want
before attacking it, so neither is linked from the public page, and both 404 on a
mismatch.

**The map's rings are not equally fresh, and it says so.** Applications, routines and
skills describe a laptop — MCP servers, hooks, agents, skills — which a server on Vercel
cannot see, so they render from a dated capture. The memory ring is the one cortex owns,
so it is rebuilt from the live corpus on every request, down to which notes carry
retracted passages. That is why memory is the only ring that carries the accent colour:
cyan marks live data.

That capture is **not committed here**. It is an inventory of a private machine, so it
lives in the brain repo at `tools/atlas-snapshot.json` and is fetched at request time —
protected by the same token as the corpus rather than by this repo's visibility flag. It
rides the same tarball the notes arrive in, so it costs no extra round trip and can never
be a commit out of step with the ring drawn beside it. `tools/` is excluded from the
corpus, and the loader routes that one exact path into a sidecar map that `brain_ask` and
`brain_corpus` are never handed, so the inventory can never surface as an answer.

If it is missing or malformed the map renders the live memory ring alone and says the
machine rings are absent, rather than drawing half a map with no sign anything is wrong.
The memory ring's own definition lives in `lib/atlas.ts`, not in the snapshot, so the
live half never depends on the stale half.

The renderer (`lib/atlas/template.ts`) is one opaque HTML string served whole by a route
handler rather than ported to JSX. It is a hand-tuned canvas layout — ring bands, hex
packing, two force passes, 28 hand-authored `Path2D` glyphs — under a CSP of
`default-src 'none'`. It has no props and nothing else renders it, so a component port
would risk the layout to gain nothing.

### Design

The surface follows the **OBELYTH** design system: cool deep-slate foundation, matte
off-white text, one restrained electric-cyan accent, sharp geometry, 1px hairlines
doing the work of separation. Dark-only, because the brand defines no light palette.

Type is Steelfish (display), Hanken Grotesk (UI), JetBrains Mono (every ID, metric and
timestamp). All three are self-hosted: `next/font` fetches at build time for the React
pages, and the map — which is served outside the Next layout — declares its own
`@font-face` rules against the same files in `public/fonts/`. No third-party font CDN
sits in the loading path of a page about keeping a brain private.

---

## Environment

| var | required | what breaks without it |
|---|---|---|
| `BRAIN_REPO` | yes | every tool — no repo to read |
| `GITHUB_TOKEN` | yes | every tool — 401 from the Contents API |
| `MCP_TOKEN` | yes | all requests 401. Trimmed before comparison; empty or whitespace-only fails closed. Short tokens warn but still work |
| `CONNECTOR_PATH_SECRET` | for claude.ai | the header-less alias route and both web consoles 404 |
| `GUEST_PATH_SECRET` | for the guest door | `/api/g/<secret>/mcp` 404s and no assistant outside the operator's own clients can reach the brain. Must differ from `CONNECTOR_PATH_SECRET` — the route refuses to serve if they match |
| `ANTHROPIC_API_KEY` | **yes, for `brain_ask`** with the default Claude readers | `brain_ask` throws on every call. Everything else still works |
| `OPENAI_API_KEY` | only for `gpt-*` readers | picking a `gpt-*` reader model errors on call |
| `GEMINI_API_KEY` | only for `gemini-*` readers | picking a `gemini-*` reader model errors on call |
| `READER_MODEL` | no | defaults to `claude-sonnet-5`; an invalid value fails loudly on first ask. Outranked by the console's own default when one is set |
| `KV_REST_API_URL` / `KV_REST_API_TOKEN` | no | the call log falls back to one instance's memory, and the console's reader controls have nowhere to write — both say so on screen |
| `BRAIN_BRANCH` | no | defaults to `main` |
| `BRAIN_TZ` | no | defaults to `America/Los_Angeles` |
| `SENTRY_DSN` | no | error reporting is disabled without it |

`ANTHROPIC_API_KEY` was once documented as needed only for the retired re-ranker.
`brain_ask` calls a reader model on every invocation, so a deploy without it ships a
tool that errors on first use. See `.env.example`.

### Pluggable reader

The reader — the one model call on the read path — is pluggable from the console, per
deployment (`READER_MODEL`) and per call (`brain_ask`'s `model` parameter). The allowlist and the
three backends (Anthropic SDK; OpenAI `/v1/responses` and Gemini `generateContent`,
both raw fetch with a hard 45s budget and zero retries) live in `lib/reader.ts`. Every
backend is held to the same contract: schema-constrained JSON out, loud failure on
refusal, truncation or emptiness — the deterministic verifier downstream treats them
identically, so the trust model does not change with the model. Sonnet and Opus carry
the measured eval result (97% on 185 labels; Haiku measured 47-98% across runs and is
not recommended); the OpenAI and Gemini readers are wired but not yet run on the eval,
and the tool description says so.

### Console settings

The readers screen is the one place in this system with controls on it, and the only
mutable state it has: a **default reader** and a **provider switch** per provider, stored
in KV under `cortex:settings:<env>`. Resolution order is call argument → console →
`READER_MODEL` → built-in default.

Two rules make the controls safe to reach from a phone. A provider switch governs
*selection* — it stops a caller asking for that provider's models and stops them being
the console default — and is deliberately **not** applied to the last resort of the
fallback chain, so no combination of switches can leave `brain_ask` with nothing to call.
And the store is not the authority, the keys are: if KV is unreachable the settings
degrade to env-and-code defaults with every provider selectable, and the screen says so
in those words. API keys are never entered, stored or displayed in the console — it
reports only whether each one is present.

Writes go to `POST /s/<secret>/console/settings`, which re-proves the secret on every
request. It is a route handler rather than a server action on purpose: an action's id
ships in a public `/_next/static` chunk, so an action that mutated settings without
re-checking the secret would be a control anyone who fetched the bundle could reach.

These are Production-scoped on Vercel, so preview deployments cannot serve any brain
route — a preview 404 on `/s/<secret>/…` is expected, not a regression.

---

## Development

```bash
npm install
npm run dev          # http://localhost:3000
npm test             # vitest
npm run build
```

The `live brain corpus` suites in `tests/hard-*.test.ts` read a real clone of the brain
repo from `../brain`, or `BRAIN_DIR` if set. They skip cleanly when it is absent, which
is why CI — which does not check out the brain — is green without them.

Spec: `docs/superpowers/specs/2026-07-24-cortex-brain-design.md`. It records why this
exists; rows that no longer describe the running system are marked `SUPERSEDED` in place
rather than edited away, the same convention the brain uses on itself.
