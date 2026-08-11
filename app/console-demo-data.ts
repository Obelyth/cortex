/**
 * Synthetic data for the landing's console demo — the gated console's shape with nothing
 * real on it, same contract as the demo map. Every path, SHA, count and quote here is
 * invented; tests/console-demo.test.ts pins that this file stays that way. The invented
 * project names follow the fixture convention (aurora, beacon, relay, signal).
 *
 * The demo carries all seven of the real console's screens. The controls it shows are
 * demonstrably inert — DEMO_NOTE below is rendered on the Settings screen so the landing
 * says so in place rather than faking a working deployment.
 */

export type Stamp =
  | "VERIFIED"
  | "COMMITTED"
  | "PARTIAL"
  | "BOOT"
  | "SUPERSEDED"
  | "NOT IN BRAIN"
  | "READ"
  | "UNVERIFIED";

export type BadgeStatus = "pass" | "warn" | "fail" | "processing" | "neutral";

export const STAMP_STATUS: Record<Stamp, BadgeStatus> = {
  VERIFIED: "pass",
  COMMITTED: "pass",
  PARTIAL: "warn",
  SUPERSEDED: "warn",
  "NOT IN BRAIN": "processing",
  UNVERIFIED: "fail",
  BOOT: "neutral",
  READ: "neutral",
};

/** The verdict-stream pool the demo cycles through. */
export const POOL = [
  { surface: "code", tool: "brain_ask", stamp: "VERIFIED" as Stamp, path: "notes/verification-contract.md", ms: "1,284" },
  { surface: "ios", tool: "brain_capture", stamp: "COMMITTED" as Stamp, path: "log/2026-08-01.md", ms: "412" },
  { surface: "web", tool: "brain_ask", stamp: "PARTIAL" as Stamp, path: "notes/retrieval-eval.md", ms: "1,622" },
  { surface: "code", tool: "brain_context", stamp: "BOOT" as Stamp, path: "profile.md", ms: "806" },
  { surface: "desktop", tool: "brain_ask", stamp: "SUPERSEDED" as Stamp, path: "projects/aurora.md", ms: "1,470" },
  { surface: "web", tool: "brain_ask", stamp: "NOT IN BRAIN" as Stamp, path: "—", ms: "940" },
  { surface: "code", tool: "brain_read", stamp: "READ" as Stamp, path: "projects/beacon.md", ms: "238" },
  { surface: "ios", tool: "brain_ask", stamp: "UNVERIFIED" as Stamp, path: "notes/prompt-patterns.md", ms: "1,355" },
  { surface: "code", tool: "brain_write", stamp: "COMMITTED" as Stamp, path: "projects/aurora.md", ms: "690" },
  { surface: "code", tool: "brain_ask", stamp: "VERIFIED" as Stamp, path: "projects/relay.md", ms: "1,118" },
];

const DIR_RAW = [
  { dir: "projects", notes: 18, raw: 34880 },
  { dir: "notes", notes: 16, raw: 29120 },
  { dir: "log", notes: 31, raw: 28410 },
  { dir: "root", notes: 3, raw: 3830 },
];

/**
 * The bar shows COMPOSITION, not fullness. It used to divide each directory by an invented
 * 150,000-token ceiling and pad the remainder with empty track, which drew a capacity gauge for
 * a store that has no capacity — the brain is a git repo and grows without limit. Widths are now
 * shares of the corpus itself, so they sum to 100% and the bar answers the only question it can
 * honestly answer: what is this brain made of.
 */
const DIR_TOTAL = DIR_RAW.reduce((sum, d) => sum + d.raw, 0);

export const DIRS = DIR_RAW.map((d) => ({
  dir: d.dir,
  notes: d.notes,
  tokens: d.raw.toLocaleString("en-US"),
  w: Math.round((d.raw / DIR_TOTAL) * 100) + "%",
  share: Math.round((d.raw / DIR_TOTAL) * 100) + "%",
}));

