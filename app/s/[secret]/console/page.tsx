import { redirect } from "next/navigation";
import { requireSecret } from "@/lib/gate";

/** The console's screens are siblings so relative links work; the root just forwards. */
export default async function ConsoleRoot({
  params,
}: {
  params: Promise<{ secret: string }>;
}) {
  const secret = await requireSecret(params);
  // Location header only — the browser already holds the secret; markup never does.
  redirect(`/s/${secret}/console/overview`);
}
