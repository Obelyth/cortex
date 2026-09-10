import { bad, gateConsolePost } from "../../post-gate";
import { groundCookie, groundFrom } from "../../ground";

/** Writes the ground choice as a cookie. Same gate as every console write: secret, device
 *  stamp, same origin, JSON body. */
export const dynamic = "force-dynamic";

export async function POST(req: Request, ctx: { params: Promise<{ secret: string }> }): Promise<Response> {
  const gate = await gateConsolePost(req, ctx.params);
  if ("deny" in gate) return gate.deny;
  const g = gate.body.ground;
  if (g !== "ink" && g !== "paper") return bad('ground must be "ink" or "paper"');
  const { secret } = await ctx.params;
  return Response.json({ ground: groundFrom(g) }, { headers: { "Set-Cookie": groundCookie(groundFrom(g), secret, new URL(req.url).protocol === "https:") } });
}
