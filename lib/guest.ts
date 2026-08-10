import { kv, kvEnv } from "./kv";
import { DEFAULT_MODEL } from "./ask";
import { providerOf, type ReaderModel } from "./reader";
import type { SettingsState } from "./settings";

/**
 * What a guest may do, and how much of it.
 *
 * The shape of the whole thing is one sentence the operator wrote: shared context ON ASK, not openly
 * shared. A guest never receives the corpus. It asks a question, Claude reads the brain, and a
 * scoped answer comes back. The brain travels; it does not get handed over.
 *
 * EVERY DEFAULT HERE IS THE LOCKED-DOWN ONE. An unset key, an unreachable store, a value that no
 * longer parses — all of them land on projects-only, no citations, a low ceiling. The failure
 * direction for a policy object is not negotiable: a settings read that quietly returned "no
 * restrictions" would turn a store blip into full corpus access for whoever holds the guest URL.
 */

export interface GuestPolicy {
  /** Path prefixes a guest's answers may draw on. Never empty — empty would mean everything. */
  scope: string[];
  /** Whether a guest sees source path and verbatim evidence. Off: it learns proven/unproven only. */
  citations: boolean;
  /** Asks per UTC day across all guests. */
  dailyAsks: number;
  /** Ceiling on the k a guest may request. */
  maxK: number;
}

export const GUEST_DEFAULTS: GuestPolicy = {
  scope: ["projects/"],
  citations: false,
  dailyAsks: 50,
  maxK: 8,
};

export interface GuestState extends GuestPolicy {
  source: "store" | "unconfigured" | "unreachable";
  /** Asks already spent today, or null when the counter could not be read. */
  usedToday: number | null;
}

const READ_TIMEOUT_MS = 1500;
const key = () => `cortex:guest:${kvEnv()}`;
/** UTC, deliberately: a day boundary that moves with a timezone is a budget that can be gamed. */
const dayKey = (now: number) =>
  `cortex:guest:${kvEnv()}:asks:${new Date(now).toISOString().slice(0, 10)}`;

/** Only the paths brain.ts would ever accept, so a policy cannot name a directory that is not real. */
const SCOPE_RE = /^(profile\.md|INDEX\.md|(projects|notes|log|archive)\/[A-Za-z0-9._/-]*)$/;

export function isScopeEntry(v: unknown): v is string {
  return typeof v === "string" && v.length > 0 && !v.includes("..") && SCOPE_RE.test(v);
}

function parse(raw: unknown): GuestPolicy {
  let o: unknown = raw;
  if (typeof o === "string") {
    try {
      o = JSON.parse(o) as unknown;
    } catch {
      return { ...GUEST_DEFAULTS };
    }
  }
  if (o === null || typeof o !== "object") return { ...GUEST_DEFAULTS };
  const r = o as Record<string, unknown>;
  const scope = Array.isArray(r.scope) ? r.scope.filter(isScopeEntry) : [];
  const num = (v: unknown, fallback: number, max: number) =>
    typeof v === "number" && Number.isFinite(v) && v >= 0 ? Math.min(Math.floor(v), max) : fallback;
  return {
    // A stored scope that parsed to nothing falls back to the default, never to "everything".
    scope: scope.length ? scope : [...GUEST_DEFAULTS.scope],
    citations: r.citations === true,
    dailyAsks: num(r.dailyAsks, GUEST_DEFAULTS.dailyAsks, 1000),
    maxK: num(r.maxK, GUEST_DEFAULTS.maxK, 40),
  };
}

export async function readGuestPolicy(now = Date.now()): Promise<GuestState> {
  const r = kv();
  if (!r) return { ...GUEST_DEFAULTS, source: "unconfigured", usedToday: null };
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("kv read timeout")), READ_TIMEOUT_MS);
    });
    const [raw, used] = await Promise.race([
      Promise.all([r.get<unknown>(key()), r.get<number>(dayKey(now))]),
      timeout,
    ]);
    return {
      ...parse(raw),
      source: "store",
      usedToday: typeof used === "number" ? used : Number(used) || 0,
    };
  } catch {
    return { ...GUEST_DEFAULTS, source: "unreachable", usedToday: null };
  } finally {
    clearTimeout(timer);
  }
}

export async function writeGuestPolicy(next: GuestPolicy): Promise<void> {
  for (const s of next.scope) {
    if (!isScopeEntry(s)) throw new Error(`"${s}" is not a valid scope path`);
  }
  if (!next.scope.length) {
    // Refused rather than stored: an empty scope reads as "no restriction" everywhere it is
    // used, so the one policy that must never be expressible is the empty one.
    throw new Error("a guest scope cannot be empty — remove the guest secret to close the door");
  }
  const r = kv();
  if (!r) throw new Error("no KV store is configured, so guest policy has nowhere to live");
  await r.set(key(), JSON.stringify(next));
}

/**
 * Spend one ask against today's budget, or refuse. INCR first and compare after, so two
 * concurrent guests cannot both read "49 used" and both proceed.
 */
export async function spendGuestAsk(policy: GuestPolicy, now = Date.now()): Promise<void> {
  const r = kv();
  if (!r) {
    // No store means no counter, and an unmeterable budget is not a budget. The guest door
    // needs KV anyway (proposals live there), so this is a misconfiguration, not a mode.
    throw new Error("the guest door needs a KV store to meter usage");
  }
  const k = dayKey(now);
  const used = await r.incr(k);
  // Two days, so a counter written just before midnight still expires on its own.
  if (used === 1) await r.expire(k, 172_800);
  if (used > policy.dailyAsks) {
    throw new Error(
      `the guest daily limit of ${policy.dailyAsks} asks is spent — it resets at 00:00 UTC`
    );
  }
}

/**
 * Which model answers a guest. Always a Claude one.
 *
 * "Claude is orchestration always and gates other models" — made mechanical rather than left as
 * a habit. The operator can point his own default at any allowlisted reader; a guest's question is
 * still read by the model he trusts to hold the gate, and flipping his own default can never
 * quietly hand an untrusted caller's traffic to a different provider.
 */
export function guestReaderModel(settings: SettingsState): ReaderModel {
  const d = settings.defaultReader;
  return d && providerOf(d) === "anthropic" ? d : (DEFAULT_MODEL as ReaderModel);
}
