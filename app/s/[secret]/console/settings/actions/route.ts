import { clearAnswerCache } from "@/lib/anscache";
import { loadCorpus } from "@/lib/corpus";
import { rebuildEdges } from "@/lib/edges";
import { bad, gateConsolePost } from "../../post-gate";

/**
 * The Learning section's two ACTIONS — clear the answer cache, rebuild the connections graph.
 *
 * Separate from ../save on purpose: save persists a selection, these DO something now, and a
 * handler where "store this number" and "delete these keys" share a body shape is a handler
 * where one typo'd field does the other's job. Same gate as every console write (post-gate.ts):
 * the secret re-proven per request, same-origin only, JSON object body.
 *
 * Both actions are safe to repeat. A cleared cache is a cold cache — the next asks answer fresh
 * and re-fill it. A rebuild is a full idempotent replace at the current mirror head, serialized
 * by the RPC's own singleton lock; two operators clicking together get one graph, built twice.
 */
export const dynamic = "force-dynamic";
// Deriving every edge kind over the corpus is O(n²) tokenisation — seconds, not milliseconds,
// and the default function budget would cut the rebuild off mid-wait.
export const maxDuration = 60;

export async function POST(
  req: Request,
  ctx: { params: Promise<{ secret: string }> }
): Promise<Response> {
  const gate = await gateConsolePost(req, ctx.params);
  if ("deny" in gate) return gate.deny;
  const action = gate.body.action;

  if (action === "clear-answer-cache") {
    try {
      const cleared = await clearAnswerCache();
      return Response.json({ ok: true, cleared });
    } catch (e) {
      // A clear that could not run reports as its own failure — "cleared 0" would be a lie
      // with the same shape as an empty cache.
      return bad(e instanceof Error ? e.message : String(e), 503);
    }
  }

  if (action === "rebuild-graph") {
    try {
      // The same path scheduleEdgeRebuild rides after a reconcile, awaited instead of after()ed
      // because the click wants the verdict. loadCorpus() heals the mirror first, so the head
      // handed to the RPC is the head the mirror is actually serving. force, because the
      // button's promise is a rebuild — the skip-when-current shortcut answers the scheduler's
      // question ("did the head move"), not the operator's ("rebuild it").
      const corpus = await loadCorpus();
      const r = await rebuildEdges(corpus.files, corpus.sha, { force: true });
      switch (r.state) {
        case "rebuilt":
          return Response.json({ ok: true, state: "rebuilt", head: r.head, derived: r.derived });
        case "current":
          // Unreachable under force, but the type demands an honest answer for it.
          return Response.json({ ok: true, state: "current", head: r.head });
        case "stale-head":
          return bad(
            "the mirror advanced while the rebuild ran, so it was refused whole rather than " +
              "describing a corpus nobody is serving — the next reconcile rebuilds at the current head",
            409
          );
        case "missing":
          return bad("note_edges is not migrated yet — run scripts/migrate.ts --apply first", 409);
        case "off":
          return bad("no graph store is configured (SUPABASE_URL unset) — there is no graph to rebuild", 409);
      }
    } catch (e) {
      return bad(e instanceof Error ? e.message : String(e), 502);
    }
  }

  return bad(`unknown action "${String(action)}"`);
}
