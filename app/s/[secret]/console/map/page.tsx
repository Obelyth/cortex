import { requireSecret } from "@/lib/gate";
import { buildAtlas } from "@/lib/atlas";
import { LiveBoard } from "../../map/live-board";
import styles from "../../map/board.module.css";

export const dynamic = "force-dynamic";
export const maxDuration = 60;
export const metadata = { title: "Map · Cortex console" };

/**
 * The Live Board under the console shell — same component as /s/<secret>/map.
 *
 * This is the one screen that is not paper, and that is deliberate rather than unfinished. The
 * five ruled sheets are documents you read; this is an instrument you look INTO. The renderer is
 * a vendored, hand-tuned canvas engine that PRODUCT.md names a fixed asset — ring bands, hex
 * packing, two force passes, 28 hand-authored Path2D glyphs — so re-lighting it to paper would
 * mean rewriting the one component nobody should be casually rewriting.
 *
 * What makes the dark read as a mode rather than an inconsistency is the frame. The board goes
 * edge to edge, breaking the body's own gutters, and the paper chrome above and below becomes an
 * aperture around it. A dark rectangle inset in a document looks like a mistake; a dark field
 * bled to the edges looks like a window, which is what it is.
 */
export default async function MapScreen({
  params,
}: {
  params: Promise<{ secret: string }>;
}) {
  await requireSecret(params);
  const { json, meta } = await buildAtlas();
  // "graph absent" and "graph 0 ties" read the same and mean opposite things — meta keeps them
  // apart (null vs 0), so the caption can too.
  const graph = meta.graphEdges === null ? "graph absent" : `graph ${meta.graphEdges} ties`;
  const srcline = `${meta.capturedAt ? `real data · rings ${meta.capturedAt}` : "real data · rings absent"} · ${graph}`;
  return (
    <div className="mapBleed">
      <div className={styles.embed}>
        <LiveBoard data={JSON.parse(json)} srcline={srcline} />
      </div>
    </div>
  );
}
