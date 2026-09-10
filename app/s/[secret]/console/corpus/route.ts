import { safeEqualStrings } from "@/lib/auth";

/**
 * The Notes screen folded into Ask (v2, 2026-09-05): the explorer on `ask` is the corpus as
 * files, and `ask?note=<path>` opens the lens on a note the way `corpus?note=` used to filter
 * the ledger. This route keeps every old link honest — bookmarks, old notices, the three
 * screens that still link `corpus?note=` until their own ports move them — with a 308 to the
 * new address.
 *
 * RELATIVE, ON PURPOSE. The Location is `ask?note=…` (a sibling segment), so the secret in the
 * path rides along from the request and never appears in anything this handler writes. Only a
 * proven secret gets the redirect at all: a wrong one gets the same empty 404 as every other
 * gate, so the old path does not advertise that a new one exists. The device stamp is left to
 * the destination page, which sends an unstamped device to the entry route as it always has.
 */
export const dynamic = "force-dynamic";

export async function GET(
  req: Request,
  ctx: { params: Promise<{ secret: string }> }
): Promise<Response> {
  const { secret } = await ctx.params;
  const expected = process.env.CONNECTOR_PATH_SECRET;
  if (!expected || !safeEqualStrings(secret, expected)) return new Response(null, { status: 404 });

  const url = new URL(req.url);
  const note = url.searchParams.get("note")?.trim() ?? "";
  const query = note ? `?note=${encodeURIComponent(note)}` : "";
  // A trailing slash makes the browser resolve against `corpus/` rather than `console/`, so the
  // sibling then needs one more step up. Next strips the slash by default; this is the guard.
  const location = `${url.pathname.endsWith("/") ? "../" : ""}ask${query}`;
  return new Response(null, { status: 308, headers: { Location: location } });
}
