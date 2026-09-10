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
      // Every refusal the rebuild can return is named here, with its state in the body so the
      // client can act on it. The switch is exhaustive over RebuildResult on purpose: a state
      // this handler did not know about used to fall through to `unknown action` — a 400 that
      // blamed the click for a verdict the store had actually delivered.
      const refused = (state: string, why: string) => Response.json({ error: why, state }, { status: 409 });
      switch (r.state) {
        case "rebuilt":
          return Response.json({ ok: true, state: "rebuilt", head: r.head, derived: r.derived });
        case "current":
          // Unreachable under force, but the type demands an honest answer for it.
          return Response.json({ ok: true, state: "current", head: r.head });
        case "stale-head":
          return refused(
            r.state,
            "the mirror advanced while the rebuild ran, so it was refused whole rather than " +
              "describing a corpus nobody is serving — the next reconcile rebuilds at the current head"
          );
        case "busy":
          return refused(r.state, "another rebuild holds the graph's lock right now — wait for it to finish, then rebuild again");
        case "capacity":
          return refused(r.state, "the corpus or its access history is larger than one rebuild will take (notes, bytes, edges or payload over the cap), so the graph was left as it was");
        case "budget":
          return refused(r.state, "deriving the edges ran past the rebuild's time budget before anything was sent, so the graph was left as it was");
        case "stale-input":
          return refused(r.state, "the usage identity or the structure version moved while the rebuild ran, so it was refused whole — the next reconcile rebuilds against the current inputs");
        case "missing":
          return refused(r.state, "note_edges is not migrated yet — run scripts/migrate.ts --apply first");
        case "off":
          return refused(r.state, "no graph store is configured (SUPABASE_URL unset) — there is no graph to rebuild");
        default: {
          // A new RebuildResult member is a type error here, never a runtime fall-through.
          const unhandled: never = r;
          return bad(`unhandled rebuild state ${JSON.stringify(unhandled)}`, 500);
        }
      }
    } catch (e) {
      return bad(e instanceof Error ? e.message : String(e), 502);
    }
  }

  return bad(`unknown action "${String(action)}"`);
}
