// The machine door for the ops ledger. Bearer OPS_TOKEN only — a dedicated secret so a leaked
// heartbeat script can never write the brain. Wrong or missing auth is an empty 404, like the
// rest of the gated surface.
import { safeEqualStrings } from "@/lib/auth";
import { OpsHttpError, opsStore } from "@/lib/ops";
import { applyReport, parseReport,readReportBody } from "@/lib/ops-report";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

function authorized(req: Request): boolean {
  const expected = process.env.OPS_TOKEN?.trim();
  if (!expected || expected.length < 32) return false;
  const h = req.headers.get("authorization") ?? "";
  const m = /^Bearer\s+(.+)$/i.exec(h);
  return !!m && safeEqualStrings(m[1].trim(), expected);
}

export async function POST(req: Request): Promise<Response> {
  if (!authorized(req)) return new Response(null, { status: 404 });
  const body=await readReportBody(req);
  if("error" in body)return Response.json({error:body.error},{status:body.status});
  const parsed = parseReport(body.body);
  if (typeof parsed === "string") return Response.json({ error: parsed }, { status: 400 });
  const store = opsStore();
  if (!store) return Response.json({ error: "ops ledger not configured · SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY" }, { status: 503 });
  try {
    const units = await store.listUnits();
    const res = await applyReport(store, units, parsed, new Date());
    if (res.ok) return Response.json({ ok: true, replay: res.replay, run: res.run });
    return Response.json({ ok: false, error: res.error, run: res.run ?? null }, { status: res.status });
  } catch (e) {
    const status = e instanceof OpsHttpError ? 502 : 500;
    return Response.json({ error: e instanceof OpsHttpError ? e.message : "ops report unavailable; retry the same run key" }, { status });
  }
}
