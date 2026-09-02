import { requireSecret } from "@/lib/gate";
import { buildAtlas } from "@/lib/atlas";
import { LiveBoard } from "./live-board";

// Reads the live corpus on every request, so it must never be cached or statically rendered.
export const dynamic = "force-dynamic";
export const maxDuration = 60;
export const metadata = { title: "Second Brain · live board" };

/**
 * The Live Board, standalone and full-screen. Gated because it is an inventory: every MCP
 * server, hook, skill and note title is on the page — a map of how this machine is wired is
 * exactly what someone would want before attacking it. The public landing page carries the
 * abstract version of this diagram; this is the one with the real names on it.
 */
export default async function LiveBoardPage({
  params,
}: {
  params: Promise<{ secret: string }>;
}) {
  await requireSecret(params);
  const { json, meta } = await buildAtlas();
  // Same caption discipline as the console embed: null means the graph store gave no answer,
  // 0 means it answered "no ties" — the wordmark must never blur the two.
  const graph = meta.graphEdges === null ? "graph absent" : `graph ${meta.graphEdges} ties`;
  const srcline = `${meta.capturedAt ? `real data · rings ${meta.capturedAt}` : "real data · rings absent"} · ${graph}`;
  return (
    <div style={{ position: "fixed", inset: 0 }}>
      <LiveBoard data={JSON.parse(json)} srcline={srcline} standalone />
    </div>
  );
}
