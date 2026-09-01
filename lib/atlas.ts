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
 *
 * The live ring also carries the learning layer when its store answers: note_edges becomes
 * chords between notes (budgeted here — the renderer draws what it is given, the budget is a
 * data decision) and note_scores becomes brightness. Both are read-only joins against tables
 * other code owns; this module never derives an edge or scores a note, so the map can never
 * disagree with the ledger or the trends about what is connected or what is warm.
 */
import { loadCorpus } from "./corpus";
import { splitBlocks, retracted } from "./verify";
import { redact } from "./redact";
import { allEdges, type EdgeRow } from "./edges";
import { noteHeat } from "./pulse";

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
  /** note_scores temperature, memory nodes only — brightness on the ring. Absent = no claim. */
  temp?: "hot" | "warm" | "cold";
  /** note_scores read count, for the drawer's temperature row. Rides only with temp. */
  reads?: number;
}
interface Edge {
  source: string;
  target: string;
  kind?: string;
  why?: string;
  /** The stored weight, note-graph edges only — the renderer thickens strong ties slightly. */
  w?: number;
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
  /** Note-graph edges shipped to the renderer. Null when the store gave no answer — the caption
   *  must say the graph is absent, never that the brain has no structure. */
  graphEdges: number | null;
}

/** How many graph edges each note pins onto the map, strongest first. Three reads as structure;
 *  the full adjacency list reads as spaghetti, and the ledger already serves the full list. */
export const MAP_EDGES_PER_NOTE = 3;
/** A global ceiling on top of the per-note pin, so the map's edge pass stays bounded no matter
 *  how the corpus grows. Strongest-first, same ordering, so the cap trims the weakest ties. */
export const MAP_EDGE_CAP = 240;

/** Strongest claim first — the ledger's own ranking (lib/edges KIND_ORDER discipline): an
 *  explicit link outranks a correction chain outranks shared tags outranks co-reading outranks
 *  mere lexical similarity. Weights are only comparable within a kind. */
const KIND_PRIORITY: Record<EdgeRow["kind"], number> = {
  link: 0,
  correction: 1,
  tag: 2,
  coaccess: 3,
  lexical: 4,
};

/**
 * The map's edge budget: every note keeps its strongest few ties, and nothing more. Greedy over
 * the globally-sorted list (kind priority, then weight, then path — fully deterministic): an
 * edge survives while EITHER endpoint still has budget, so a note's best ties are never stolen
 * by a well-connected neighbour, then a global cap trims the weakest of what remains. Pure and
 * exported for tests — this is the seam that decides what "the graph on the board" means.
 */
export function budgetEdges(
  rows: EdgeRow[],
  notes: Set<string>,
  perNote = MAP_EDGES_PER_NOTE,
  cap = MAP_EDGE_CAP,
): EdgeRow[] {
  const eligible = rows.filter((r) => r.src !== r.dst && notes.has(r.src) && notes.has(r.dst));
  eligible.sort(
    (a, b) =>
      KIND_PRIORITY[a.kind] - KIND_PRIORITY[b.kind] ||
      b.weight - a.weight ||
      (a.src < b.src ? -1 : a.src > b.src ? 1 : 0) ||
      (a.dst < b.dst ? -1 : a.dst > b.dst ? 1 : 0),
  );
  const used = new Map<string, number>();
  const kept: EdgeRow[] = [];
  for (const r of eligible) {
    const s = used.get(r.src) ?? 0;
    const d = used.get(r.dst) ?? 0;
    if (s >= perNote && d >= perNote) continue;
    used.set(r.src, s + 1);
    used.set(r.dst, d + 1);
    kept.push(r);
    if (kept.length >= cap) break;
  }
  return kept;
}

/** Builds the page's data payload. Returns the JSON to inject, plus counts for the caption. */
export async function buildAtlas(): Promise<{ json: string; meta: Atlas }> {
  // The graph and the temperatures are optional stores riding beside the corpus; all three
  // reads are independent, and the two store reads resolve to null (never throw) when the
  // store is off, unmigrated or unwell — SUPABASE_URL unset renders exactly the old map.
  const [corpus, graphRows, heat] = await Promise.all([loadCorpus(), allEdges(), noteHeat()]);
  const heatByPath = new Map((heat ?? []).map((h) => [h.path, h]));

  const memory: Node[] = [];
  for (const [path, text] of corpus.files) {
    const cut = path.lastIndexOf("/");
    // Top segment, matching health.ts byDir — a nested note groups with its tree, not alone.
    const dir = path.includes("/") ? path.split("/")[0] : "root";
    const blocks = splitBlocks(text);
    let ret = 0;
    for (let i = 0; i < blocks.length; i++) if (retracted(blocks, i)) ret++;

    // Same rows the router and the trends read — the map may brighten and dim, never rescore.
    const h = heatByPath.get(path);
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
      ...(h ? { temp: h.temperature, reads: h.reads } : {}),
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

  // The note graph joins the same edge list, budgeted to the strongest few ties per note. The
  // endpoint filter is inherent — budgetEdges only keeps edges between live note paths, so a
  // stored edge naming a renamed note simply does not draw. Evidence rides as `why`, already
  // scrubbed by the read path, so the drawer can show WHY two notes are tied.
  const noteEdges = budgetEdges(graphRows ?? [], memoryIds);
  edges.push(
    ...noteEdges.map((r) => ({ source: r.src, target: r.dst, kind: r.kind, why: r.evidence, w: r.weight })),
  );

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
      // Null when the store gave no answer, a count (possibly 0) when it did — the caption must
      // distinguish "graph absent" from "no ties", which read the same and mean opposite things.
      graphEdges: graphRows === null ? null : noteEdges.length,
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
