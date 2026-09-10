#!/usr/bin/env npx tsx
/**
 * The RETRIEVAL eval — does narrowing put the right note in front of the reader?
 *
 * Separate from scripts/eval.ts, which measures the reader with model calls. This measures the
 * step BEFORE the reader, deterministically and for free: given a labelled question whose answer
 * lives in a known note, does the candidate set contain it?
 *
 * It exists because phase 5 proposes replacing in-memory BM25 with Postgres FTS, and this repo's
 * rule is that no strategy becomes the default without beating the incumbent on the labelled set.
 * The same rule the reader model lives under.
 *
 * WHAT IS MEASURED, per strategy:
 *   recall@k   TWO numbers, printed side by side: rank-only (the labelled note is somewhere in
 *              the k candidates — the historical, pre-strict number this study has always
 *              quoted) and strict (rank-only AND, for labels carrying `expect_contains`, the
 *              note's body actually contains the verified phrase — see below). Rank-only is
 *              what the historical recall measure meant; strict is additive on top of it and can
 *              only be equal or lower, never higher, since it is a stricter bar over the same
 *              candidates. Both are kept because collapsing to one number would hide which kind
 *              of miss a strategy has: not-found-at-all vs found-but-wrong-content.
 *   misses     labels where the note was NOT a hit at k — listed by rank, never just counted: a
 *              percentage with no examples cannot be argued with. Misses caused only by the
 *              strict `expect_contains` check (the note ranked fine, but its body doesn't carry
 *              the phrase) are tagged `[contains]` so a rank-only miss and a content-drift miss
 *              are never confused in the list.
 *
 *              CONTAINS MATCHING IS NORMALISED, not a literal byte substring check: markdown
 *              emphasis and code-span markers (`*`, `_`, `` ` ``) are stripped and whitespace is
 *              collapsed on both the phrase and the body before comparing. The corpus routinely
 *              quotes a verified sentence WITH its markdown intact — a note reads
 *              `**The saved export is a CACHE**, refreshed on...` (shape only; the export gate
 *              forbids naming a real note here) —
 *              while a label's `expect_contains` phrase is written as the plain sentence a reader
 *              sees, without the `**`/`` ` `` markers. A literal `.includes()` check treats those
 *              as different strings and can miss labels on pure formatting, not content; the
 *              normalised check finds the words a phrase actually asserts.
 *   pack       mean/max BYTES and mean/min LENGTH of the top-k notes actually handed to the reader
 *              for a label — the other half of the tradeoff recall alone doesn't show, plus how
 *              many labels got a pack SHORTER than k. Bytes alone hide that: a budget that stops
 *              a pack at five notes and a full pack of fifteen small ones print the same number,
 *              while a large-note corpus may shorten many packs.
 *
 * WHICH CONFIGURATION IS MEASURED. The `bm25` arm is the one production runs: `narrow()` with the
 * byte budget and the parts-per-page cap from `lib/ask.ts`, imported from there rather than
 * restated here, at `DEFAULT_K`. That is the whole point of this file — for most of the
 * recall-and-split branch it called `narrow(files, q, k)` with no opts, so the gate every
 * retrieval change ran under was measuring a configuration that does not ship, and the README
 * quoted numbers this command could not produce. `--budget`/`--max-parts` override a cap or turn
 * it off, and `--raw` adds an arm with no caps at all for comparison. Every run prints its
 * configuration above the numbers.
 *
 * Labels with expected=NONE are EXCLUDED. They test whether the reader abstains, which is not a
 * retrieval property — scoring them here would reward a strategy for returning nothing.
 *
 * FROZEN-TREE RUNS. `--sha <hex>` measures the corpus as it existed at that commit in the brain
 * checkout, instead of today's working tree — `git archive <sha>` exported read-only into a temp
 * dir (the brain checkout itself is never written to). This is what makes eval numbers
 * reproducible: the working brain changes, so a recall result only means something when
 * it names the tree it was measured on. Labels always come from the live checkout's
 * tools/eval/labels.json — the label set isn't part of what's being frozen.
 *
 *   npx tsx scripts/eval-retrieval.ts                     # every strategy, working tree, production config
 *   npx tsx scripts/eval-retrieval.ts --k 5
 *   npx tsx scripts/eval-retrieval.ts --raw               # add the no-caps BM25 arm for comparison
 *   npx tsx scripts/eval-retrieval.ts --budget off --max-parts off
 *   npx tsx scripts/eval-retrieval.ts --sha <commit> --k 10
 */
import { readFileSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { resolveTrustedExecutable } from "./command-path.cjs";

interface Label {
  q: string;
  expected: string;
  difficulty?: string;
  expect_contains?: string;
}

export interface ArmResult {
  name: string;
  hits: number;
  rankHits: number;
  total: number;
  misses: Array<{
    q: string;
    expected: string;
    rank: number | null;
    packBytes: number;
    containsOnly?: boolean;
    /** Why the note is not in the pack, when the arm can say — see `why` on the rows. */
    why?: string;
  }>;
  meanPackBytes: number;
  maxPackBytes: number;
  /** Pack LENGTH, in notes. A cap can hand the reader five notes where k said fifteen, and the
   *  byte columns alone cannot show that: a short pack and a full one of small notes look the
   *  same. `shortPacks` is how many of `total` came back under k. */
  meanPackNotes: number;
  minPackNotes: number;
  shortPacks: number;
}

/**
 * Score one arm's rows against a recall@k bar. `rankHits` is the historical rank-only number:
 * `expected` somewhere in the top k, `expect_contains` ignored. `hits` is the strict number —
 * rankHits AND, when the label carries `expect_contains`, every phrase actually appears
 * (case-insensitively, markdown-normalised — see the header) in that note's body. Being in the
 * pack is not the same as answering from it; a label that would be silently wrong is a strict
 * miss even though the note technically made the cut, and is tagged `containsOnly` so it reads
 * differently from a label the arm never ranked at all.
 */
// Markdown emphasis and code-span markers (`**bold**`, `` `code` ``) sit INSIDE quoted phrases
// in the corpus — `**Reading a saved query's \`results.csv\` reads a CACHE**` is what a reader
// sees as plain prose, but a literal substring search never matches a phrase quoted without
// those markers. Strip them, and collapse whitespace (a phrase can span a soft-wrapped line),
// before comparing — the check should hold on the WORDS a phrase asserts, not on the exact
// bytes of markdown decoration around them.
function normaliseForContains(s: string): string {
  return s.replace(/[*_`]/g, "").replace(/\s+/g, " ").toLowerCase();
}

export function summarise(
  name: string,
  rows: Array<{
    q: string;
    expected: string;
    ranked: string[];
    packBytes: number;
    contains?: string[];
    bodies?: Map<string, string>;
    /** The arm's own account of why `expected` is absent from `ranked` — "evicted by the byte
     *  budget", "no lexical signal", and so on. Passed through to the miss, unread here. */
    why?: string;
  }>,
  k: number
): ArmResult {
  const misses: ArmResult["misses"] = [];
  let hits = 0;
  let rankHits = 0;
  for (const r of rows) {
    const idx = r.ranked.indexOf(r.expected);
    const rank = idx >= 0 ? idx + 1 : null;
    const rankHit = rank != null && rank <= k;
    if (rankHit) rankHits++;
    let hit = rankHit;
    let containsOnly = false;
    if (hit && r.contains?.length) {
      const body = normaliseForContains(r.bodies?.get(r.expected) ?? "");
      const contained = r.contains.every((c) => body.includes(normaliseForContains(c)));
      if (!contained) {
        hit = false;
        containsOnly = true; // ranked fine at k — this miss is ONLY the strict phrase check
      }
    }
    if (hit) hits++;
    else misses.push({ q: r.q, expected: r.expected, rank, packBytes: r.packBytes, containsOnly, why: r.why });
  }
  // Insertion order, not sorted here — the console printer sorts by rank ascending (unranked
  // last) for display; summarise() hands back misses in the order rows were scored so callers
  // that want the raw order (tests) get it.
  const bytes = rows.map((r) => r.packBytes);
  // Pack length is derived here rather than passed in: it is exactly what the arm returned,
  // clipped at k, and deriving it means no caller can report a length that disagrees with the
  // candidate list the same row was scored on.
  const notes = rows.map((r) => Math.min(r.ranked.length, k));
  return {
    name,
    hits,
    rankHits,
    total: rows.length,
    misses,
    meanPackBytes: Math.round(bytes.reduce((a, b) => a + b, 0) / Math.max(1, bytes.length)),
    maxPackBytes: Math.max(0, ...bytes),
    meanPackNotes: Number((notes.reduce((a, b) => a + b, 0) / Math.max(1, notes.length)).toFixed(1)),
    minPackNotes: notes.length ? Math.min(...notes) : 0,
    shortPacks: notes.filter((n) => n < k).length,
  };
}

/**
 * Export `sha` out of the brain checkout at `brainDir` into a fresh temp directory. Two
 * commands, both read-only against the brain: `git archive` reads the object store, `tar`
 * unpacks the resulting stream into the temp dir — nothing is ever written back to `brainDir`.
 * maxBuffer is raised because the default 1 MB ceiling is smaller than the brain's own archive.
 *
 * Returns `{ dir, cleanup }` rather than just the path: an extracted tree is real disk (every
 * live note, once per `--sha` run), so a caller that forgets to remove it leaks quietly under
 * the OS temp dir forever. `cleanup()` is safe to call more than once (`force: true`) and is
 * ALSO registered on `process.on("exit", …)` as a last-resort net — if `main()`'s `finally`
 * doesn't run (an uncaught throw before it, a hard `process.exit`), the directory still goes
 * away when the process does, rather than surviving it.
 */
export function frozenTree(brainDir: string, sha: string): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(path.join(os.tmpdir(), "eval-frozen-"));
  const cleanup = () => rmSync(dir, { recursive: true, force: true });
  process.on("exit", cleanup);
  const git = resolveTrustedExecutable("git");
  const tar = resolveTrustedExecutable("tar");
  const tarball = execFileSync(git, ["-C", brainDir, "archive", "--format=tar", sha], {
    maxBuffer: 200 * 1024 * 1024,
  });
  execFileSync(tar, ["-x", "-C", dir], { input: tarball, maxBuffer: 200 * 1024 * 1024 });
  return { dir, cleanup };
}

/** A cap flag: a number, or the literal `off` to measure the same arm without that cap. */
function capFlag(argv: string[], name: string, dflt: number): number | undefined {
  const at = argv.indexOf(name);
  if (at < 0) return dflt;
  const raw = argv[at + 1];
  if (raw === "off") return undefined;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) {
    console.error(`${name} takes a non-negative number or "off", got ${raw ?? "(nothing)"}`);
    process.exit(2);
  }
  return n;
}

const fmtBytes = (n: number) => n.toLocaleString("en-US");

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const shaAt = argv.indexOf("--sha");
  const sha = shaAt >= 0 ? argv[shaAt + 1] : undefined;
  if (shaAt >= 0 && !sha) {
    console.error("--sha needs a commit-ish");
    process.exit(2);
  }
  const alsoRaw = argv.includes("--raw");

  const env = readFileSync(path.join(process.cwd(), ".env.local"), "utf8");
  for (const line of env.split("\n")) {
    const m = line.match(/^([A-Z_]+)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim().replace(/^"|"$/g, "");
  }

  // THE NUMBERS THE PRODUCTION PATH USES, IMPORTED — never restated here. This harness spent the
  // branch measuring `narrow(files, q, k)` with no opts while `ask()` passed a byte budget and a
  // parts-per-page cap, so the gate every retrieval change ran under was applied to a
  // configuration that does not ship, and the README quoted numbers this command could not
  // produce. Imported after the .env.local read above, because lib modules read env at load.
  const { DEFAULT_K, NARROW_BUDGET_BYTES, DEFAULT_MAX_PARTS_PER_PAGE } = await import("../lib/ask");
  const kAt = argv.indexOf("--k");
  const K = kAt >= 0 ? Number(argv[kAt + 1]) : DEFAULT_K;
  if (!Number.isInteger(K) || K < 1) {
    console.error("--k must be a positive integer");
    process.exit(2);
  }
  const budgetBytes = capFlag(argv, "--budget", NARROW_BUDGET_BYTES);
  const maxPartsPerPage = capFlag(argv, "--max-parts", DEFAULT_MAX_PARTS_PER_PAGE);

  /**
   * The floor that makes this a GATE rather than a report.
   *
   * Recall can drift as a corpus grows, so the evaluation must run as a gate rather than only when
   * a person remembers. A number printed to an unwatched terminal is not a measurement, it is a
   * hope.
   *
   * Compared against the RANK-ONLY recall of the incumbent arm: the measure the constants were
   * fitted to. Strict recall prints beside it and is the
   * better long-run target, but moving the gate onto it is a decision to take with a re-fit, not
   * a side effect of adding a flag.
   */
  /**
   * --only <substring>: run one arm instead of nine.
   *
   * The gate needs the arm that SHIPS. Running the six hop shapes, FTS and the hybrid to decide
   * whether the incumbent cleared a floor is nine times the work for one number, and it is what
   * pushed brain-gate past its ten-minute ceiling the first time this ran in CI. The comparison
   * arms are why this harness exists and stay the default for a human reading a run; they are
   * simply not what a red tick is about.
   */
  const onlyAt = argv.indexOf("--only");
  const only = onlyAt >= 0 ? argv[onlyAt + 1] : undefined;
  if (onlyAt >= 0 && !only) {
    console.error("--only needs an arm name, e.g. --only bm25");
    process.exit(2);
  }

  let minRecall: number | null = null;
  const mrAt = argv.indexOf("--min-recall");
  if (mrAt >= 0) {
    const n = Number(argv[mrAt + 1]);
    if (!Number.isFinite(n) || n <= 0 || n > 1) {
      console.error(`--min-recall must be a fraction between 0 and 1, got ${argv[mrAt + 1]}`);
      process.exit(2);
    }
    minRecall = n;
  }
  const narrowOpts = { budgetBytes, maxPartsPerPage };

  const brain = process.env.BRAIN_DIR ?? path.join(process.cwd(), "..", "brain");
  const labelsPath = path.join(brain, "tools/eval/labels.json");
  if (!existsSync(labelsPath)) {
    console.error(`no labels at ${labelsPath} — set BRAIN_DIR`);
    process.exit(2);
  }
  const all = JSON.parse(readFileSync(labelsPath, "utf8")) as Label[];
  // Absence labels test the reader's abstention, not retrieval. Including them would credit a
  // strategy for finding nothing.
  const labels = all.filter((l) => String(l.expected).toUpperCase() !== "NONE");
  console.log(`${labels.length} routable labels (of ${all.length}; ${all.length - labels.length} are absence tests) · k=${K}\n`);
  // Said out loud, on every run: which configuration the numbers below describe. A recall figure
  // that does not name its caps is not reproducible, and the README quotes these lines.
  console.log(
    `bm25 configuration — the PRODUCTION defaults from lib/ask.ts: k ${K}${K === DEFAULT_K ? "" : ` (--k; ships as ${DEFAULT_K})`}` +
      ` · byte budget ${budgetBytes == null ? "off (--budget)" : `${fmtBytes(budgetBytes)} B${budgetBytes === NARROW_BUDGET_BYTES ? "" : " (--budget)"}`}` +
      ` · history parts per page ${maxPartsPerPage == null ? "off (--max-parts)" : `${maxPartsPerPage}${maxPartsPerPage === DEFAULT_MAX_PARTS_PER_PAGE ? "" : " (--max-parts)"}`}` +
      ` · day logs 1 (narrow()'s own default)\n`
  );

  // ── the corpus: either today's working tree, or a frozen `git archive` of `--sha` ─────────
  // The frozen export is real disk under the OS temp dir — always removed in `finally`, once
  // the corpus has been read into `files` and the directory itself is no longer needed.
  const frozen = sha ? frozenTree(brain, sha) : null;
  const corpusDir = frozen ? frozen.dir : brain;
  const { narrow, rank } = await import("../lib/narrow");
  const { isLive } = await import("../lib/corpus");
  const { readdirSync, statSync } = await import("node:fs");
  const walk = (dir: string, base = ""): string[] => {
    const out: string[] = [];
    for (const name of readdirSync(dir)) {
      if (name === ".git") continue;
      const abs = path.join(dir, name);
      const rel = base ? `${base}/${name}` : name;
      if (statSync(abs).isDirectory()) out.push(...walk(abs, rel));
      else out.push(rel);
    }
    return out;
  };
  const files = new Map<string, string>();
  try {
    for (const rel of walk(corpusDir)) {
      if (isLive(rel)) files.set(rel, readFileSync(path.join(corpusDir, rel), "utf8"));
    }
  } finally {
    frozen?.cleanup();
  }
  console.log(`corpus: ${files.size} live notes · ${sha ? `brain@${sha}` : "working tree"}\n`);

  // ── the challenger: Postgres FTS ──────────────────────────────────────────────────────────
  const base = process.env.SUPABASE_URL?.replace(/\/$/, "");
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const hasSupabase = Boolean(base && key);
  const ftsSearch = async (q: string, k: number): Promise<string[]> => {
    if (!base || !key) throw new Error("SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set");
    const res = await fetch(`${base}/rest/v1/rpc/search_notes`, {
      method: "POST",
      headers: { apikey: key, Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ q, k }),
    });
    if (!res.ok) throw new Error(`search_notes HTTP ${res.status}`);
    return ((await res.json()) as Array<{ path: string }>).map((r) => r.path);
  };

  // ── the graph challengers: BM25 widened one hop along note_edges ──────────────────────────
  // Edges are derived from the SAME corpus snapshot the incumbent ranks, so both arms describe
  // one set of bytes. link/tag/correction are derivable offline; lexical too, though it is
  // BM25's own opinion re-stored as edges — kept derivable so the all-kinds shapes can measure
  // that redundancy instead of asserting it. coaccess is the exception: its raw material
  // (note_access) lives only in Postgres, so the harness pulls the prod graph's coaccess rows
  // live — built at the prod mirror's head, which can drift from the local checkout. Stated
  // rather than hidden: when the fetch fails, the coaccess-bearing shapes simply run without
  // those rows, and the summary line says what the adjacency was actually made of.
  const { deriveEdges } = await import("../lib/edges");
  const { buildAdjacency, hopNarrow, HOP_SHAPES } = await import("../lib/hop");
  const offline = deriveEdges(files);
  let coaccess: typeof offline = [];
  try {
    if (!base || !key) throw new Error("SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set");
    const PAGE = 1000;
    for (let from = 0; ; from += PAGE) {
      const res = await fetch(
        `${base}/rest/v1/note_edges?select=src,dst,kind,weight,evidence&kind=eq.coaccess&order=src.asc,dst.asc`,
        {
          headers: { apikey: key, Authorization: `Bearer ${key}`, Range: `${from}-${from + PAGE - 1}`, "Range-Unit": "items" },
        }
      );
      if (!res.ok) throw new Error(`note_edges HTTP ${res.status}`);
      const rows = (await res.json()) as typeof offline;
      coaccess.push(...rows);
      if (rows.length < PAGE) break;
    }
  } catch (e) {
    console.log(`coaccess edges unavailable (${e instanceof Error ? e.message : e}) — hop shapes run without them\n`);
    coaccess = [];
  }
  const byKind = new Map<string, number>();
  for (const r of [...offline, ...coaccess]) byKind.set(r.kind, (byKind.get(r.kind) ?? 0) + 1);
  console.log(
    `graph: ${offline.length + coaccess.length} edges — ` +
      [...byKind.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([kind, n]) => `${kind} ${n}`).join(" · ") +
      ` (coaccess ${coaccess.length ? "fetched live from prod" : "absent"})\n`
  );
  const adjacency = buildAdjacency([...offline, ...coaccess]);

  // Candidates are always fetched up to RANK_DEPTH so a miss's rank can be reported even when it
  // falls outside k — "not in top 100" is a different failure than "ranked 31st and we asked for
  // 10". summarise() applies the actual k bar on top of this fixed-depth ranking.
  const RANK_DEPTH = 100;

  /**
   * Why a label's note is not among the candidates — the distinction the old output could not
   * draw. `(not in top 100)` was printed both for a note that never ranked and for one a cap
   * threw out of an otherwise-winning position, and that ambiguity misled the controller during
   * task 6b badly enough to be recorded in the ledger.
   *
   * The question worth asking of a miss is: WOULD THIS LABEL HAVE BEEN A HIT WITHOUT THAT CAP?
   * That is answered by DEMONSTRATION, not inference — each cap is turned off on its own and the
   * pack is rebuilt. Guessing the cap from the note's path reads plausibly and is wrong in the
   * case that matters most: a note can rank 23rd on raw BM25 and still reach a pack of 15,
   * because the caps above it remove notes and everything below moves up. Only re-running says
   * so. Misses are a handful per arm, so three extra narrow() calls each cost nothing.
   */
  function whyMissing(q: string, expected: string): string {
    const at = rank(files, q).findIndex((s) => s.path === expected);
    if (at < 0) return "no lexical signal — the note scores zero for this question";
    const withoutEach: Array<[string, Parameters<typeof narrow>[3]]> = [
      [`the byte budget (${budgetBytes == null ? "off" : `${fmtBytes(budgetBytes)} B`})`, { ...narrowOpts, budgetBytes: undefined }],
      [`the parts-per-page cap (${maxPartsPerPage ?? "off"})`, { ...narrowOpts, maxPartsPerPage: undefined }],
      ["the day-log cap (1)", { ...narrowOpts, maxLogs: Number.MAX_SAFE_INTEGER }],
    ];
    for (const [cap, opts] of withoutEach) {
      if (narrow(files, q, K, opts).includes(expected)) {
        return `EVICTED by ${cap} — ranked ${at + 1} on BM25 alone, and reaches the pack once that cap is lifted`;
      }
    }
    return `ranked ${at + 1} on BM25 alone — outside k with or without the caps`;
  }

  const strategies: Array<{
    name: string;
    run: (q: string, k: number) => Promise<string[]>;
    requiresSupabase?: boolean;
    /** Explains a miss for arms built on narrow() — see whyMissing. */
    explain?: (q: string, expected: string) => string;
  }> = [
    {
      name: "bm25",
      run: async (q, k) => narrow(files, q, k, narrowOpts),
      explain: whyMissing,
    },
    // The comparison arm: BM25 with nothing applied — no budget, no part cap, and not even
    // narrow()'s one-log default. This is the shape the harness measured for the whole branch,
    // kept behind a flag so the difference between "what BM25 ranks" and "what the reader is
    // handed" can be read off one run instead of argued about.
    ...(alsoRaw
      ? [{ name: "bm25 raw (no caps)", run: async (q: string, k: number) => rank(files, q).slice(0, k).map((s) => s.path) }]
      : []),
    { name: "fts", run: ftsSearch, requiresSupabase: true },
    ...Object.entries(HOP_SHAPES).map(([shape, config]) => ({
      name: `hop ${shape}`,
      run: async (q: string, k: number) => hopNarrow(files, q, k, adjacency, config),
    })),
    {
      // Union, incumbent first. If both arms find things the reader sees both; the point is to
      // learn whether they MISS different labels, which is the only case where a hybrid earns
      // its extra complexity.
      name: "hybrid",
      requiresSupabase: true,
      run: async (q, k) => {
        const [a, b] = await Promise.all([narrow(files, q, k, narrowOpts), ftsSearch(q, k)]);
        const seen = new Set<string>();
        const out: string[] = [];
        for (let i = 0; i < k; i++) {
          for (const list of [a, b]) {
            const p = list[i];
            if (p && !seen.has(p)) {
              seen.add(p);
              out.push(p);
            }
          }
        }
        return out.slice(0, k);
      },
    },
  ];

  const results: ArmResult[] = [];
  const selected = only ? strategies.filter((s) => s.name.includes(only)) : strategies;
  if (only && selected.length === 0) {
    console.error(`--only ${only} matched no arm. Available: ${strategies.map((s) => s.name).join(", ")}`);
    process.exit(2);
  }
  for (const s of selected) {
    if (s.requiresSupabase && !hasSupabase) {
      console.log(`${s.name}  skipped (no SUPABASE_URL)`);
      continue;
    }
    const rows: Array<{
      q: string;
      expected: string;
      ranked: string[];
      packBytes: number;
      contains?: string[];
      bodies?: Map<string, string>;
      why?: string;
    }> = [];
    for (const l of labels) {
      let ranked: string[];
      try {
        ranked = await s.run(l.q, RANK_DEPTH);
      } catch (e) {
        console.error(`  ${s.name} errored on "${l.q}": ${e instanceof Error ? e.message : e}`);
        ranked = [];
      }
      let packBytes = 0;
      for (const p of ranked.slice(0, K)) packBytes += Buffer.byteLength(files.get(p) ?? "", "utf8");
      rows.push({
        q: l.q,
        expected: l.expected,
        ranked,
        packBytes,
        contains: l.expect_contains ? [l.expect_contains] : undefined,
        bodies: files,
        why: s.explain && !ranked.includes(l.expected) ? s.explain(l.q, l.expected) : undefined,
      });
    }
    results.push(summarise(s.name, rows, K));
  }

  const pct = (n: number, d: number) => (d ? `${((n / d) * 100).toFixed(1)}%` : "0.0%");
  for (const r of results) {
    console.log(
      `${r.name}  recall@${K} rank-only ${r.rankHits}/${r.total} = ${pct(r.rankHits, r.total)}  strict ${r.hits}/${r.total} = ${pct(r.hits, r.total)}`
    );
    // Length beside bytes. A cap can hand the reader five notes where k asked for fifteen, and
    // the byte columns cannot show it — a short pack and a full pack of small notes read the same.
    console.log(
      `      pack  mean ${fmtBytes(r.meanPackBytes)} B / ${r.meanPackNotes.toFixed(1)} notes · ` +
        `max ${fmtBytes(r.maxPackBytes)} B · shorter than k: ${r.shortPacks}/${r.total} (shortest ${r.minPackNotes})`
    );
    if (r.misses.length) {
      console.log("misses by rank:");
      const sorted = [...r.misses].sort((a, b) => (a.rank ?? Infinity) - (b.rank ?? Infinity));
      for (const m of sorted) {
        const rankCol = (m.rank != null ? String(m.rank) : "—").padStart(3);
        const detail = m.rank != null ? `(rank ${m.rank})` : `(${m.why ?? `not in top ${RANK_DEPTH}`})`;
        const tag = m.containsOnly ? "  [contains]" : "";
        console.log(`  ${rankCol}  ${m.q}  expected ${m.expected}  ${detail}${tag}`);
      }
    }
    console.log("");
  }

  if (minRecall !== null) {
    // The incumbent arm is the one that ships. The experimental shapes are printed for comparison
    // and must never be able to hold the gate open on the incumbent's behalf.
    const incumbent = results.find((r) => /bm25/i.test(r.name)) ?? results[0];
    if (!incumbent) {
      console.error("--min-recall: no arm produced a result to gate on");
      process.exit(2);
    }
    const got = incumbent.total ? incumbent.rankHits / incumbent.total : 0;
    const line = `${incumbent.name} rank-only recall@${K} = ${(got * 100).toFixed(1)}% against a floor of ${(minRecall * 100).toFixed(1)}%`;
    if (got < minRecall) {
      console.error(`FLOOR BREACHED — ${line}`);
      console.error(
        "The misses above are the whole list. Either retrieval got worse or the corpus outgrew " +
          "what the current constants carry; both are real, and neither fixes itself."
      );
      process.exit(1);
    }
    console.log(`floor ok — ${line}`);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  });
}
