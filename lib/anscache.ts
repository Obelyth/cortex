import { createHash } from "node:crypto";
import { after } from "next/server";
import { kv, kvEnv } from "./kv";

/**
 * anscache — the answer cache. A repeat question at an unchanged corpus head costs zero model
 * calls.
 *
 * The key is what makes it honest: it carries the corpus head SHA, so the entry describes an
 * immutable object — the corpus at that commit — and can never go stale. Any brain write moves
 * the head, which changes every key; there is no invalidation code because there is nothing to
 * invalidate. The TTL below only bounds storage.
 *
 * The key also carries the FULL answer policy — door, scope, citations, model, k — because a
 * cached reply is the *rendered* reply. A guest's citation-stripped answer must never serve a
 * trusted caller (it would silently lose the evidence), and a trusted answer must never serve
 * a guest (it would hand over the paths the guest door exists to withhold).
 *
 * THE STORE IS NOT THE AUTHORITY. Same rule as settings: an unreachable KV, a slow KV, or an
 * entry that no longer parses is a MISS, never an error — the fresh path answers and its write
 * overwrites whatever was there. A cache that can refuse an answer is an outage, not a cache.
 */

export interface AnswerPolicy {
  /** Which trust class rendered the reply — the policy classes, not the transport doors:
   *  terminal and connector share one policy and may share answers. */
  door: "trusted" | "guest";
  /** Path prefixes the answer was allowed to draw on. [] = the whole corpus. */
  scope: readonly string[];
  /** Whether the reply carries source paths and verbatim evidence. */
  citations: boolean;
}

export interface AskShape {
  question: string;
  /** Corpus head commit — the full SHA, so the key names an immutable object. */
  sha: string;
  /** The RESOLVED reader model, after console/env defaults applied. */
  model: string;
  /** Effective pack size, or "full" for a whole-corpus read — both change the answer. */
  k: number | "full";
}

/** Everything a hit needs to serve without recomputing anything. */
export interface CachedAnswer {
  /** The rendered reply, byte-for-byte what the fresh path returned (before the cache marker). */
  reply: string;
  /** The verdict word the reply opens with, as stampOf() read it at answer time. */
  stamp: string;
  model: string;
  /** commit as AskResult carries it (12 hex chars). */
  commit: string;
  /** Scoped-corpus token estimate at answer time — a hit hauled nothing, so this is `saved`. */
  corpusTokens: number;
  /** Epoch ms when the answer was computed. */
  ts: number;
}

/** Immutability does the invalidation (the SHA is in the key); the TTL only bounds storage.
 *  Exported in DAYS because that is the unit the console's Learning knob steps in — one
 *  definition, so the knob's default and this default cannot drift apart. */
export const ANSCACHE_TTL_DAYS = 7;
const TTL_SECONDS = ANSCACHE_TTL_DAYS * 86_400;
/** A cache read must never make an ask slower than the model call it hopes to skip. */
const READ_TIMEOUT_MS = 1500;

/** Every entry lives under this prefix — what cacheKey() writes into and what the console's
 *  count and clear walk. One definition, or a renamed key space strands entries forever. */
const prefix = () => `cortex:anscache:${kvEnv()}:`;

/**
 * Whitespace and case folded before hashing, so "Is beacon live?" and "is beacon  live?" are
 * the same question to the cache. Deliberately nothing smarter: paraphrase detection would put
 * a similarity judgement in front of a system whose product is exact provenance.
 */
export function normaliseQuestion(q: string): string {
  return q.normalize("NFC").replace(/\s+/g, " ").trim().toLowerCase();
}

export function cacheKey(shape: AskShape, policy: AnswerPolicy): string {
  // JSON over a fixed field order, then hashed — the scope is sorted because applyScope treats
  // it as a set, and two orderings of the same entries must not be two cache entries.
  const fingerprint = JSON.stringify({
    q: normaliseQuestion(shape.question),
    sha: shape.sha,
    model: shape.model,
    k: shape.k,
    door: policy.door,
    scope: [...policy.scope].sort(),
    citations: policy.citations,
  });
  const hash = createHash("sha256").update(fingerprint).digest("hex");
  return `${prefix()}${hash}`;
}

