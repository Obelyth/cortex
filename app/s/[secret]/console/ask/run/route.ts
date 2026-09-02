import { ask, render } from "@/lib/ask";
import { stampOf } from "@/lib/calls";
import { modelReader } from "@/lib/reader";
import { readSettings, safeActiveReader } from "@/lib/settings";
import { bad, gateConsolePost } from "../../post-gate";

/**
 * The console's second write endpoint — and the only place in this product where the console
 * USES the brain instead of measuring it.
 *
 * Same gate as the settings write, for the same reason: a server action's id ships in a public
 * /_next/static chunk, so an action that spent a model call without re-proving the secret would
 * be a billable endpoint anyone who downloaded the bundle could reach. The secret is checked on
 * every request; a wrong one gets the same empty 404 as every other gate here.
 *
 * This door is trusted, so it is NOT scoped — the operator may ask about their whole brain, the
 * way the terminal can. What it does carry is a ceiling, because unlike every other console
 * screen this one costs money per interaction and the trusted doors have never had a budget.
 * The guest door meters in KV precisely so two concurrent callers cannot both take the last
 * slot; this is a single-operator surface, so a per-process ceiling is honest about what it is
 * rather than pretending to a distributed guarantee it does not have.
 */
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/** Per-instance, resets on cold start. Named so nobody mistakes it for the KV budget. */
const PROCESS_CEILING = 60;
let spentThisInstance = 0;

export async function POST(
  req: Request,
  ctx: { params: Promise<{ secret: string }> }
): Promise<Response> {
  const gate = await gateConsolePost(req, ctx.params);
  if ("deny" in gate) return gate.deny;

  const question = typeof gate.body.question === "string" ? gate.body.question.trim() : "";
  if (!question) return bad("ask something first");
  if (question.length > 500) return bad("questions are capped at 500 characters");

  if (spentThisInstance >= PROCESS_CEILING) {
    return bad(
      `this instance has answered ${PROCESS_CEILING} asks since it started — the ceiling exists so a stuck tab cannot bill the key in a loop`,
      429
    );
  }

  const settings = await readSettings();
  const { active, error } = await safeActiveReader(settings);
  if (!active) return bad(error ?? "no reader model is available", 503);

  spentThisInstance += 1;
  try {
    const r = await ask(question, modelReader, { model: active.model });
    // The stamp is taken from the SAME render() the MCP tool serves, then read back with the
    // same stampOf() the call log uses. Recomputing the verdict here would be a second
    // definition of the verification vocabulary, and a hardcoded roster drifting from the real
    // one is the exact failure lib/tool-roster.json exists to end. If they ever disagree, this
    // screen is wrong by construction rather than quietly.
    const rendered = render(r, { citations: true });
    return Response.json({
      stamp: stampOf(rendered),
      answer: r.answer,
      model: r.model,
      commit: r.commit,
      packTokens: r.packTokens,
      corpusTokens: r.corpusTokens,
      candidates: r.candidates,
      citation: r.citation
        ? {
            path: r.citation.path,
            // The FILE's text for the block, not what the model typed — what is displayed has
            // to be what was actually proven.
            evidence: r.citation.evidence ?? r.citation.quote,
            verified: r.citation.verified,
            reason: r.citation.reason,
            commit: r.citation.commit,
            line: r.citation.line ?? null,
            heading: r.citation.heading ?? null,
            superseded: Boolean(r.citation.superseded),
          }
        : null,
    });
  } catch (e) {
    // A reader that refused, timed out or returned nothing is a loud failure by contract —
    // reporting it as an empty answer would make "the model would not answer" and "the brain
    // does not know" the same result, the one confusion this system exists to prevent.
    return bad(e instanceof Error ? e.message : "the reader failed", 502);
  }
}
