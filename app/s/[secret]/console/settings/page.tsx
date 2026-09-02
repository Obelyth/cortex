import { requireSecret } from "@/lib/gate";
import { readSettings, safeActiveReader, readerCards } from "@/lib/settings";
import { readGuestPolicy, guestReaderModel } from "@/lib/guest";
import { readLearning, resolveLearning, LEARNING_BOUNDS } from "@/lib/learning";
import { countAnswerCache } from "@/lib/anscache";
import { edgesSummary } from "@/lib/edges";
import { readCalls } from "@/lib/calls";
import { consoleProposals, consoleWatch } from "../loaders";
import { PROVIDERS, PROVIDER_KEY_ENV, providerConfigured } from "@/lib/reader";
import { SettingsClient, type SettingsVM } from "./settings-client";
import { LearningClient, type LearningVM } from "./learning-client";
import { ConnectSection } from "./connect-section";
import { Band } from "../band";
import styles from "../console.module.css";

export const dynamic = "force-dynamic";
export const maxDuration = 60;
export const metadata = { title: "Settings · Cortex console" };

/** The build stamp's age in words — computed server-side (this page is force-dynamic anyway)
 *  so the client carries a string, not a clock. Same buckets as the connections panel. */
function ago(iso: string): string {
  const s = Math.max(0, (Date.now() - Date.parse(iso)) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} d ago`;
}

/**
 * Settings — the v4 merge: Models, Connect and the controls, one screen.
 *
 * Three tabs became one on the owner's call: what a model has done (the table), how anything
 * connects (the doors and the wire-up), and everything you configure. The old /readers and
 * /guide segments redirect here.
 *
 * The knobs had scattered: reader default and provider switches on the readers screen, guest
 * policy in its rail, appearance in the ribbon, and half the deployment story visible nowhere.
 * This screen is their one home. The instrument screens stay instruments — they show what IS;
 * this screen holds what SHOULD BE.
 *
 * The Learning band holds the knobs on what the learning layer does — the answer cache, the
 * handoff budget, the graph and the watch checks (lib/learning.ts). Resolution order on every
 * knob: explicit call argument where a tool has one, then the selection here, then env, then
 * the code default — an empty store behaves byte-identically to the constants it replaced.
 *
 * Two laws, inherited and absolute:
 *   PRESENCE, NEVER VALUES. No secret is displayed, stored, or accepted here. Env rows render
 *   as set / not set; the two non-secret identity rows (repo, branch) may show their values
 *   because they are addresses, not credentials.
 *   THE STORE IS NOT THE AUTHORITY. Controls write to KV; when KV is absent or unreachable the
 *   screen says so and shows what the deployment falls back to, rather than pretending.
 */
export default async function Settings({
  params,
}: {
  params: Promise<{ secret: string }>;
}) {
  await requireSecret(params);

  // Independent reads, together: reader settings, guest policy, the proposal queue, and the
  // Learning section's five inputs (its selection, the cache count, the call log for hits, the
  // graph stamp, the live watch items — the last already resolved by the shell via cache()).
  const [settings, guest, queue, learningState, cacheEntries, calls, graph, watch] =
    await Promise.all([
      readSettings(),
      readGuestPolicy(),
      consoleProposals().catch(() => []),
      readLearning(),
      countAnswerCache(),
      readCalls().catch(() => null),
      edgesSummary(),
      consoleWatch(),
    ]);
  const { active, error: resolveError } = await safeActiveReader(settings);
  const cards = readerCards(settings, active);

  // The answering-model control stays here — it is the decision. The table that explained the
  // models moved to Ask; a select and a reference grid are not the same object.
  const modelOptions = cards
    .filter((c) => !c.disabled)
    .map((c) => ({ model: c.model, configured: c.configured }));

  const vm: SettingsVM = {
    writable: settings.source === "store",
    storeState: settings.source,
    conflicts: resolveError ? [resolveError, ...settings.conflicts] : settings.conflicts,
    providers: PROVIDERS.map((p) => ({
      provider: p,
      keyEnv: PROVIDER_KEY_ENV[p],
      configured: providerConfigured(p),
      disabled: settings.disabledProviders.includes(p),
      holdsDefault: p === cards.find((c) => c.isDefault)?.provider,
    })),
    guest: {
      open: Boolean(process.env.GUEST_PATH_SECRET?.trim()),
      kvReady: settings.source === "store",
      scope: guest.scope,
      citations: guest.citations,
      dailyAsks: guest.dailyAsks,
      maxK: guest.maxK,
      usedToday: guest.usedToday,
      queued: queue.length,
    },
  };

  // The Learning section's view. Resolution happens HERE, on the server, so the screen shows
  // what the read path will actually do — the client never re-derives a default.
  const eff = resolveLearning(learningState);
  const itemsOf = (kind: string) => watch.filter((i) => i.kind === kind).length;
  const learningVM: LearningVM = {
    writable: learningState.source === "store",
    storeState: learningState.source,
    conflicts: eff.conflicts,
    ansCache: { on: eff.ansCache, source: eff.sources.ansCache },
    ttl: {
      days: eff.ansCacheTtlDays,
      ...LEARNING_BOUNDS.ansCacheTtlDays,
      source: eff.sources.ansCacheTtlDays,
    },
    cacheEntries,
    // Cached rows in the last 24 h of the call log — the same `cached` flag the trends screen
    // reads, counted over whatever record readCalls() could honestly serve.
    cacheHits24h: calls
      ? calls.rows.filter((r) => r.tool === "brain_ask" && r.cached).length
      : null,
    handoff: { bytes: eff.handoffBudget, ...LEARNING_BOUNDS.handoffBudget, source: eff.sources.handoffBudget },
    watch: {
      supersededLink: { on: eff.watchSupersededLink, items: itemsOf("superseded-link") },
      coaccessGap: { on: eff.watchCoaccessGap, items: itemsOf("coaccess-gap") },
      correctionChain: { on: eff.watchCorrectionChain, items: itemsOf("correction-chain") },
    },
    floor: { value: eff.coaccessFloor, ...LEARNING_BOUNDS.coaccessFloor, source: eff.sources.coaccessFloor },
    graph:
      graph.state === "built"
        ? {
            state: "built",
            head: graph.head,
            rebuiltAgo: ago(graph.builtAt),
            total: graph.total,
            byKind: graph.byKind,
          }
        : { state: graph.state },
  };

  return (
    <div className="ovSheet">
      {/* Controls only. The model eval table moved to Ask, where it explains what just read the
          brain for a newcomer who is already watching it happen; the deployment readout moved to
          Overview, whose job is confirming the thing is alive. What is left is the two decisions
          an operator actually makes here. */}
      <Band
        n="01"
        label="Controls"
        tone="paper"
        title={<>What this deployment <b>should do.</b></>}
        lede="Two decisions live here: what answers, and what a guest may reach. Everything that describes what the deployment IS moved to Overview — a row you cannot act on does not belong on a screen of switches."
      >
        <SettingsClient vm={vm} modelOptions={modelOptions} activeModel={active ? active.model : ""} />
      </Band>

      <Band
        n="02"
        label="Learning"
        tone="grey"
        title={<>What the learning layer <b>may decide.</b></>}
        lede="The answer cache, the handoff budget, the connections graph and the watch checks — every knob is wired to the code path it names, and every default is today's behaviour. Retrieval is shown, not tunable: the eval gate is the only door."
      >
        <LearningClient vm={learningVM} />
      </Band>

      <Band
        n="03"
        label="Doors"
        tone="ink"
        grid
        title={<>Three ways in.<br /><b>Two questions decide which.</b></>}
        lede="Do you trust the client, and can it send a header? A closed door is dimmed rather than hidden — knowing a path exists but is shut is the answer to 'why can't I do this'."
      >
      <ConnectSection
        guestOpen={vm.guest.open}
        bearerSet={Boolean(process.env.MCP_TOKEN?.trim())}
        activeModel={active ? active.model : null}
        activeSource={active ? active.source : null}
        guestReader={guestReaderModel(settings)}
      />
      </Band>
    </div>
  );
}
