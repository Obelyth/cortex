import { bad, gateConsolePost, requireSecretOnly } from "../../post-gate";
import { opsStore } from "@/lib/ops";
import { applyAction, githubDispatch, parseAction } from "@/lib/ops-actions";

export const dynamic = "force-dynamic";
export const maxDuration = 30;
const MAX_BODY_BYTES = 8_192;

export async function POST(req: Request, ctx: { params: Promise<{ secret: string }> }): Promise<Response> {
  const auth = await requireSecretOnly(req, ctx.params);
  if ("deny" in auth) return auth.deny;
  if (req.headers.get("content-type")?.split(";")[0].trim().toLowerCase() !== "application/json") return bad("body must be JSON");
  const gate = await gateConsolePost(req,ctx.params,{maxBytes:MAX_BODY_BYTES,bodyFailure:reason=>bad(reason==="too_large"?"ops action request exceeds 8,192 bytes":reason==="timeout"?"body read timed out":"body must be a JSON object",reason==="too_large"?413:reason==="timeout"?408:400)});
  if ("deny" in gate) return gate.deny;
  const parsed = parseAction(gate.body);
  if (typeof parsed === "string") return bad(parsed);
  const store = opsStore();
  if (!store) return bad("ops ledger not configured · env", 503);
  try {
    const units = await store.listUnits();
    const res = await applyAction(store, units, parsed, new Date(), githubDispatch);
    if (res.ok) return Response.json(res,{headers:{"Cache-Control":"no-store"}});
    return Response.json(res, { status: res.status, headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    return Response.json({ ok: false, error: "ops action unavailable" }, { status: 502, headers: { "Cache-Control": "no-store" } });
  }
}
