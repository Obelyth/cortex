/**
 * The public demo map's payload — entirely synthetic, entirely static.
 *
 * The real map is an inventory of a private machine, which is why it sits behind the connector
 * secret. This is the version with no names on it: the same four rings, the same renderer, the
 * same physics, populated by generated placeholders. It exists so the public landing can show
 * the system itself rather than a paragraph about it.
 *
 * Deterministic on purpose: no randomness, no corpus fetch, no environment. The route serves
 * one byte-identical document forever, so it can be cached publicly and can never leak anything
 * because it never touches anything.
 */

interface DemoNode {
  id: string;
  label: string;
  group: string;
  layer: string;
  description: string;
  detail: string;
  status?: string;
  weight: number;
  machine: string;
}

const LAYERS = [
  { key: "applications", label: "APPLICATIONS", color: "#aeb8c4", ring: 1 },
  { key: "routines", label: "ROUTINES", color: "#8b97a4", ring: 2 },
  { key: "memory", label: "MEMORY", color: "#1fbdd6", ring: 3 },
  { key: "skills", label: "SKILLS", color: "#677483", ring: 4 },
];

/** Weights cycle through a small set so node sizes vary without randomness. */
const W = [2, 5, 1, 3, 8, 2, 4, 1, 6, 3];

function series(
  n: number,
  prefix: string,
  group: string,
  layer: string,
  description: string,
): DemoNode[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `${prefix}-${String(i + 1).padStart(2, "0")}`,
    label: `${prefix} ${String(i + 1).padStart(2, "0")}`,
    group,
    layer,
    description,
    detail: "synthetic",
    weight: W[i % W.length],
    machine: "all",
  }));
}

export function demoPayload(): string {
  const nodes: DemoNode[] = [
    {
      id: "claude",
      label: "Claude",
      group: "core",
      layer: "core",
      description: "The reader at the centre. Every surface reaches the same memory through it.",
      detail: "synthetic",
      weight: 10,
      machine: "all",
    },
    ...series(6, "connector", "connectors", "applications",
      "A stand-in for an MCP server. On the real map, each of these has a name."),
    ...series(4, "plugin", "plugins", "applications",
      "A stand-in for an installed plugin."),
    ...series(4, "hook", "hooks", "routines",
      "A stand-in for a lifecycle hook that fires around every session."),
    ...series(4, "task", "scheduled", "routines",
      "A stand-in for a scheduled job. The real ones run nightly against the brain."),
    ...series(10, "skill", "user", "skills",
      "A stand-in for an installed skill."),
    ...series(8, "pack", "packs", "skills",
      "A stand-in for a skill shipped by a plugin."),
    ...series(12, "note", "note", "memory",
      "A stand-in for a note in the brain. On the real map these are live, one per file."),
    ...series(6, "project", "project", "memory",
      "A stand-in for a project page."),
    ...series(6, "log", "log", "memory",
      "A stand-in for a daily log entry."),
  ];

  // Two retracted notes, so the demo shows the amber ring the console's ticks share.
  for (const id of ["note-03", "note-09"]) {
    const n = nodes.find((x) => x.id === id);
    if (n) n.status = "retracted";
  }

  const edges = [
    { source: "hook-01", target: "note-01", kind: "writes-to", why: "synthetic edge" },
    { source: "hook-02", target: "log-02", kind: "writes-to", why: "synthetic edge" },
    { source: "task-01", target: "log-01", kind: "writes-to", why: "synthetic edge" },
    { source: "task-02", target: "project-01", kind: "writes-to", why: "synthetic edge" },
    { source: "connector-01", target: "note-02", kind: "documents", why: "synthetic edge" },
    { source: "connector-02", target: "project-02", kind: "documents", why: "synthetic edge" },
    { source: "skill-01", target: "connector-01", kind: "uses", why: "synthetic edge" },
    { source: "skill-02", target: "connector-03", kind: "uses", why: "synthetic edge" },
    { source: "skill-03", target: "note-04", kind: "documents", why: "synthetic edge" },
    { source: "pack-01", target: "connector-04", kind: "uses", why: "synthetic edge" },
    { source: "pack-02", target: "plugin-01", kind: "uses", why: "synthetic edge" },
    { source: "note-05", target: "project-03", kind: "documents", why: "synthetic edge" },
    { source: "note-06", target: "note-07", kind: "documents", why: "synthetic edge" },
    { source: "task-03", target: "note-08", kind: "writes-to", why: "synthetic edge" },
  ];

  const counts: Record<string, number> = {};
  for (const n of nodes) counts[n.layer] = (counts[n.layer] ?? 0) + 1;

  return JSON.stringify({
    center: "claude",
    layers: LAYERS,
    nodes,
    edges,
    stats: { counts, sha: "synthetic", capturedAt: "synthetic" },
  });
}
