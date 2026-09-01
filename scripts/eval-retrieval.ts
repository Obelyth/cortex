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
 *   recall@k   the labelled note is somewhere in the k candidates. This is the number that
 *              matters: the reader reads everything it is given, so a note in the pack can be
 *              answered from, wherever it ranks.
 *   top1       the labelled note ranked first. Interesting, not decisive.
 *   mrr        mean reciprocal rank over the labels that were found at all — how deep the reader
 *              has to look.
 *   misses     labels where the note was NOT in the candidates. Listed, never just counted: a
 *              percentage with no examples cannot be argued with.
 *
 * The 34 expected=NONE labels are EXCLUDED. They test whether the reader abstains, which is not a
 * retrieval property — scoring them here would reward a strategy for returning nothing.
 *
 *   npx tsx scripts/eval-retrieval.ts               # both strategies, k=10
 *   npx tsx scripts/eval-retrieval.ts --k 5
 */
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";

interface Label {
  q: string;
  expected: string;
  difficulty?: string;
}

interface Outcome {
  name: string;
  recall: number;
  top1: number;
  mrr: number;
  misses: Array<{ q: string; expected: string; difficulty?: string }>;
  scored: number;
  errors: number;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const kAt = argv.indexOf("--k");
  const K = kAt >= 0 ? Number(argv[kAt + 1]) : 10;
  if (!Number.isInteger(K) || K < 1) {
    console.error("--k must be a positive integer");
    process.exit(2);
  }

  const env = readFileSync(path.join(process.cwd(), ".env.local"), "utf8");
  for (const line of env.split("\n")) {
    const m = line.match(/^([A-Z_]+)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim().replace(/^"|"$/g, "");
  }

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

  // ── the incumbent: in-memory BM25 over the live corpus ────────────────────────────────────
  const { narrow } = await import("../lib/narrow");
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
  for (const rel of walk(brain)) {
    if (isLive(rel)) files.set(rel, readFileSync(path.join(brain, rel), "utf8"));
  }
  console.log(`corpus: ${files.size} live notes\n`);

  // ── the challenger: Postgres FTS ──────────────────────────────────────────────────────────
  const base = process.env.SUPABASE_URL?.replace(/\/$/, "");
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
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
      [...byKind.entries()].sort().map(([kind, n]) => `${kind} ${n}`).join(" · ") +
      ` (coaccess ${coaccess.length ? "fetched live from prod" : "absent"})\n`
  );
  const adjacency = buildAdjacency([...offline, ...coaccess]);

  const strategies: Array<{ name: string; run: (q: string, k: number) => Promise<string[]> }> = [
    { name: "BM25 (in-memory, incumbent)", run: async (q, k) => narrow(files, q, k) },
    { name: "FTS (Postgres)", run: ftsSearch },
    ...Object.entries(HOP_SHAPES).map(([shape, config]) => ({
      name: `hop ${shape}`,
      run: async (q: string, k: number) => hopNarrow(files, q, k, adjacency, config),
    })),
    {
      // Union, incumbent first. If both arms find things the reader sees both; the point is to
      // learn whether they MISS different labels, which is the only case where a hybrid earns
      // its extra complexity.
      name: "hybrid (BM25 ∪ FTS)",
      run: async (q, k) => {
        const [a, b] = await Promise.all([narrow(files, q, k), ftsSearch(q, k)]);
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

  const results: Outcome[] = [];
  for (const s of strategies) {
    let hits = 0;
    let top1 = 0;
    let rr = 0;
    let errors = 0;
    const misses: Outcome["misses"] = [];
    for (const l of labels) {
      let got: string[];
      try {
        got = await s.run(l.q, K);
      } catch (e) {
        errors++;
        continue;
      }
      const at = got.indexOf(l.expected);
      if (at === 0) top1++;
      if (at >= 0) {
        hits++;
        rr += 1 / (at + 1);
      } else {
        misses.push({ q: l.q, expected: l.expected, difficulty: l.difficulty });
      }
    }
    const scored = labels.length - errors;
    results.push({
      name: s.name,
      recall: scored ? hits / scored : 0,
      top1: scored ? top1 / scored : 0,
      mrr: hits ? rr / hits : 0,
      misses,
      scored,
      errors,
    });
  }

  const pct = (n: number) => `${(n * 100).toFixed(1)}%`;
  console.log(`${"strategy".padEnd(30)} ${`recall@${K}`.padStart(9)} ${"top-1".padStart(7)} ${"MRR".padStart(6)} ${"misses".padStart(7)}`);
  for (const r of results) {
    console.log(
      `${r.name.padEnd(30)} ${pct(r.recall).padStart(9)} ${pct(r.top1).padStart(7)} ${r.mrr.toFixed(3).padStart(6)} ${String(r.misses.length).padStart(7)}${r.errors ? `  (${r.errors} errored)` : ""}`
    );
  }

  // What each strategy alone would lose. This is the number that decides a hybrid: if the arms
  // miss the SAME labels, the union buys nothing but latency.
  const [bm25, fts] = results;
  const bmMiss = new Set(bm25.misses.map((m) => m.q));
  const ftsMiss = new Set(fts.misses.map((m) => m.q));
  const both = [...bmMiss].filter((q) => ftsMiss.has(q));
  console.log(`\noverlap: ${both.length} label(s) missed by BOTH · ${bmMiss.size - both.length} only BM25 · ${ftsMiss.size - both.length} only FTS`);
  if (both.length) {
    console.log("\nmissed by both (the labels no lexical arm reaches — the case for vectors):");
    for (const q of both.slice(0, 8)) {
      const l = labels.find((x) => x.q === q)!;
      console.log(`  [${l.difficulty ?? "?"}] ${q}  → ${l.expected}`);
    }
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
