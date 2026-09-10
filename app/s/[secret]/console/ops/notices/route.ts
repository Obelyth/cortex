import { bad, gateConsolePost, requireSecretOnly } from "../../post-gate";
import { opsStore } from "@/lib/ops";
import { buildNotices, readReadMark, writeReadMark } from "@/lib/notices";

/**
 * The notices feed: a filtered view of ops_events plus this device's read mark, never a second
 * source of truth. GET is stamp-gated but body-less — requireSecretOnly, not gateConsolePost —
 * because it changes nothing on the server. POST advances the read mark and needs the full
 * write gate (origin check included) since it does write, even though the write is tiny.
 */
export const dynamic = "force-dynamic";
export const maxDuration = 30;

export async function GET(req: Request, ctx: { params: Promise<{ secret: string }> }): Promise<Response> {
  const gate = await requireSecretOnly(req, ctx.params);
  if ("deny" in gate) return gate.deny;
  const store = opsStore();
  if (!store) return Response.json({ mode: "unconfigured", notices: [], unread: 0 });
  try {
    const [units, events, mark] = await Promise.all([store.listUnits(), store.listEvents(new Date(Date.now() - 7 * 86400_000).toISOString(), 200), readReadMark(gate.stamp)]);
    const notices = buildNotices(events, new Map(units.map((u) => [u.id, u.name])), mark);
    return Response.json({ mode: "live", notices, unread: notices.filter((n) => n.unread).length });
  } catch { return Response.json({ mode: "unreachable", notices: [], unread: 0 }); }
}

export async function POST(req: Request, ctx: { params: Promise<{ secret: string }> }): Promise<Response> {
  const gate = await gateConsolePost(req, ctx.params);
  if ("deny" in gate) return gate.deny;
  const upTo = Number(gate.body.upTo);
  if (!Number.isInteger(upTo) || upTo < 0) return bad("upTo must be a non-negative integer");
  await writeReadMark(gate.stamp, upTo);
  return Response.json({ ok: true, upTo });
}