/** Strict on the fields a hit would serve; a shape this cannot vouch for is a miss. */
function parseEntry(raw: unknown): CachedAnswer | null {
  let o: unknown = raw;
  if (typeof o === "string") {
    try {
      o = JSON.parse(o) as unknown;
    } catch {
      return null;
    }
  }
  if (o === null || typeof o !== "object" || Array.isArray(o)) return null;
  const r = o as Record<string, unknown>;
  if (typeof r.reply !== "string" || !r.reply.trim()) return null;
  if (typeof r.stamp !== "string" || typeof r.model !== "string") return null;
  if (typeof r.commit !== "string" || !/^[0-9a-f]{8,40}$/i.test(r.commit)) return null;
  return {
    reply: r.reply,
    stamp: r.stamp,
    model: r.model,
    commit: r.commit,
    corpusTokens: typeof r.corpusTokens === "number" && r.corpusTokens >= 0 ? r.corpusTokens : 0,
    ts: typeof r.ts === "number" ? r.ts : 0,
  };
}

/** A hit, or null for every other outcome — no store, slow store, missing key, malformed
 *  entry. All four are the same thing to the caller: answer fresh. */
export async function readAnswerCache(key: string): Promise<CachedAnswer | null> {
  const r = kv();
  if (!r) return null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("kv read timeout")), READ_TIMEOUT_MS);
    });
    const raw = await Promise.race([r.get<unknown>(key), timeout]);
    return raw == null ? null : parseEntry(raw);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Fire-and-forget, same discipline as the call log: the answer this entry describes has
 * already been returned, and no cache write may retroactively break it. SET overwrites, which
 * is also the malformed-entry recovery — a corrupt value is read as a miss and replaced here.
 * `ttlSeconds` is the caller's resolved TTL (the console's Learning knob, usually); the default
 * keeps every existing caller on today's seven days.
 */
export function writeAnswerCache(key: string, entry: CachedAnswer, ttlSeconds = TTL_SECONDS): void {
  const r = kv();
  if (!r) return;
  const write = r.set(key, JSON.stringify(entry), { ex: ttlSeconds }).catch(() => {
    /* the cache is an optimisation, never the product */
  });
  // Registered with the request lifecycle so a suspending instance flushes it; outside a
  // request scope (tests, scripts) fire-and-forget is the deal — see calls.ts record().
  try {
    after(write);
  } catch {
    /* no request scope — the write races the process, and a lost entry is accepted */
  }
}

/** Every live cache key in this environment, by SCAN. Shared by the count and the clear so the
 *  number the screen shows and the set the button deletes cannot be two different opinions. */
async function scanKeys(): Promise<string[]> {
  const r = kv();
  if (!r) throw new Error("no KV store is configured — there is no answer cache");
  const keys: string[] = [];
  let cursor: string | number = 0;
  do {
    // Annotated because the SDK's cursor type feeds back into its own inference here — and
    // because older/newer client versions disagree on string vs number, which String() settles.
    const [next, page]: [string | number, string[]] = await r.scan(cursor, {
      match: `${prefix()}*`,
      count: 200,
    });
    keys.push(...page);
    cursor = next;
  } while (String(cursor) !== "0");
  return keys;
}

/**
 * How many entries are stored right now, or null when the store cannot answer — a readout on
 * the settings screen, so it obeys the render budget and degrades to "—" rather than erroring.
 */
export async function countAnswerCache(): Promise<number | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("kv scan timeout")), READ_TIMEOUT_MS);
    });
    return (await Promise.race([scanKeys(), timeout])).length;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Delete every entry in this environment and report how many. Throws on a store that cannot
 * answer — this is a deliberate console ACTION, and "cleared" must never be claimed for a
 * delete that did not run. Deleting is always safe here: a cleared cache is a cold cache, and
 * the next asks answer fresh and re-fill it.
 */
export async function clearAnswerCache(): Promise<number> {
  const r = kv();
  if (!r) throw new Error("no KV store is configured — there is no answer cache to clear");
  const keys = await scanKeys();
  let cleared = 0;
  // Chunked so one enormous DEL cannot blow the request-size ceiling of the REST transport.
  for (let i = 0; i < keys.length; i += 200) {
    cleared += await r.del(...keys.slice(i, i + 200));
  }
  return cleared;
}
