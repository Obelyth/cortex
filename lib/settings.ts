import { kv, kvEnv } from "./kv";
import {
  EVAL,
  PROVIDERS,
  READER_MODEL_IDS,
  providerConfigured,
  providerOf,
  resolveModel,
  type Provider,
  type ReaderModel,
} from "./reader";
import { DEFAULT_MODEL } from "./ask";

/**
 * Console settings — the first mutable state this server has ever had.
 *
 * Everything else here is derived: the corpus is git, the verdicts are computed, the call log
 * is an observation. These two values are chosen, by a person, and they change what the server
 * does. That makes them worth an unusual amount of care:
 *
 * 1. SETTINGS CAN NEVER BRICK THE READ PATH. A provider switch turns off *selection* — it stops
 *    a caller asking for that model and stops it being the console default. It is deliberately
 *    NOT applied to the last resort of the fallback chain, so no combination of toggles can
 *    leave brain_ask with nothing to call. A switch that can lock you out of your own brain
 *    from a phone is not a safety control, it is the outage.
 * 2. THE STORE IS NOT THE AUTHORITY, THE KEYS ARE. If KV is unreachable the settings degrade to
 *    env-and-code defaults with every provider selectable, and the console says so in those
 *    words. Failing closed here would mean a KV blip silently changes which model reads the
 *    brain; failing open means a toggle is a convenience, and the real control over egress is
 *    the API key that is either present or absent.
 * 3. A STORED VALUE THAT NO LONGER PARSES IS REPORTED, NOT SWALLOWED. A model retired from the
 *    allowlist leaves a stale default behind; the console shows the conflict and which value it
 *    fell back to, rather than quietly reading with a different model than the screen claims.
 */

export interface ConsoleSettings {
  /** The console's pick, or null to leave the choice to READER_MODEL / the built-in default. */
  defaultReader: ReaderModel | null;
  /** Providers whose models cannot be selected. Their keys, if set, stay set. */
  disabledProviders: Provider[];
}

export interface SettingsState extends ConsoleSettings {
  /** Where this came from — "store", or which kind of fallback this is. */
  source: "store" | "unconfigured" | "unreachable";
  /** Stored values that could not be honoured, in words the screen can print verbatim. */
  conflicts: string[];
}

const EMPTY: ConsoleSettings = { defaultReader: null, disabledProviders: [] };

/** A settings read must never hang a console render or a tool call. */
const READ_TIMEOUT_MS = 1500;

const key = () => `cortex:settings:${kvEnv()}`;

function isProvider(v: unknown): v is Provider {
  return typeof v === "string" && (PROVIDERS as readonly string[]).includes(v);
}

function isReaderModel(v: unknown): v is ReaderModel {
  return typeof v === "string" && providerOf(v) !== null;
}

/**
 * Parse whatever the store holds into settings plus a list of what had to be ignored. Never
 * throws: a hand-edited key or a value written by an older deploy degrades to the parts that
 * still make sense, and the parts that do not become visible conflicts.
 */
function parse(raw: unknown): { settings: ConsoleSettings; conflicts: string[] } {
  const conflicts: string[] = [];
  let o: unknown = raw;
  if (typeof o === "string") {
    try {
      o = JSON.parse(o) as unknown;
    } catch {
      return { settings: EMPTY, conflicts: ["stored settings are not valid JSON — ignored"] };
    }
  }
  if (o === null || typeof o !== "object") return { settings: EMPTY, conflicts };
  const r = o as Record<string, unknown>;

  let defaultReader: ReaderModel | null = null;
  if (r.defaultReader != null && r.defaultReader !== "") {
    if (isReaderModel(r.defaultReader)) {
      defaultReader = r.defaultReader;
    } else {
      conflicts.push(
        `the stored default reader is not on the allowlist — ignored, falling back to ${
          process.env.READER_MODEL?.trim() ? "READER_MODEL" : DEFAULT_MODEL
        }`
      );
    }
  }

  const disabledProviders: Provider[] = [];
  if (Array.isArray(r.disabledProviders)) {
    for (const p of r.disabledProviders) {
      if (isProvider(p)) {
        if (!disabledProviders.includes(p)) disabledProviders.push(p);
      } else {
        conflicts.push(`stored setting names an unknown provider — ignored`);
      }
    }
  }
  return { settings: { defaultReader, disabledProviders }, conflicts };
}

