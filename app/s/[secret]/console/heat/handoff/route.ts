import { gateConsolePost, bad } from "../../post-gate";
import { previewHandoff } from "@/lib/handoff";

/**
 * The handoff staging read — POST, not GET, so it rides the same post-gate as every console
 * endpoint (prove-secret, refuse-cross-origin, demand-JSON) rather than growing a second gate
 * for one route. It writes nothing: previewHandoff renders the exact bundle walk and
 * deliberately skips the access log, so staring at a project's bundle does not warm it.
 */
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function POST(
  req: Request,
  ctx: { params: Promise<{ secret: string }> }
): Promise<Response> {
  const gate = await gateConsolePost(req, ctx.params);
  if ("deny" in gate) return gate.deny;
  const b = gate.body;

  const project = b.project;
  if (typeof project !== "string" || !project.trim()) {
    return bad("project is required — the name the brain files it under, e.g. 'cortex'");
  }

  try {
    return Response.json(await previewHandoff(project));
  } catch (e) {
    // Unknown project (with the closest real names) and upstream failures both land here; the
    // message is the product's own sentence and the panel shows it as such.
    return bad(e instanceof Error ? e.message : String(e));
  }
}
