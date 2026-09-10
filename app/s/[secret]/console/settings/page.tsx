import { cookies } from "next/headers";
import { requireSecret } from "@/lib/gate";
import { readSettings, safeActiveReader, readerCards } from "@/lib/settings";
import { readGuestPolicy, guestReaderModel } from "@/lib/guest";
import { readLearning, resolveLearning, LEARNING_BOUNDS } from "@/lib/learning";
import { countAnswerCache } from "@/lib/anscache";
import { edgesSummary } from "@/lib/edges";
import { modelRecordRows, readCalls } from "@/lib/calls";
import { DEFAULT_K, NARROW_BUDGET_BYTES } from "@/lib/ask";
import { consoleProposals, consoleWatch } from "../loaders";
import { PROVIDERS, PROVIDER_KEY_ENV, modelsOf, providerConfigured, providerOf } from "@/lib/reader";
import { GROUND_COOKIE, groundFrom } from "../ground";
import type { SettingsVM } from "./settings-client";
import type { LearningVM } from "./learning-client";
import type { ReaderRow } from "./readers-panel";
import { SettingsScreen, type DoorRow } from "./settings-screen";
import { featureReadiness, type FeatureName } from "./readiness";
import { configurationOperationalEvidence, configurationPresence, configurationIngressAvailable, configurationProviderStatus } from "@/lib/console-configuration";
import { ConfigurationStoreError, consoleConfigurationStore, environmentTarget } from "@/lib/console-configuration-store";
import type { ConfigurationView } from "./configuration-panel";
import { getOperationsReadiness } from "@/lib/console-operations-readiness";
import "./settings.css";

export const dynamic = "force-dynamic";
export const maxDuration = 60;
export const metadata = { title: "Settings · Cortex console" };

async function loadConfigurationView(): Promise<Omit<ConfigurationView, "presence" | "evidence">> {
  const adapter = configurationProviderStatus(process.env);
  const ingressReady = configurationIngressAvailable(process.env);
  const store = consoleConfigurationStore();
  if (!store) return { adapter, ingressReady, records: [], store: "unconfigured" };
  if (!adapter.projectId) return { adapter, ingressReady, records: [], store: "unavailable" };
  try {
    const records = (await Promise.all((["production", "preview"] as const).map((target) => store.list({
      target: environmentTarget(adapter.projectId!, adapter.teamId, target),
    })))).flat();
    return { adapter, ingressReady, records, store: "ready" };
  } catch (error) {
    return { adapter, ingressReady, records: [], store: error instanceof ConfigurationStoreError && error.code === "schema_required" ? "schema-required" : "unavailable" };
  }
}

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
 * Settings — what this deployment SHOULD do. The instrument screens show what IS; this screen
 * holds the decisions: the ground (this device), the reader, the guest door, the learning knobs,
 * and the doors as presence. v2 restates them as instrument panels (settings-screen.tsx); the
 * loads and the view models live here, the writes ride settings/save, settings/actions and
 * settings/ground exactly as before.
 *
 * Two laws, inherited and absolute:
 *   WRITE-ONLY CAPABILITY VALUES. Approved complete groups can be entered, but no secret is
 *   displayed, persisted in Cortex, or read back. Env rows remain presence-only; the two
 *   non-secret identity rows (repo, branch) may show their values because they are addresses.
 *   THE STORE IS NOT THE AUTHORITY. Controls write to KV; when KV is not configured or
 *   unreachable the screen says so and shows what the deployment falls back to, rather than
 *   pretending.
 */