export const DIR_TOTAL_LABEL = DIR_TOTAL.toLocaleString("en-US");

export const ROWS = (
  [
    ["projects/", "aurora.md", 8410, 214, 3],
    ["projects/", "beacon.md", 6980, 178, 0],
    ["notes/", "mcp-architecture.md", 5240, 141, 2],
    ["notes/", "verification-contract.md", 4860, 132, 5],
    ["projects/", "relay.md", 4120, 108, 0],
    ["notes/", "retrieval-eval.md", 3940, 96, 4],
    ["log/", "2026-07-31.md", 3180, 84, 0],
    ["notes/", "brain-conventions.md", 2970, 79, 1],
    ["projects/", "signal.md", 2640, 71, 0],
    ["notes/", "prompt-patterns.md", 2180, 58, 2],
  ] as Array<[string, string, number, number, number]>
).map(([dir, base, tokens, blocks, ret]) => {
  const n = Math.max(10, Math.min(30, Math.round(blocks / 6)));
  const ticks: Array<{ r: boolean }> = [];
  for (let i = 0; i < n; i++) {
    const isRet = ret > 0 && i % Math.max(3, Math.floor(n / ret)) === 1 && ticks.filter((t) => t.r).length < ret;
    ticks.push({ r: isRet });
  }
  return {
    dir,
    base,
    ticks,
    blocks,
    tokens: tokens.toLocaleString("en-US"),
    ret: ret || null,
  };
});

/** 24 hourly bars; the peak hour is the one the live field marks. */
export const BARS = [3, 2, 1, 0, 1, 2, 6, 11, 16, 21, 24, 19, 27, 33, 25, 18, 22, 29, 34, 30, 26, 17, 12, 8];

/** The same log rebucketed, the way the real chart derives WEEK and MONTH from one read. */
export const BARS_WEEK = [31, 44, 52, 38, 61, 20, 12];
export const BARS_MONTH = [
  8, 12, 19, 24, 16, 9, 4, 11, 22, 31, 27, 18, 25, 33, 29, 21, 14, 8, 17, 26, 34, 30, 23, 15, 10, 19, 28, 36, 32, 24,
];

export const SURFACES = [
  { name: "Claude Code", sub: "terminal · bearer", state: "live", grant: "READ · WRITE" },
  { name: "iOS", sub: "claude.ai app · connector secret", state: "live", grant: "READ · WRITE" },
  { name: "Web", sub: "claude.ai · connector secret", state: "live", grant: "READ · WRITE" },
  { name: "Desktop", sub: "Mac · connector secret", state: "idle", grant: "READ · WRITE" },
];

export const COMMITS = [
  { sha: "a3f19c72", msg: "log/2026-08-01.md · append", ago: "2 min" },
  { sha: "5e08d4b1", msg: "projects/aurora.md · replace", ago: "41 min" },
  { sha: "c96b2e40", msg: "log/2026-08-01.md · append", ago: "1 hr" },
  { sha: "281f7a9d", msg: "notes/verification-contract.md · append", ago: "3 hr" },
];

export const CREDS = [
  { loc: "notes/deploy-runbook.md:41", kind: "vendor token" },
  { loc: "projects/aurora.md:118", kind: "key=value" },
];

export const RETIRED = [
  { path: "notes/retrieval-eval.md", lines: "L62, L88, L141, L156", unmarked: 4, terms: ["index_rank", "note_search"] },
  { path: "notes/mcp-architecture.md", lines: "L37, L44", unmarked: 2, terms: ["catalogue.md"] },
  { path: "profile.md", lines: "L12", unmarked: 1, terms: ["build_catalogue"] },
];

export const COLD = (
  [
    ["notes/prompt-patterns.md", "2026-06-28", 34],
    ["projects/signal.md", "2026-07-04", 28],
    ["notes/brain-conventions.md", "2026-07-11", 21],
    ["projects/relay.md", "2026-07-15", 17],
    ["notes/mcp-architecture.md", "2026-07-19", 13],
    ["log/2026-07-24.md", "2026-07-24", 8],
  ] as Array<[string, string, number]>
).map(([path, verified, age]) => ({ path, verified, age, warm: age <= 20 }));