export async function readSettings(): Promise<SettingsState> {
  const r = kv();
  if (!r) return { ...EMPTY, source: "unconfigured", conflicts: [] };
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("kv read timeout")), READ_TIMEOUT_MS);
    });
    const raw = await Promise.race([r.get<unknown>(key()), timeout]);
    const { settings, conflicts } = parse(raw);
    return { ...settings, source: "store", conflicts };
  } catch {
    return { ...EMPTY, source: "unreachable", conflicts: [] };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Persist a whole settings object. Rejects rather than repairs: this is a deliberate change by
 * a person at a screen, and the one thing worse than a refused setting is a silently adjusted
 * one that the screen then reports back as if it were what they asked for.
 */
export async function writeSettings(next: ConsoleSettings): Promise<SettingsState> {
  if (next.defaultReader !== null && !isReaderModel(next.defaultReader)) {
    throw new Error(`"${next.defaultReader}" is not an allowed reader model`);
  }
  for (const p of next.disabledProviders) {
    if (!isProvider(p)) throw new Error(`"${p}" is not a known provider`);
  }
  // The one combination that would be a lie the moment it is stored: a default whose provider
  // this same write turns off. Refused here rather than resolved at read time, so the screen
  // never shows a default the read path is not using.
  if (next.defaultReader && next.disabledProviders.includes(providerOf(next.defaultReader)!)) {
    throw new Error(
      `${next.defaultReader} cannot be the default while ${providerOf(next.defaultReader)} is off — change the default first`
    );
  }
  const r = kv();
  if (!r) {
    throw new Error(
      "no KV store is configured, so a console setting has nowhere durable to live — set READER_MODEL in the environment instead"
    );
  }
  await r.set(key(), JSON.stringify(next));
  return { ...next, source: "store", conflicts: [] };
}

/** Where the model that will actually read came from. */
export type ReaderSource = "call" | "console" | "env" | "built-in";

export interface ActiveReader {
  model: ReaderModel;
  source: ReaderSource;
}

/**
 * The model that will read, given what the caller asked for and what the console holds.
 *
 * Order: the caller's explicit pick, the console default, READER_MODEL, the built-in default.
 * Only the first two are subject to the provider switches — see rule 1 above. A disabled
 * console default is not an error, it just stops applying, because the alternative is that
 * flipping one switch makes every call throw until someone opens the console again.
 */
export async function activeReader(
  requested?: string,
  state?: SettingsState
): Promise<ActiveReader> {
  const s = state ?? (await readSettings());

  if (requested !== undefined) {
    const model = resolveModel(requested); // throws on anything off the allowlist
    const p = providerOf(model)!;
    if (s.disabledProviders.includes(p)) {
      throw new Error(
        `reader model ${model} is not available — ${p} is switched off in the console`
      );
    }
    return { model, source: "call" };
  }

  if (s.defaultReader && !s.disabledProviders.includes(providerOf(s.defaultReader)!)) {
    return { model: s.defaultReader, source: "console" };
  }

  // resolveModel() with no argument applies READER_MODEL and throws loudly on a typo there —
  // the pre-existing behaviour, deliberately unchanged. A bad env var is a deployment error
  // and should stay one; it is not something a console toggle should paper over.
  const model = resolveModel();
  return { model, source: process.env.READER_MODEL?.trim() ? "env" : "built-in" };
}

/**
 * activeReader() for a screen rather than a tool call.
 *
 * A typo'd READER_MODEL throws, and that is right on the read path — a deployment error should
 * be loud. But the console is where you go to FIND OUT which reader is broken, and a screen
 * that 500s because the reader is misconfigured is a screen that fails exactly when it is
 * needed. So here the throw becomes a rendered sentence and the rest of the page still draws.
 */
export async function safeActiveReader(
  state: SettingsState
): Promise<{ active: ActiveReader | null; error: string | null }> {
  try {
    return { active: await activeReader(undefined, state), error: null };
  } catch (e) {
    return { active: null, error: e instanceof Error ? e.message : String(e) };
  }
}

/** One row per model for the console: who serves it, is it keyed, is it measured, is it on. */
export interface ReaderCard {
  model: ReaderModel;
  provider: Provider;
  configured: boolean;
  disabled: boolean;
  eval: (typeof EVAL)[ReaderModel];
  isDefault: boolean;
  /** Only set on the default row — where that default came from. */
  defaultSource?: ReaderSource;
}

/** `active` is null when resolution failed — then no row claims to be the one reading. */
export function readerCards(s: SettingsState, active: ActiveReader | null): ReaderCard[] {
  return READER_MODEL_IDS.map((model) => {
    const provider = providerOf(model)!;
    const isDefault = model === active?.model;
    return {
      model,
      provider,
      configured: providerConfigured(provider),
      disabled: s.disabledProviders.includes(provider),
      eval: EVAL[model],
      isDefault,
      ...(isDefault ? { defaultSource: active!.source } : {}),
    };
  });
}