export default async function Settings({
  params,
}: {
  params: Promise<{ secret: string }>;
}) {
  await requireSecret(params);
  const operations = getOperationsReadiness(process.env);
  const now = Date.now();
  const bearerReadiness = featureReadiness("MCP_TOKEN", process.env);
  const guestDoorReadiness = featureReadiness("GUEST_PATH_SECRET", process.env);

  // Independent reads, together: reader settings, guest policy, the proposal queue, and the
  // Learning group's inputs (its selection, the cache count, the call log for hits and the
  // readers' record, the graph stamp, the live watch items — the last already resolved by the
  // shell via cache()).
  const [settings, guest, queue, learningState, cacheEntries, calls, graph, watch, jar, configuration] =
    await Promise.all([
      readSettings(),
      readGuestPolicy(),
      consoleProposals().catch(() => []),
      readLearning(),
      countAnswerCache(),
      readCalls(86_400_000, now).catch(() => null),
      edgesSummary(),
      consoleWatch(),
      cookies(),
      loadConfigurationView(),
    ]);
  const { active, error: resolveError } = await safeActiveReader(settings);
  const cards = readerCards(settings, active);
  const presence = configurationPresence(process.env);
  const configurationView: ConfigurationView = {
    ...configuration,
    presence,
    evidence: configurationOperationalEvidence({
      presence,
      activeProvider: active ? providerOf(active.model) : null,
      readerResolutionFailed: resolveError !== null,
      mirrorState: graph.state,
      cacheEntries,
    }),
  };

  const modelOptions = cards
    .filter((c) => !c.disabled)
    .map((c) => ({ model: c.model, configured: c.configured }));

  const vm: SettingsVM = {
    writable: settings.source === "store",
    storeState: settings.source,
    conflicts: settings.conflicts,
    providers: PROVIDERS.map((p) => ({
      provider: p,
      keyEnv: PROVIDER_KEY_ENV[p],
      configured: providerConfigured(p),
      disabled: settings.disabledProviders.includes(p),
      holdsDefault: p === cards.find((c) => c.isDefault)?.provider,
      models: modelsOf(p).length,
    })),
    guest: {
      // The configured path/bearer and the policy store are separate facts. The door is only
      // operational when both are ready; a reader-family outage must not hold a loaded policy.
      open: guestDoorReadiness.ready && guest.source === "store",
      missing: guestDoorReadiness.missing,
      storeState: guest.source,
      scope: guest.scope,
      revision: guest.revision,
      citations: guest.citations,
      dailyAsks: guest.dailyAsks,
      maxK: guest.maxK,
      usedToday: guest.usedToday,
      queued: queue.length,
    },
  };

  // The Learning group's view. Resolution happens HERE, on the server, so the screen shows
  // what the read path will actually do — the client never re-derives a default.
  const eff = resolveLearning(learningState);
  const itemsOf = (kind: string) => watch.filter((i) => i.kind === kind).length;
  const learning: LearningVM = {
    writable: learningState.source === "store",
    storeState: learningState.source,
    ansCache: { on: eff.ansCache, source: eff.sources.ansCache },
    ttl: { days: eff.ansCacheTtlDays, ...LEARNING_BOUNDS.ansCacheTtlDays, source: eff.sources.ansCacheTtlDays },
    cacheEntries,
    // Cached rows in the last 24 h of the call log — the same `cached` flag the trends screen
    // reads, counted over whatever record readCalls() could honestly serve.
    cacheHits24h: calls ? calls.rows.filter((r) => r.tool === "brain_ask" && r.cached).length : null,
    handoff: { bytes: eff.handoffBudget, ...LEARNING_BOUNDS.handoffBudget, source: eff.sources.handoffBudget },
    watch: {
      supersededLink: { on: eff.watchSupersededLink, items: itemsOf("superseded-link") },
      coaccessGap: { on: eff.watchCoaccessGap, items: itemsOf("coaccess-gap") },
      correctionChain: { on: eff.watchCorrectionChain, items: itemsOf("correction-chain") },
      oversizedPage: { on: eff.watchOversizedPage, items: itemsOf("oversized-page") },
    },
    floor: { value: eff.coaccessFloor, ...LEARNING_BOUNDS.coaccessFloor, source: eff.sources.coaccessFloor },
    graph:
      graph.state === "built"
        ? { state: "built", head: graph.head, rebuiltAgo: ago(graph.builtAt), total: graph.total, byKind: graph.byKind }
        : { state: graph.state },
    retrieval: { k: DEFAULT_K, budgetBytes: NARROW_BUDGET_BYTES },
  };

  // Readers · the record, over the same 24 h window. The record counts only calls the model
  // actually answered: modelRecordRows drops cached replays, so a question asked five times at
  // one commit is one entry, not five. Their count is reported in the note.
  const asks = calls ? calls.rows.filter((r) => r.tool === "brain_ask") : [];
  const attributed = modelRecordRows(asks);
  const cachedAsks = asks.filter((r) => r.cached).length;
  const unattributed = asks.length - asks.filter((r) => r.model).length;
  const readers: ReaderRow[] = cards.map((c) => {
    const mine = attributed.filter((r) => r.model === c.model);
    const ms = mine.map((r) => r.ms).sort((a, b) => a - b);
    return {
      model: c.model,
      provider: c.provider,
      keyEnv: PROVIDER_KEY_ENV[c.provider],
      configured: c.configured,
      disabled: c.disabled,
      evalState: c.eval.state,
      evalNote: c.eval.note,
      isDefault: c.isDefault,
      defaultSource: c.defaultSource ?? null,
      calls: mine.length,
      verified: mine.filter((r) => r.stamp === "VERIFIED").length,
      unverified: mine.filter((r) => r.stamp === "UNVERIFIED").length,
      errors: mine.filter((r) => r.stamp === "ERROR").length,
      p50: ms.length ? ms[Math.floor((ms.length - 1) / 2)] : null,
      asks: [...mine]
        .sort((a, b) => b.ts - a.ts)
        .slice(0, 10)
        .map((r) => ({ ts: r.ts, ms: r.ms, stamp: r.stamp, surface: r.surface })),
    };
  });
  const readersNote = !calls
    ? "call log unreadable this render"
    : calls.durable
      ? asks.length === 0
        ? "24 h · no asks in the window yet"
        : `24 h · ${attributed.length} of ${asks.length} asks in the record${cachedAsks > 0 ? ` · ${cachedAsks} from cache, not counted` : ""}${unattributed > 0 ? ` · ${unattributed} pre-date per-model logging` : ""}${calls.covers < 86_400_000 ? " · partial log" : ""}`
      : calls.source === "unconfigured"
        ? "no durable call store — this is one instance's view"
        : "call store unreachable — in-memory view";

  // Doors & deployment: presence only. Every secret-shaped read here is Boolean(...?.trim()) —
  // the value never leaves its line. The two addresses are the only rows that show a value,
  // and they are read into names first: no env value is ever interpolated into a string.
  const repo = process.env.BRAIN_REPO?.trim() || "not set";
  const branch = process.env.BRAIN_BRANCH?.trim() || "main";
  const door = (label: FeatureName, sub: string): DoorRow => {
    const readiness = featureReadiness(label, process.env);
    return {
      label,
      sub: `${sub}${readiness.missing.length ? ` · missing ${readiness.missing.join(" + ")}` : ""}`,
      set: readiness.ready,
    };
  };
  const doors: DoorRow[] = [
    door("MCP_TOKEN", "terminal door · /api/mcp + bearer"),
    door("CONNECTOR_PATH_SECRET", "connector door · /api/s/<secret>/mcp · this console"),
    door("GUEST_PATH_SECRET", "guest door · /api/g/<secret>/mcp · must differ from the connector secret"),
    door("CONSOLE_PASSCODE", "stamps a device · rotating it re-prompts every device"),
    door("SUPABASE_URL", "mirror · access log · note_scores · ops ledger"),
    door("KV_REST_API_URL", "settings · guest budget · proposals · notices read mark"),
    door("RESEND_API_KEY", "ops alert mail · unset means board-only"),
    door("SENTRY_DSN", "error reporting"),
    {
      label: "BRAIN_REPO · BRAIN_BRANCH",
      sub: "addresses, not credentials — the only env rows that show a value",
      set: null,
      value: `${repo} · ${branch}`,
    },
  ];

  const conflicts = [...(resolveError ? [resolveError] : []), ...settings.conflicts, ...eff.conflicts];

  return (
    <SettingsScreen
      ground={groundFrom(jar.get(GROUND_COOKIE)?.value)}
      vm={vm}
      modelOptions={modelOptions}
      activeModel={active ? active.model : ""}
      learning={learning}
      readers={readers}
      readersNote={readersNote}
      doors={doors}
      configuration={configurationView}
      operations={operations}
      connect={{
        guestOpen: vm.guest.open,
        guestMissing: guestDoorReadiness.missing,
        guestStoreState: guest.source,
        bearerSet: bearerReadiness.ready,
        activeModel: active ? active.model : null,
        activeSource: active ? active.source : null,
        guestReader: guestReaderModel(settings),
      }}
      conflicts={conflicts}
    />
  );
}
