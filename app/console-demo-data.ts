/**
 * Synthetic data for the landing's console demo — the gated console's shape with nothing
 * real on it, same contract as the demo map. Every path, SHA, count and quote here is
 * invented; tests/console-demo.test.ts pins that this file stays that way. The invented
 * project names follow the fixture convention (aurora, beacon, relay).
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

const DIR_FILL: Record<string, string> = {
  projects: "var(--accent-cyan)",
  notes: "#aeb8c4",
  log: "#8b97a4",
  root: "#677483",
};

export const DIRS = [
  { dir: "projects", notes: 18, raw: 34880 },
  { dir: "notes", notes: 16, raw: 29120 },
  { dir: "log", notes: 31, raw: 28410 },
  { dir: "root", notes: 3, raw: 3830 },
].map((d) => ({
  dir: d.dir,
  notes: d.notes,
  tokens: d.raw.toLocaleString("en-US"),
  fill: DIR_FILL[d.dir],
  w: Math.round((d.raw / 150000) * 100) + "%",
  share: Math.round((d.raw / 34880) * 100) + "%",
}));

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
    tokens: tokens.toLocaleString("en-US"),
    ret: ret || null,
  };
});

/** 24 hourly bars; the verified share of each is the cyan fill. */
export const BARS = [3, 2, 1, 0, 1, 2, 6, 11, 16, 21, 24, 19, 27, 33, 25, 18, 22, 29, 34, 30, 26, 17, 12, 8].map(
  (n, i) => {
    const h = Math.round((n / 34) * 92);
    const vh = Math.round(h * (i % 5 === 3 ? 0.86 : 0.97));
    return { vh, uh: Math.max(1, h - vh), last: i === 23 };
  },
);

export const SURFACES = [
  { name: "Claude Code", sub: "terminal", auth: "bearer", state: "ONLINE", status: "pass" as BadgeStatus, ago: "12 s" },
  { name: "Cursor", sub: "IDE · read+write", auth: "bearer", state: "ONLINE", status: "pass" as BadgeStatus, ago: "38 s" },
  { name: "Gemini CLI", sub: "terminal", auth: "bearer", state: "ONLINE", status: "pass" as BadgeStatus, ago: "3 min" },
  { name: "ChatGPT", sub: "custom connector", auth: "connector secret", state: "ONLINE", status: "pass" as BadgeStatus, ago: "9 min" },
  { name: "iOS", sub: "claude.ai app", auth: "connector secret", state: "ONLINE", status: "pass" as BadgeStatus, ago: "4 min" },
  { name: "Web", sub: "claude.ai", auth: "connector secret", state: "IDLE", status: "neutral" as BadgeStatus, ago: "6 hr" },
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
  { name: "brain_corpus", role: "the direct read", what: "Preferred read — hands notes to this conversation. No reader model." },
  { name: "brain_ask", role: "verified ask", what: "Optional: server-side reader plus a deterministic citation stamp." },
  { name: "brain_context", role: "the boot call", what: "Profile, index and the last week of log entries, in one call." },
  { name: "brain_read", role: "one note", what: "One note by path. Paths are allowlisted by shape." },
  { name: "brain_write", role: "the commit", what: "Create, replace or append. A save without a commit SHA did not happen." },
  { name: "brain_capture", role: "zero friction", what: "Timestamped append to today's log, from any device." },
];

export const STAMPS = [
  { tag: "VERIFIED", status: "pass" as BadgeStatus, line: "Verbatim in that file at that commit. Proves the text exists, not that the answer follows." },
  { tag: "SUPERSEDED", status: "warn" as BadgeStatus, line: "The quote is real, and the passage is retracted." },
  { tag: "PARTIAL", status: "warn" as BadgeStatus, line: "Verbatim in more than one note — the answer stands, the provenance does not." },
  { tag: "NOT IN BRAIN", status: "processing" as BadgeStatus, line: "The reader found nothing and said so. The abstain case." },
  { tag: "UNVERIFIED", status: "fail" as BadgeStatus, line: "Not in the cited file, or spanning a boundary. Shown anyway, labelled." },
];

export const NAV = [
  { k: "overview", label: "Overview", count: "" },
  { k: "corpus", label: "Corpus", count: "68" },
  { k: "attention", label: "Attention", count: "11" },
  { k: "map", label: "Map", count: "" },
  { k: "guide", label: "Guide", count: "" },
] as const;

export type ScreenKey = (typeof NAV)[number]["k"];