export const QUOTES = [
  {
    loc: "projects/aurora.md:118",
    heading: "under “Retrieval”",
    text: "index_rank scores the generated catalogue and returns the top three notes for the caller to read…",
  },
  {
    loc: "notes/retrieval-eval.md:62",
    heading: "under “Scoring”",
    text: "The index path scores 55% top-1, which is good enough to ship while the reader path is measured…",
  },
  {
    loc: "notes/mcp-architecture.md:37",
    heading: "under “Boot”",
    text: "brain_context calls build_catalogue first so the session opens against a freshly ranked index…",
  },
];

export const RITUALS = [
  { tag: "Boot", text: "A session that needs context opens with brain_context — profile, index and the last week of log entries, one call." },
  { tag: "Capture", text: "“Remember: …” from any device becomes brain_capture — a timestamped entry in today's log, committed. A save is only real if a SHA came back." },
  { tag: "Wrap up", text: "At session end, outcomes go to the relevant project page and the daily log — the same ritual on desktop and phone, the same files." },
];

export const TOOLS = [
  { name: "brain_ask", role: "the retriever", what: "Reads the whole live corpus, then proves the quote it cited against the file.", doors: ["code", "connector", "guest"], calls: 341 },
  { name: "brain_corpus", role: "the direct read", what: "Hands the notes to the calling conversation. No model call.", doors: ["code", "connector"], calls: 128 },
  { name: "brain_context", role: "the boot call", what: "Profile, index and the last week of log entries, in one call.", doors: ["code", "connector"], calls: 64 },
  { name: "brain_read", role: "one note", what: "One note by path. Paths are allowlisted by shape.", doors: ["code", "connector"], calls: 213 },
  { name: "brain_write", role: "the commit", what: "Create, replace or append. A save without a commit SHA did not happen.", doors: ["code", "connector"], calls: 57 },
  { name: "brain_capture", role: "zero friction", what: "Timestamped append to today's log, from any device.", doors: ["code", "connector"], calls: 92 },
];

export const STAMPS = [
  { tag: "VERIFIED", status: "pass" as BadgeStatus, line: "Verbatim in that file at that commit. Proves the text exists, not that the answer follows." },
  { tag: "SUPERSEDED", status: "warn" as BadgeStatus, line: "The quote is real, and the passage is retracted." },
  { tag: "PARTIAL", status: "warn" as BadgeStatus, line: "Verbatim in more than one note — the answer stands, the provenance does not." },
  { tag: "NOT IN BRAIN", status: "processing" as BadgeStatus, line: "The reader found nothing and said so. The abstain case." },
  { tag: "UNVERIFIED", status: "fail" as BadgeStatus, line: "Not in the cited file, or spanning a boundary. Shown anyway, labelled." },
];

/** How the last 341 asks checked out — the stacked bar and its legend. */
export const CHECKED = [
  { tag: "VERIFIED", n: 312, tone: "live" },
  { tag: "SUPERSEDED", n: 9, tone: "warn" },
  { tag: "PARTIAL", n: 6, tone: "warn" },
  { tag: "NOT IN BRAIN", n: 11, tone: "sunk" },
  { tag: "UNVERIFIED", n: 3, tone: "crit" },
] as const;

/** The console's seven screens, in the real shell's tab order and vocabulary. */
export const NAV = [
  { k: "overview", label: "Overview" },
  { k: "ask", label: "Ask" },
  { k: "trends", label: "Trends" },
  { k: "corpus", label: "Notes" },
  { k: "attention", label: "Inbox" },
  { k: "map", label: "Map" },
  { k: "settings", label: "Settings" },
] as const;

export type ScreenKey = (typeof NAV)[number]["k"];

