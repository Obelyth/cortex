import { requireSecret } from "@/lib/gate";
import { redirect } from "next/navigation";

// Keep the compatibility redirect request-bound so its independent auth check always runs.
export const dynamic = "force-dynamic";
export const metadata = { title: "Ask · Cortex console" };

/**
 * Compatibility page for the retired standalone Map. It authenticates independently before
 * redirecting so an old bookmark preserves the console's fail-closed behavior.
 */
export default async function LiveBoardPage({
  params,
}: {
  params: Promise<{ secret: string }>;
}) {
  const secret = await requireSecret(params);
  redirect(`/s/${encodeURIComponent(secret)}/console/ask`);
}
