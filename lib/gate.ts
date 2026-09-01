import { cookies } from "next/headers";
import { notFound, redirect } from "next/navigation";
import { safeEqualStrings } from "./auth";
import { STAMP_COOKIE, stampIsValid } from "./stamp";

/**
 * The console gate, callable from any segment. A layout's notFound() replaces the subtree the
 * client receives, but Next still executes and serializes sibling page components — and a
 * crafted RSC router-state can skip the layout segment entirely. So the check must run inside
 * every page, before any corpus read; the layout keeps it too, as depth.
 *
 * Two factors, checked in order. The URL's secret first, answered with the same empty 404 as
 * every other gate — a wrong secret never learns that a second factor exists. Then the device
 * stamp (see lib/stamp.ts): the link alone stopped being entry the day one leaked into a
 * transcript, so an unstamped device is sent to the entry route to answer the passcode prompt
 * — a redirect only a proven secret ever sees.
 */
export async function requireSecret(params: Promise<{ secret: string }>): Promise<string> {
  const { secret } = await params;
  const expected = process.env.CONNECTOR_PATH_SECRET;
  if (!expected || !safeEqualStrings(secret, expected)) notFound();
  const jar = await cookies();
  if (!stampIsValid(jar.get(STAMP_COOKIE)?.value)) redirect(`/s/${secret}/console`);
  return secret;
}
