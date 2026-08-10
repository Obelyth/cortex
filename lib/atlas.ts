/**
 * atlas — the operating map: what the brain is made of, and what reaches it.
 *
 * Two of the four rings describe things cortex cannot see. MCP servers, hooks and skills live on
 * The operator's machine; a server in Vercel has no view of them, so they ship as a dated snapshot and
 * the page says so rather than implying freshness it cannot back.
 *
 * The memory ring is the one cortex owns, so it is rebuilt from the live corpus on every request.
 * That split is the whole design: never render a stale thing next to a live thing without
 * labelling which is which.
 *
 * The snapshot is FETCHED, not imported. It is an inventory of a private machine — absolute
 * paths, connector IDs, which services hold credentials — and committing it here protected it
 * with a repo visibility flag while the page that renders it is gated by a secret. It now lives
 * in the brain repo, reached at request time by the same authenticated tarball that carries the
 * notes, so it is protected by the same token as the corpus and costs no extra round trip.
 *
 * Its absence is a non-event: the memory ring is the live half and renders on its own. The page
 * says the machine rings are missing rather than pretending the map is complete.
 */
import { loadCorpus } from "./corpus";
import { splitBlocks, retracted } from "./verify";
import { redact } from "./redact";

interface Node {
  id: string;
  label: string;
  group: string;
  layer: string;
  description?: string;
  detail?: string;
  status?: string;
  weight?: number;
  machine?: string;
  refs?: unknown;
}
interface Edge {
  source: string;
  target: string;
  kind?: string;
  why?: string;
}

/** The path the snapshot rides at, inside the brain repo. Must match corpus.ts's SIDECAR set. */
const SNAPSHOT_PATH = "tools/atlas-snapshot.json";

/**
 * The memory ring is defined here, not in the snapshot: it is the ring cortex computes, so
 * cortex owns its definition. The snapshot supplies only the three rings describing the machine.
 * That way a missing snapshot still leaves a coherent, correctly-labelled map.
 */
const MEMORY_LAYER = { key: "memory", label: "MEMORY", color: "#1fbdd6", ring: 3 };

interface Layer {
  key: string;
  label: string;
  color: string;
  ring: number;
}
interface Snapshot {
  capturedAt: string;
  layers: Layer[];
  center: string;
  nodes: Node[];
  edges: Edge[];
}

/**
 * Parses the sidecar, and refuses anything that is not the shape the renderer needs. A snapshot
 * that half-parses would draw a half-map with no indication anything was wrong, which is worse
 * than drawing the live ring alone and saying so.
 */
function parseSnapshot(raw: string | undefined): Snapshot | null {
  if (!raw) return null;
  try {
    const d = JSON.parse(raw) as Partial<Snapshot>;
    if (typeof d.capturedAt !== "string") return null;
    if (!Array.isArray(d.nodes) || !Array.isArray(d.edges) || !Array.isArray(d.layers)) return null;
    if (!d.nodes.every((n) => n && typeof n.id === "string" && typeof n.layer === "string")) return null;
    if (!d.layers.every((l) => l && typeof l.key === "string" && typeof l.ring === "number")) return null;
    return {
      capturedAt: d.capturedAt,
      layers: d.layers as Layer[],
      center: typeof d.center === "string" ? d.center : "",
      nodes: d.nodes as Node[],
      edges: d.edges as Edge[],
    };
  } catch {
    return null;
  }
}

/** Directory → the ring group a note joins. Anything unmapped groups under its own directory. */
const GROUP_LABEL: Record<string, string> = {
  log: "log",
  projects: "project",
  notes: "note",
  root: "note",
};

export interface Atlas {
  sha: string;
  /** null when the snapshot is absent or unreadable — the map then shows the live ring only. */
  capturedAt: string | null;
  live: number;
  snapshotted: number;
}

/** Builds the page's data payload. Returns the JSON to inject, plus counts for the caption. */
export async function buildAtlas(): Promise<{ json: string; meta: Atlas }> {
  const corpus = await loadCorpus();

  const memory: Node[] = [];
  for (const [path, text] of corpus.files) {
    const cut = path.lastIndexOf("/");
    // Top segment, matching health.ts byDir — a nested note groups with its tree, not alone.
    const dir = path.includes("/") ? path.split("/")[0] : "root";
    const blocks = splitBlocks(text);
    let ret = 0;
    for (let i = 0; i < blocks.length; i++) if (retracted(blocks, i)) ret++;

    memory.push({
      id: path,
      label: (cut >= 0 ? path.slice(cut + 1) : path).replace(/\.md$/i, ""),
      group: GROUP_LABEL[dir] ?? dir,
      layer: "memory",
      // Size follows length, so the ring reads as where the brain's mass actually sits.
      weight: Math.max(1, Math.round(text.length / 4000)),
      // The map is an egress like any other; a note whose first line quotes a credential
      // must not render it in a detail panel.
      description: redact(firstLine(text)),
      detail: `${Math.round(text.length / 4).toLocaleString()} tokens · ${blocks.length} blocks`,
      // A note carrying retracted passages is worth seeing on the map, not just in the console.
      status: ret > 0 ? "retracted" : undefined,
      machine: "all",
    });
  }

  const snapshot = parseSnapshot(corpus.sidecar?.get(SNAPSHOT_PATH));

  // The layer filter below keeps the snapshot from redefining memory; this keeps its NODES from
  // joining the ring the header labels LIVE, or shadowing a real note by reusing its path. The
  // machine rings are the snapshot's to describe — the memory ring is not.
  const memoryIds = new Set(memory.map((n) => n.id));
  const machineNodes = (snapshot?.nodes ?? []).filter(
    (n) => n.layer !== MEMORY_LAYER.key && !memoryIds.has(n.id),
  );

  const nodes: Node[] = [...machineNodes, ...memory];
  const ids = new Set(nodes.map((n) => n.id));
  // Snapshot edges point at note paths that may have been renamed or deleted since capture.
  // Dropping them keeps the renderer honest instead of drawing a line to nothing.
  const edges = (snapshot?.edges ?? []).filter((e) => ids.has(e.source) && ids.has(e.target));

  // The live ring's definition is cortex's own; the snapshot only ever adds the machine rings,
  // and never gets to redefine memory out from under the code that computes it.
  const layers = [...(snapshot?.layers ?? []).filter((l) => l.key !== MEMORY_LAYER.key), MEMORY_LAYER]
    .sort((a, b) => a.ring - b.ring);

  const counts: Record<string, number> = {};
  for (const n of nodes) counts[n.layer] = (counts[n.layer] ?? 0) + 1;

  const payload = {
    // Falls back to the live ring's own centre only if the snapshot's is absent, so the
    // renderer is never pointed at a node that is not in `nodes`.
    center: snapshot && ids.has(snapshot.center) ? snapshot.center : "",
    layers,
    nodes,
    edges,
    stats: { counts, sha: corpus.sha.slice(0, 12), capturedAt: snapshot?.capturedAt ?? null },
  };

  return {
    json: JSON.stringify(payload),
    meta: {
      sha: corpus.sha.slice(0, 12),
      capturedAt: snapshot?.capturedAt ?? null,
      live: memory.length,
      // The centre is neither live nor snapshotted, so it is subtracted only when present.
      snapshotted: machineNodes.length - (machineNodes.some((n) => n.id === snapshot?.center) ? 1 : 0),
    },
  };
}

/** A note's first real line of prose, for the detail panel. Headings and front matter are noise. */
function firstLine(text: string): string {
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#") || line.startsWith("---") || line.startsWith("_")) continue;
    return line.slice(0, 220);
  }
  return "";
}
