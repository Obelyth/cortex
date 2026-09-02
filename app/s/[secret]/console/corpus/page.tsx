import { requireSecret } from "@/lib/gate";
import { edgesPulse } from "@/lib/edges";
import { assembleHeat } from "@/lib/heat";
import { byName } from "@/lib/frontmatter";
import { consoleHealth } from "../loaders";
import { type LedgerConnections, type LedgerRetracted } from "./ledger-client";
import { CorpusScreen } from "./corpus-screen";

export const dynamic = "force-dynamic";
export const maxDuration = 60;
export const metadata = { title: "Corpus · Cortex console" };

/**
 * Corpus — the heat view, the handoff staging panel, the directory strip and the ledger.
 *
 * This file is the server half only: gate, load, serialize. The composition lives in
 * CorpusScreen (client), because the heat tiles, the pin controls and the ledger expansions
 * share state — a tile click opens a ledger row, a pin reads the same on both surfaces.
 */
export default async function Corpus({
  params,
  searchParams,
}: {
  params: Promise<{ secret: string }>;
  searchParams: Promise<{ note?: string }>;
}) {
  await requireSecret(params);
  // ?note= arrives from a mark clicked in the overview's corpus field.
  const { note: initialFilter } = await searchParams;

  // The health snapshot, the connections graph and the heat view have no data dependency;
  // serial awaits would stack GitHub and Postgres round trips for nothing. (assembleHeat and
  // health share loadCorpus's per-instance cache, so the corpus is fetched once.)
  const [h, edges, heat] = await Promise.all([consoleHealth(), edgesPulse(), assembleHeat()]);

  // "off" collapses to null — the opt-in law: with no SUPABASE_URL there is no graph store, so
  // the panel does not render at all rather than rendering an apology. Every OTHER state
  // reaches the client, because each one names something true the operator can act on.
  const connections: LedgerConnections | null =
    edges.state === "off"
      ? null
      : edges.state === "built"
        ? { state: "built", head: edges.head.slice(0, 8), builtAt: edges.builtAt, byNote: edges.byNote }
        : { state: edges.state };

  // Grouped once here so the client gets a plain serializable map, capped per note — an
  // expansion is a glance, not the attention screen.
  const retractedByPath: Record<string, LedgerRetracted[]> = {};
  for (const r of h.retractedList) {
    (retractedByPath[r.path] ??= []).push({ line: r.line, heading: r.heading, text: r.text });
  }
  for (const k of Object.keys(retractedByPath)) {
    retractedByPath[k] = retractedByPath[k].slice(0, 6);
  }

  // The staging panel's selector: the projects that actually have pages, which is the only set
  // brain_handoff can resume.
  const projects = h.notes
    .filter((n) => /^projects\/.+\.md$/.test(n.path))
    .map((n) => n.path.slice("projects/".length, -".md".length))
    .sort(byName);

  return (
    <CorpusScreen
      heat={heat}
      projects={projects}
      sha={h.sha}
      byDir={h.byDir}
      initialFilter={initialFilter}
      connections={connections}
      retractedByPath={retractedByPath}
      rows={h.notes.map((n) => ({
        path: n.path,
        title: n.title,
        desc: n.desc,
        headings: n.headings,
        strip: n.strip,
        tokens: n.tokens,
        blocks: n.blocks,
        retracted: n.retracted,
      }))}
    />
  );
}
