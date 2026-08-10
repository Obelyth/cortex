import { Redis } from "@upstash/redis";

/**
 * The one KV client, shared by everything that needs the store.
 *
 * Extracted from calls.ts when settings.ts arrived: two memoized clients would mean two
 * constructor attempts, two warnings on a malformed URL, and two different opinions about
 * whether the store is configured — on a page that renders both.
 */

/**
 * Memoized and throw-proof. The constructor validates the URL synchronously and THROWS on a
 * malformed value (a pasted env var with a stray newline is enough) — uncaught, that would 500
 * the console instead of degrading, and fire a warning per tool call instead of once. undefined
 * = not yet tried; null = unconfigured or invalid, use the caller's fallback.
 */
let client: Redis | null | undefined;

export function kv(): Redis | null {
  if (client !== undefined) return client;
  const url = process.env.KV_REST_API_URL;
  const token = process.env.KV_REST_API_TOKEN;
  if (!url || !token) return (client = null);
  try {
    client = new Redis({ url, token });
  } catch {
    client = null;
  }
  return client;
}

/** Test seam: forget the memoized client so env stubs take effect. */
export function resetKvForTests(): void {
  client = undefined;
}

/**
 * Keys are per-environment so a preview deploy or local dev run never writes into the
 * production record. VERCEL_ENV is absent locally, which lands on "development" — the same
 * environment the marketplace store scopes local pulls to.
 */
export function kvEnv(): string {
  return process.env.VERCEL_ENV ?? "development";
}
