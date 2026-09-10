import { health } from "./health";
import { appliedMigrations, pendingMigrations, shippedMigrations } from "./migrations";
import { mirrorPulse } from "./pulse";
import { readSettings, safeActiveReader } from "./settings";
import { providerConfigured, providerOf } from "./reader";
import { edgesBuildStatus } from "./edges";
import { answerCacheStatus } from "./anscache";

export type DiagnosticState = "passed" | "failed" | "skipped" | "unavailable";
export interface DiagnosticResult { state: DiagnosticState; detail: string }
export interface DiagnosticProbe {
  name: string;
  run(signal: AbortSignal): Promise<DiagnosticResult>;
}
export interface DiagnosticRun {
  checks: Array<DiagnosticResult & { name: string }>;
  summary: string;
  sourceSha: string | null;
}

const MAX_DETAIL = 500;
const observed = (now: () => Date) => now().toISOString();

/**
 * Runs independent, read-only probes under one wall-clock deadline. A probe cannot prevent the
 * others from returning, and no more than four enter user code at once. The signal lets current
 * helpers stop their own network work; the race also guarantees a bounded result if one ignores it.
 */
export async function runDiagnostics(
  probes: DiagnosticProbe[],
  options: { concurrency?: number; deadlineMs?: number; sourceSha?: string | null } = {},
): Promise<DiagnosticRun> {
  const concurrency = Math.max(1, Math.min(4, Math.trunc(options.concurrency ?? 4)));
  const deadlineMs = Math.max(1, Math.min(30_000, Math.trunc(options.deadlineMs ?? 30_000)));
  const controller = new AbortController();
  const checks: DiagnosticRun["checks"] = probes.map((probe) => ({ name: probe.name, state: "unavailable", detail: "diagnostic deadline reached" }));
  let next = 0;
  let expired = false;

  const workers = Array.from({ length: Math.min(concurrency, probes.length) }, async () => {
    while (!expired) {
      const index = next++;
      if (index >= probes.length) return;
      const probe = probes[index];
      try {
        const result = await probe.run(controller.signal);
        if (!expired) checks[index] = { name: probe.name, state: result.state, detail: result.detail.slice(0, MAX_DETAIL) };
      } catch {
        console.error(`[console diagnostics] ${probe.name} failed; dependency detail suppressed`);
        if (!expired) checks[index] = { name: probe.name, state: "failed", detail: "probe failed · see server log" };
      }
    }
  });

  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([
    Promise.all(workers),
    new Promise<void>((resolve) => {
      timer = setTimeout(() => {
        expired = true;
        controller.abort();
        resolve();
      }, deadlineMs);
    }),
  ]);
  clearTimeout(timer);
  const passed = checks.filter((check) => check.state === "passed").length;
  return { checks, summary: `${passed} passed · ${checks.length - passed} not passed`, sourceSha: options.sourceSha ?? null };
}

export interface DiagnosticCatalogueDependencies {
  health: typeof health;
  mirror: typeof mirrorPulse;
  shippedMigrations: typeof shippedMigrations;
  appliedMigrations: typeof appliedMigrations;
  settings: typeof readSettings;
  activeReader: typeof safeActiveReader;
  relationshipStatus: typeof edgesBuildStatus;
  cacheStatus: typeof answerCacheStatus;
}

/** The complete production catalogue. Shared promises keep coherent snapshots coherent and
 * every helper is read-only; the relationship/cache helper intentionally reads status only. */
