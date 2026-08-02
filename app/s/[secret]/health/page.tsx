import { redirect } from "next/navigation";
import { requireSecret } from "@/lib/gate";

// The console replaced this page; the path survives so bookmarks do. Gated like everything
// else under /s — an unauthenticated probe learns nothing, not even where the console lives.
export const dynamic = "force-dynamic";

export default async function LegacyHealth({
  params,
}: {
  params: Promise<{ secret: string }>;
}) {
  const secret = await requireSecret(params);
  redirect(`/s/${secret}/console/overview`);
}
