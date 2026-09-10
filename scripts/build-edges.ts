/**
 * build-edges — manually rebuild the connections graph from the corpus at head.
 *
 * The automatic trigger checks both corpus and completed-hour usage freshness (lib/corpus.ts), so this
 * script exists for the moments the trigger cannot cover: the first build after the migration
 * lands, a rebuild after a code change to the derivation, and "prove the builder is idempotent"
 * during review. Zero model calls; the graph is derived, never asserted.
 *
 * Usage (supply the deployment's environment values without committing them):
 *   SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... BRAIN_REPO=... GITHUB_TOKEN=... \
 *     npx tsx scripts/build-edges.ts            # rebuild if the graph is behind the head
 *   ... npx tsx scripts/build-edges.ts --force  # rebuild even when built_head == head
 *
 * Exit codes: 0 rebuilt-or-current · 2 not configured / not migrated · 1 anything else.
 */
import { loadCorpus } from "../lib/corpus";
import { rebuildEdges } from "../lib/edges";
import path from "node:path";
import { pathToFileURL } from "node:url";

export async function runBuildEdges(options: {
  force: boolean;
  load?: typeof loadCorpus;
  rebuild?: typeof rebuildEdges;
  log?: (message: string) => void;
  error?: (message: string) => void;
}): Promise<number> {
  const log = options.log ?? console.log;
  const error = options.error ?? console.error;
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    error("SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY are not set — the graph is opt-in, and without them there is nowhere to build it.");
    return 2;
  }

  const corpus = await (options.load ?? loadCorpus)();
  const head = corpus.sha;
  log(`corpus @${head.slice(0, 12)} · ${corpus.files.size} notes`);

  const r = await (options.rebuild ?? rebuildEdges)(corpus.files, head, { force: options.force });
  switch (r.state) {
    case "off":
      error("store not configured — nothing was built");
      return 2;
    case "missing":
      error("learning freshness RPCs are not migrated yet — run scripts/migrate.ts --apply first. Nothing was built.");
      return 2;
    case "current":
      log(`graph describes ${head.slice(0, 8)} and current eligible usage — skipped. Re-run with --force to rebuild anyway.`);
      return 0;
    case "stale-head":
    case "stale-input":
    case "busy":
    case "capacity":
    case "budget":
      error(`refresh refused (${r.state}) at ${head.slice(0, 8)}; no replacement published by this attempt. The graph is not confirmed fresh.`);
      return 1;
    case "rebuilt":
      log(`rebuilt at ${head.slice(0, 8)}: ${r.derived} structural edges derived (zero on usage-only refresh), coaccess recomputed in-database.`);
      return 0;
  }
}

async function main(): Promise<void> {
  process.exitCode = await runBuildEdges({ force: process.argv.includes("--force") });
}

if ((typeof require !== "undefined" && require.main === module) || (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href)) main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
