import { requireSecretOnly } from "../post-gate";
import { readShellStatus } from "../status-data";
import { unavailableStatus } from "../status-contract";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

function reply(body: unknown): Response {
  return Response.json(body, { headers: { "Cache-Control": "no-store" } });
}

export async function GET(
  req: Request,
  ctx: { params: Promise<{ secret: string }> },
): Promise<Response> {
  const gate = await requireSecretOnly(req, ctx.params);
  if ("deny" in gate) {
    gate.deny.headers.set("Cache-Control", "no-store");
    return gate.deny;
  }
  try {
    return reply(await readShellStatus());
  } catch {
    return reply(unavailableStatus());
  }
}
