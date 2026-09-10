import { requireSecret } from "@/lib/gate";
import { redirect } from "next/navigation";

export const dynamic = "force-dynamic";
export const metadata = { title: "Ask · Cortex console" };

/**
 * Compatibility page for authenticated Map bookmarks. The gate stays local to this leaf: a
 * parent layout cannot protect sibling page work, and the retired inventory must remain
 * undiscoverable to a caller without the console credential.
 */
export default async function MapScreen({ params }: { params: Promise<{ secret: string }> }) {
  const secret = await requireSecret(params);
  redirect(`/s/${encodeURIComponent(secret)}/console/ask`);
}
