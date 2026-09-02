/**
 * build-edges — manually rebuild the connections graph from the corpus at head.
 *
 * The automatic trigger rides every reconcile that advances the head (lib/corpus.ts), so this
 * script exists for the moments the trigger cannot cover: the first build after the migration
 * lands, a rebuild after a code change to the derivation, and "prove the builder is idempotent"
 * during review. Zero model calls; the graph is derived, never asserted.
 *
 * Usage (env lives in your .env.local):
 *   SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... BRAIN_REPO=... GITHUB_TOKEN=... \
 *     npx tsx scripts/build-edges.ts            # rebuild if the graph is behind the head
 *   ... npx tsx scripts/build-edges.ts --force  # rebuild even when built_head == head
 *
 * Exit codes: 0 rebuilt-or-current · 2 not configured / not migrated · 1 anything else.
 */
import { loadCorpus } from "../lib/corpus";
import { deriveEdges, rebuildEdges } from "../lib/edges";

const force = process.argv.includes("--force");

async function main(): Promise<void> {
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    console.error("SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY are not set — the graph is opt-in, and without them there is nowhere to build it.");
    process.exit(2);
  }

  const corpus = await loadCorpus();
  const head = corpus.sha;
  console.log(`corpus @${head.slice(0, 12)} · ${corpus.files.size} notes`);

  // Derived up front for the report, even though rebuildEdges derives again on the non-skip
  // path — the point of this script is to SHOW what the builder would write, and one extra
  // in-memory derivation costs seconds against a corpus already downloaded.
  const derived = deriveEdges(corpus.files);
  const byKind = new Map<string, number>();
  for (const e of derived) byKind.set(e.kind, (byKind.get(e.kind) ?? 0) + 1);
  console.log(
    `derived ${derived.length} edges — ` +
      [...byKind.entries()].map(([k, n]) => `${k} ${n}`).join(" · ") +
      " · coaccess is computed in-database from note_access"
  );

  const r = await rebuildEdges(corpus.files, head, { force });
  switch (r.state) {
    case "off":
      // Unreachable given the guard above, but the type says it can happen; say so honestly.
      console.error("store not configured — nothing was built");
      process.exit(2);
      break;
    case "missing":
      console.error("note_edges is not migrated yet — run scripts/migrate.ts --apply first. Nothing was built.");
      process.exit(2);
      break;
    case "current":
      console.log(`graph already describes ${head.slice(0, 8)} — skipped. Re-run with --force to rebuild anyway.`);
      break;
    case "stale-head":
      // The mirror moved between our corpus load and the rebuild. Not an error: the next
      // reconcile rebuilds at the newer head, and a graph of a superseded corpus SHOULD be
      // refused rather than written.
      console.log(`refused: the mirror is no longer at ${head.slice(0, 8)} — the next reconcile rebuilds at the current head.`);
      break;
    case "rebuilt":
      console.log(`rebuilt at ${head.slice(0, 8)}: ${r.derived} derived edges replaced, coaccess recomputed in-database.`);
      break;
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
