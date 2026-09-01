import { redirect } from "next/navigation";
import { requireSecret } from "@/lib/gate";

export const dynamic = "force-dynamic";

/** Merged into settings (the v4 consolidation). The segment stays so bookmarks and muscle
 *  memory keep working; the gate still runs first — a redirect must not leak that the segment
 *  exists to someone without the secret. */
export default async function Merged({
  params,
}: {
  params: Promise<{ secret: string }>;
}) {
  const secret = await requireSecret(params);
  redirect(`/s/${secret}/console/settings`);
}