/** The canned demonstration the Ask screen runs. The citation is QUOTES[1] wearing its verdict. */
export const ASK = {
  q: "Where is the retrieval eval scored, and is the index path good enough?",
  stamp: "VERIFIED" as Stamp,
  answer:
    "The index path scores 55% top-1 on the retrieval eval. The note calls that good enough to ship while the reader path is measured — so yes, with the caveat that the comparison is still running.",
  cite: {
    loc: "notes/retrieval-eval.md:62",
    heading: "under “Scoring”",
    quote: "The index path scores 55% top-1, which is good enough to ship while the reader path is measured…",
  },
  meta: { reader: "claude-sonnet-5", ms: "1,284", corpus: "96,240 tok", pack: "1,880 tok" },
};

/** Trends instruments. Deterministic — the demo's clock is a counter, so its charts are too. */
export const TRENDS = {
  stats: [
    { label: "tokens saved", fig: "412k", sub: "corpus read minus pack sent, summed per ask" },
    { label: "time saved", fig: "20.8 h", sub: "est · ~330 tok/min retyping" },
    { label: "sessions", fig: "96", sub: "call bursts more than 30 min apart" },
    { label: "from memory", fig: "87%", sub: "answered ÷ scored" },
  ],
  buckets: [
    { label: "08-04", memory: 21, fresh: 6 },
    { label: "08-05", memory: 34, fresh: 4 },
    { label: "08-06", memory: 28, fresh: 7 },
    { label: "08-07", memory: 41, fresh: 3 },
    { label: "08-08", memory: 52, fresh: 5 },
    { label: "08-09", memory: 38, fresh: 2 },
    { label: "08-10", memory: 47, fresh: 4 },
    { label: "08-11", memory: 44, fresh: 1 },
  ],
  patterns: [
    { dir: "up", title: "Busiest block: 13:00–17:00", sub: "132 of 341 asks land in one four-hour band", chip: "39%" },
    { dir: "down", title: "Not-in-memory is falling", sub: "6 → 1 per day across the window — the brain is filling in", chip: "−83%" },
    { dir: "up", title: "Proof rate holds", sub: "331 of 341 verdicts carried a verifiable quote", chip: "97.1%" },
  ],
  days: ["M", "T", "W", "T", "F", "S", "S"],
  bands: ["00–04", "04–08", "08–12", "12–16", "16–20", "20–24"],
  /** 6 four-hour bands × 7 days, intensity 0–100. Row-major; the single 100 is the hot cell. */
  heat: [
    [4, 2, 3, 2, 5, 1, 0],
    [8, 6, 9, 7, 6, 2, 1],
    [38, 46, 41, 52, 44, 12, 6],
    [61, 72, 68, 100, 66, 18, 9],
    [44, 51, 47, 58, 40, 22, 14],
    [16, 21, 18, 24, 19, 11, 7],
  ],
  share: [
    { name: "claude-sonnet-5", pct: 64, tone: "live" },
    { name: "gpt-5.6-terra", pct: 22, tone: "ink" },
    { name: "claude-haiku-4-5", pct: 14, tone: "faint" },
  ],
};

