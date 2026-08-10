import { notFound } from "next/navigation";
import { safeEqualStrings } from "./auth";

/**
 * The console gate, callable from any segment. A layout's notFound() replaces the subtree the
 * client receives, but Next still executes and serializes sibling page components — and a
 * crafted RSC router-state can skip the layout segment entirely. So the check must run inside
 * every page, before any corpus read; the layout keeps it too, as depth.
 */
export async function requireSecret(params: Promise<{ secret: string }>): Promise<string> {
  const { secret } = await params;
  const expected = process.env.CONNECTOR_PATH_SECRET;
  if (!expected || !safeEqualStrings(secret, expected)) notFound();
  return secret;
}