export function defaultDiagnosticProbes(
  now: () => Date = () => new Date(),
  overrides: Partial<DiagnosticCatalogueDependencies> = {},
): DiagnosticProbe[] {
  const deps: DiagnosticCatalogueDependencies = {
    health,
    mirror: mirrorPulse,
    shippedMigrations,
    appliedMigrations,
    settings: readSettings,
    activeReader: safeActiveReader,
    relationshipStatus: edgesBuildStatus,
    cacheStatus: answerCacheStatus,
    ...overrides,
  };
  let corpus: ReturnType<typeof health> | null = null;
  let settings: ReturnType<typeof readSettings> | null = null;
  const readCorpus = () => corpus ??= deps.health(now());
  const readConsoleSettings = () => settings ??= deps.settings();
  return [
    {
      name: "dependency readiness",
      run: async () => {
        await readCorpus();
        const database = Boolean(process.env.SUPABASE_URL?.trim() && process.env.SUPABASE_SERVICE_ROLE_KEY?.trim());
        const github = Boolean(process.env.GITHUB_TOKEN?.trim());
        // The adapter reads CORTEX_VERCEL_TOKEN and CORTEX_VERCEL_PROJECT_ID (lib/console-job-providers.ts);
        // this used to check VERCEL_TOKEN, a name nothing else reads, so a correctly configured
        // deployment reported "Vercel configured · no".
        const vercel = Boolean(process.env.CORTEX_VERCEL_TOKEN?.trim()) && Boolean(process.env.CORTEX_VERCEL_PROJECT_ID?.trim());
        return { state: "passed", detail: `observed ${observed(now)} · corpus readable · database configured ${database ? "yes" : "no"} · GitHub configured ${github ? "yes" : "no"} · Vercel configured ${vercel ? "yes" : "no"} · presence does not prove usability` };
      },
    },
    {
      name: "corpus coherence",
      run: async () => {
        const h = await readCorpus();
        const runtime = process.env.VERCEL_GIT_COMMIT_SHA?.slice(0, 8) || "unavailable";
        return { state: "passed", detail: `observed ${observed(now)} · runtime SHA ${runtime} · corpus SHA ${h.sha.slice(0, 8)} · ${h.totals.notes} notes · ${h.totals.blocks} blocks · ${h.totals.tokens} estimated tokens` };
      },
    },
    {
      name: "mirror status",
      run: async () => {
        const pulse = await deps.mirror();
        if (!pulse) return { state: "unavailable", detail: `observed ${observed(now)} · mirror status unavailable` };
        if (pulse.state === "off") return { state: "skipped", detail: `observed ${observed(now)} · mirror not configured` };
        return { state: pulse.state === "live" ? "passed" : "failed", detail: `observed ${observed(now)} · mirror ${pulse.state} · ${pulse.notes ?? "unknown"} notes` };
      },
    },
    {
      name: "pending shipped migrations",
      run: async () => {
        const shipped = deps.shippedMigrations();
        if (!shipped) return { state: "unavailable", detail: `observed ${observed(now)} · shipped migration catalogue unavailable` };
        const applied = await deps.appliedMigrations();
        if (!applied) return { state: "skipped", detail: `observed ${observed(now)} · database store not configured` };
        const pending = pendingMigrations(shipped, applied);
        return pending.length
          ? { state: "failed", detail: `observed ${observed(now)} · ${pending.length} migration${pending.length === 1 ? "" : "s"} pending` }
          : { state: "passed", detail: `observed ${observed(now)} · shipped and applied ledgers match` };
      },
    },
    {
      name: "settings and KV",
      run: async () => {
        const state = await readConsoleSettings();
        if (state.source === "unconfigured") return { state: "skipped", detail: `observed ${observed(now)} · KV not configured · environment defaults remain active` };
        if (state.source === "unreachable") return { state: "unavailable", detail: `observed ${observed(now)} · KV configured but settings could not be read` };
        return { state: state.conflicts.length ? "failed" : "passed", detail: `observed ${observed(now)} · KV settings readable · ${state.conflicts.length} configuration conflict${state.conflicts.length === 1 ? "" : "s"}` };
      },
    },
    {
      name: "reader configuration",
      run: async () => {
        const state = await readConsoleSettings();
        const reader = await deps.activeReader(state);
        if (!reader.active) return { state: "failed", detail: `observed ${observed(now)} · active reader configuration is invalid` };
        const provider = providerOf(reader.active.model)!;
        const configured = providerConfigured(provider);
        return { state: configured ? "passed" : "unavailable", detail: `observed ${observed(now)} · active ${reader.active.model} via ${provider} (${reader.active.source}) · credential ${configured ? "configured; usability not tested" : "missing"}` };
      },
    },
    {
      name: "relationships and answer cache",
      run: async () => {
        const [relationships, cache] = await Promise.all([deps.relationshipStatus(), deps.cacheStatus()]);
        const state: DiagnosticState = relationships === "unavailable" || cache === "unavailable"
          ? "unavailable"
          : relationships === "current" && (cache === "empty" || cache === "populated") ? "passed" : "skipped";
        const cacheDetail=cache==="no-match-sampled"?"no matching entry observed in bounded sample":cache;
        return { state, detail: `observed ${observed(now)} · relationships ${relationships} · answer cache ${cacheDetail} · status reads only` };
      },
    },
  ];
}

export function runDefaultDiagnostics(): Promise<DiagnosticRun> {
  const candidate=process.env.VERCEL_GIT_COMMIT_SHA?.toLowerCase().slice(0,40)??"";
  const sourceSha = /^[0-9a-f]{7,40}$/.test(candidate)?candidate:null;
  return runDiagnostics(defaultDiagnosticProbes(), { sourceSha });
}
