#!/usr/bin/env npx tsx
/**
 * The PREDICTION eval — before a session starts, can the brain guess what it will touch?
 *
 * The gate for layer 1 of the learning layer (spec 2026-08-11), and for every future change to
 * how brain_handoff ranks its bundle: a ranking ships only if it beats the incumbent HERE, the
 * same rule eval-retrieval enforces for narrowing. Deterministic, zero model calls, free to run
 * on every PR — same rows in, same numbers out.
 *
 * HOW IT REPLAYS. note_access rows (mode <> 'boot' — boot rows record what the server pushes,
 * not what a session chose; mode <> 'handoff' for the same reason, since brain_handoff pushes
 * bundles) are grouped into clock-hour windows, the same window the coaccess derivation uses.
 * Each window with ≥2 distinct notes is a "session": hide it, predict its touched set from ONLY
 * the rows strictly before it, score recall@5 / recall@10 against what it actually touched.
 *
 * TWO RANKERS, from lib/prediction.ts — one definition, shared with the product: the handoff
 * bundle ranks by the WINNER here (recency+frequency, i.e. live temperature), and its
 * tiebreak/fallback is the same KIND_BLEND the candidate is scored with:
 *
 *   BASELINE    recency + frequency from the prior log alone. A stated PROXY for temperature:
 *               historical note_scores cannot be reconstructed (the inputs were never
 *               snapshotted), so the baseline recomputes temperature's own two ingredients from
 *               the rows that legitimately existed at each window. It does not try to rebuild
 *               the scores table, and grading against TODAY'S temperatures would leak the
 *               future into every past window.
 *   CANDIDATE   the baseline blended with co-access co-occurrence from the prior log and
 *               link/tag edges derived from the corpus (lib/edges.ts's own derivers — one
 *               opinion of "linked"). One stated anachronism: the corpus is read at its
 *               CURRENT head, because per-window historical graphs are no more
 *               reconstructable than historical temperatures. The co-occurrence half is
 *               windowed strictly; the structural half is the graph as it stands.
 *
 *   BRAIN_DIR=../brain npx tsx scripts/eval-prediction.ts          # both rankers, k=5 and 10
 *   ... npx tsx scripts/eval-prediction.ts --since 2026-08-06      # bound the replayed log
 */
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import path from "node:path";

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const sinceAt = argv.indexOf("--since");
  const since = sinceAt >= 0 ? argv[sinceAt + 1] : null;
  if (sinceAt >= 0 && !/^\d{4}-\d{2}-\d{2}$/.test(since ?? "")) {
    console.error("--since must be YYYY-MM-DD");
    process.exit(2);
  }

  // Same env loading as eval-retrieval: the script is local/manual and reads the private
  // checkout's .env.local without overriding anything already exported.
  if (existsSync(path.join(process.cwd(), ".env.local"))) {
    const env = readFileSync(path.join(process.cwd(), ".env.local"), "utf8");
    for (const line of env.split("\n")) {
      const m = line.match(/^([A-Z_]+)=(.*)$/);
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim().replace(/^"|"$/g, "");
    }
  }

  const base = process.env.SUPABASE_URL?.replace(/\/$/, "");
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!base || !key) {
    console.error("SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY are not set — the access log lives in Postgres.");
    process.exit(2);
  }

  const { sessionize, baselineScores, candidateScores, topK, recallAtK, pairKey, KIND_BLEND, HALF_LIFE_DAYS } =
    await import("../lib/prediction");
  type Structural = import("../lib/prediction").StructuralEdges;

  // ── the replayed log: every non-pushed access row, oldest first ──────────────────────────
  // Paged like lib/mirror.ts and for the same reason: PostgREST caps a response at its own
  // max-rows, and a silently truncated log would replay a history that never happened.
  const rows: Array<{ at: string; path: string }> = [];
  const PAGE = 1000;
  const filter = `note_access?select=at,path&mode=not.in.(boot,handoff)&order=at.asc,id.asc${
    since ? `&at=gte.${since}` : ""
  }`;
  for (let from = 0; ; from += PAGE) {
    const res = await fetch(`${base}/rest/v1/${filter}`, {
      headers: {
        apikey: key,
        Authorization: `Bearer ${key}`,
        Range: `${from}-${from + PAGE - 1}`,
        "Range-Unit": "items",
      },
    });
    if (!res.ok) {
      console.error(`note_access HTTP ${res.status}`);
      process.exit(1);
    }
    const page = (await res.json()) as Array<{ at: string; path: string }>;
    rows.push(...page);
    if (page.length < PAGE) break;
  }
  if (rows.length === 0) {
    console.error("note_access holds no non-boot rows — nothing to replay.");
    process.exit(2);
  }

  // ── structural edges, from the corpus on disk (same walk as eval-retrieval) ──────────────
  const brain = process.env.BRAIN_DIR ?? path.join(process.cwd(), "..", "brain");
  const structure: Structural = { links: new Set(), tags: new Map() };
  let corpusNote = "no corpus at BRAIN_DIR — candidate runs on co-access alone";
  if (existsSync(brain)) {
    const { isLive } = await import("../lib/corpus");
    const { linkEdges, tagEdges } = await import("../lib/edges");
    const walk = (dir: string, rel = ""): string[] => {
      const out: string[] = [];
      for (const name of readdirSync(dir)) {
        if (name === ".git") continue;
        const abs = path.join(dir, name);
        const r = rel ? `${rel}/${name}` : name;
        if (statSync(abs).isDirectory()) out.push(...walk(abs, r));
        else out.push(r);
      }
      return out;
    };
    const files = new Map<string, string>();
    for (const rel of walk(brain)) {
      if (isLive(rel)) files.set(rel, readFileSync(path.join(brain, rel), "utf8"));
    }
    for (const e of linkEdges(files)) structure.links.add(pairKey(e.src, e.dst));
    for (const e of tagEdges(files)) structure.tags.set(pairKey(e.src, e.dst), e.weight);
    corpusNote = `corpus: ${files.size} live notes → ${structure.links.size} link pairs, ${structure.tags.size} tag pairs`;
  }

  // ── replay ────────────────────────────────────────────────────────────────────────────────
  const windows = sessionize(rows);
  const scoreable = windows.filter((w) => w.paths.length >= 2);
  console.log(
    `${rows.length} access rows (mode ≠ boot/handoff) · ${windows.length} hour-windows · ` +
      `${scoreable.length} with ≥2 distinct notes · half-life ${HALF_LIFE_DAYS}d · ` +
      `blend coaccess ${KIND_BLEND.coaccess} / link ${KIND_BLEND.link} / tag ${KIND_BLEND.tag}`
  );
  console.log(corpusNote + "\n");

  interface Tally {
    r5: number;
    r10: number;
    scored: number;
  }
  const tally: Record<"baseline" | "candidate", Tally> = {
    baseline: { r5: 0, r10: 0, scored: 0 },
    candidate: { r5: 0, r10: 0, scored: 0 },
  };
  let candWins = 0;
  let candTies = 0;
  let candLosses = 0;
  let touchedTotal = 0;

  for (const w of scoreable) {
    // ONLY data strictly before the window: rows from earlier hours, and the windows they form.
    // A window's own rows never inform its prediction — that would be the leak.
    const prior = rows.filter((r) => Date.parse(r.at) < w.start);
    if (prior.length === 0) continue; // the first window has no history to predict from
    const priorWindows = windows.filter((pw) => pw.start < w.start);

    const basePred = topK(baselineScores(prior, w.start), 10);
    const candPred = topK(candidateScores(prior, priorWindows, structure, w.start), 10);

    const b5 = recallAtK(basePred, w.paths, 5);
    const b10 = recallAtK(basePred, w.paths, 10);
    const c5 = recallAtK(candPred, w.paths, 5);
    const c10 = recallAtK(candPred, w.paths, 10);
    tally.baseline.r5 += b5;
    tally.baseline.r10 += b10;
    tally.baseline.scored++;
    tally.candidate.r5 += c5;
    tally.candidate.r10 += c10;
    tally.candidate.scored++;
    touchedTotal += w.paths.length;
    if (c10 > b10) candWins++;
    else if (c10 === b10) candTies++;
    else candLosses++;
  }

  const pct = (n: number, d: number) => (d ? `${((n / d) * 100).toFixed(1)}%` : "—");
  const line = (name: string, t: Tally) =>
    console.log(
      `${name.padEnd(36)} ${pct(t.r5, t.scored).padStart(9)} ${pct(t.r10, t.scored).padStart(10)} ${String(t.scored).padStart(8)}`
    );
  console.log(`${"ranker".padEnd(36)} ${"recall@5".padStart(9)} ${"recall@10".padStart(10)} ${"windows".padStart(8)}`);
  line("BASELINE (recency+frequency)", tally.baseline);
  line("CANDIDATE (+ coaccess/link/tag)", tally.candidate);
  console.log(
    `\nmean touched set ${(touchedTotal / (tally.baseline.scored || 1)).toFixed(1)} notes · ` +
      `CANDIDATE vs BASELINE at recall@10: wins ${candWins} · ties ${candTies} · losses ${candLosses}`
  );
  console.log(
    "\nThe gate: brain_handoff ranks by the winner above. A challenger becomes the ranking only by beating the incumbent here."
  );
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
