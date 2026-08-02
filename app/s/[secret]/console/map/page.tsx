import { requireSecret } from "@/lib/gate";
import { buildAtlas } from "@/lib/atlas";
import { MapClient } from "./map-client";

export const dynamic = "force-dynamic";
export const maxDuration = 60;
export const metadata = { title: "Map · Cortex console" };

/** The live map, inside the console shell. Data is server-built; the client does layout only. */
export default async function MapScreen({
  params,
}: {
  params: Promise<{ secret: string }>;
}) {
  await requireSecret(params);
  const { json, meta } = await buildAtlas();
  return <MapClient data={JSON.parse(json)} capturedAt={meta.capturedAt} />;
}