/** The inbox queue: every finding the demo triages, with the detail pane's record. */
export const TRIAGE = [
  {
    sev: "crit",
    title: "Vendor token in prose",
    loc: "notes/deploy-runbook.md:41",
    kv: [
      ["found", "on every read since 2026-08-06"],
      ["exposure", "redacted on the way out — still verbatim in the repo"],
      ["shape", "Bearer …, 40 chars, high entropy"],
      ["honest fix", "rotate the token, then rewrite the line to name where it lives"],
    ],
  },
  {
    sev: "crit",
    title: "key=value under “Deploy”",
    loc: "projects/aurora.md:118",
    kv: [
      ["found", "2026-08-09, first scan after the section landed"],
      ["exposure", "redacted on read · matches KEY=… assignment"],
      ["shape", "ALL_CAPS=value at line start"],
      ["honest fix", "move the value to the deployment env; keep the key name"],
    ],
  },
  {
    sev: "warn",
    title: "4 unmarked retired-tool claims",
    loc: "notes/retrieval-eval.md",
    kv: [
      ["lines", "L62, L88, L141, L156"],
      ["names", "index_rank · note_search"],
      ["why it matters", "a passage naming a deleted tool with no marker verifies clean and reads as current fact"],
      ["honest fix", "mark them retracted — mark, never delete"],
    ],
  },
  {
    sev: "warn",
    title: "2 unmarked retired-tool claims",
    loc: "notes/mcp-architecture.md",
    kv: [
      ["lines", "L37, L44"],
      ["names", "catalogue.md"],
      ["why it matters", "the boot note still describes a file the pipeline no longer writes"],
      ["honest fix", "mark them retracted — mark, never delete"],
    ],
  },
  {
    sev: "warn",
    title: "1 unmarked retired-tool claim",
    loc: "profile.md",
    kv: [
      ["lines", "L12"],
      ["names", "build_catalogue"],
      ["why it matters", "the profile is the first thing every boot reads"],
      ["honest fix", "mark it retracted — mark, never delete"],
    ],
  },
  {
    sev: "warn",
    title: "Cold verification stamp, 34 d",
    loc: "notes/prompt-patterns.md",
    kv: [
      ["last verified", "2026-06-28"],
      ["age", "34 days — oldest stamp in the corpus"],
      ["why it matters", "a stale stamp is a claim nobody has re-checked"],
      ["honest fix", "re-run the verifier; the stamp re-dates itself"],
    ],
  },
] as const;

/** Guest proposals waiting on the operator's decision. Guest text renders as text, never markdown. */
export const PROPOSALS = [
  {
    path: "projects/relay.md",
    mode: "append",
    why: "guest session, 2026-08-09 — adds the handoff its answer relied on",
    content:
      "## Handoff — relay cutover\nThe reader path went live behind the flag on 2026-08-09.\nNext session: remove the flag once the eval re-runs clean.",
  },
  {
    path: "log/2026-08-08.md",
    mode: "append",
    why: "guest session, 2026-08-08 — a correction to its own earlier answer",
    content: "21:40 — earlier answer cited the wrong section; the scoring table lives under “Scoring”, not “Method”.",
  },
] as const;

/** The Settings screen's reader column — the public repo's own registry vocabulary. */
export const READER = {
  active: "claude-sonnet-5",
  providers: [
    { id: "anthropic", env: "ANTHROPIC_API_KEY", set: true, locked: true, sub: "key set · serving the default" },
    { id: "openai", env: "OPENAI_API_KEY", set: true, locked: false, sub: "key set" },
    { id: "google", env: "GEMINI_API_KEY", set: false, locked: false, sub: "GEMINI_API_KEY missing" },
  ],
};

/** The Settings screen's guest column. */
export const GUEST = {
  door: "open",
  scope: [
    { area: "projects/", on: true },
    { area: "notes/", on: true },
    { area: "log/", on: false },
    { area: "profile.md", on: false },
  ],
  showSources: true,
  asksPerDay: 20,
  notesPerAsk: 3,
};

/** Working state — the bubble, as the overview carries it. */
export const BUBBLE = [
  { kind: "focus", text: "aurora: reader path behind the flag; eval re-run queued", note: "projects/aurora.md", ago: "2 h" },
  { kind: "decision", text: "relay ships the index path at 55% top-1 while the reader is measured", note: "projects/relay.md", ago: "1 d" },
  { kind: "handoff", text: "next session starts at the scoring table — see the log", note: "log/2026-08-01.md", ago: "3 h" },
] as const;

/**
 * Rendered on the Settings screen so the demo says in place what its controls are.
 * tests/console-demo.test.ts pins that this sentence stays in the shell's source.
 */
export const DEMO_NOTE =
  "Demo controls — the switches, chips and steppers here change nothing. In your deployment they gate a real reader, a real guest door and a real budget; secrets render as presence, never values.";
