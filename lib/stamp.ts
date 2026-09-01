import { createHmac } from "node:crypto";
import { safeEqualStrings } from "./auth";
import { kv, kvEnv } from "./kv";

/**
 * The device stamp — the console's second factor.
 *
 * The path secret proves you hold the link; it cannot prove the link was not forwarded,
 * screenshotted, or pulled out of a log (it happened: a Vercel log pull printed a gated URL
 * into a transcript, and the answer was a rotation). So the web console asks one more thing
 * of a device the first time it loads: the passcode. Only the entry route hands out the stamp,
 * and only in exchange for CONSOLE_PASSCODE.
 *
 * The stamp's value is an HMAC over the path secret, keyed by the passcode — deliberately
 * derived, never stored, so the stateless-server rule holds: no session table, nothing to
 * expire. Three properties fall out of the derivation:
 *
 *   - holding the link is not enough to forge the cookie (the passcode is the missing key);
 *   - a leaked cookie does not reveal the passcode (it is a digest, not the credential);
 *   - rotating EITHER value re-prompts every device at its next visit.
 *
 * Unset passcode = the web console fails CLOSED, like every other gate here (see
 * requireSecret and verifyToken: a misconfigured secret must never become an open door).
 * The MCP doors never read any of this — a connector cannot type into a prompt.
 */

export const STAMP_COOKIE = "cortex-console";

function passcode(): string {
  // Trimmed for the same reason MCP_TOKEN is: a padded env var is one copy-paste away, and
  // whitespace must never become the credential.
  return process.env.CONSOLE_PASSCODE?.trim() ?? "";
}

export function passcodeConfigured(): boolean {
  return passcode().length > 0;
}

/** The candidate a person typed, against the configured passcode. Constant-time, fail closed. */
export function passcodeMatches(candidate: string): boolean {
  const code = passcode();
  return code.length > 0 && safeEqualStrings(candidate.trim(), code);
}

/** The one true cookie value, or null while either half of the derivation is unconfigured. */
export function stampValue(): string | null {
  const code = passcode();
  const secret = process.env.CONNECTOR_PATH_SECRET;
  if (!code || !secret) return null;
  return createHmac("sha256", code).update(`cortex-console-stamp-v1:${secret}`).digest("hex");
}

export function stampIsValid(cookieValue: string | undefined): boolean {
  const expected = stampValue();
  return Boolean(cookieValue && expected && safeEqualStrings(cookieValue, expected));
}

/**
 * Route handlers hold a Request, not next/headers — reading the header directly keeps the
 * gate a plain function of its input, which is also what makes it testable without a mounted
 * framework. Exact-name match on the trimmed pair, so `xcortex-console=` never satisfies it.
 */
export function readCookie(header: string | null, name: string): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return undefined;
}

/** Uniform pause on every refused passcode — verdict timing never says how close a guess was.
 *  Lives here rather than in the entry route because a route module may only export handlers,
 *  and a test seam is exactly not one. 650ms of honesty is a price only production pays. */
let failDelayMs = 650;
export function __setGateDelayForTests(ms: number): void {
  failDelayMs = ms;
}
export const failDelay = (): Promise<void> => new Promise((r) => setTimeout(r, failDelayMs));

/**
 * Failure metering for the passcode prompt. A passcode behind a secret URL is only ever seen
 * by someone who already holds the link — but that person is exactly who this lock exists for,
 * so guessing gets a budget: per-address and in total, per window. KV-backed because the
 * server is many instances; DEGRADES OPEN when the store is absent or unreachable (the uniform
 * failure delay in the entry route still applies) — metering must never take the door down,
 * and the failure direction of a broken meter lands on "the operator can still get in".
 * The window slides on failures: a guesser keeps their own counter alive.
 */
const WINDOW_SECONDS = 900;
const PER_ADDRESS_LIMIT = 8;
const GLOBAL_LIMIT = 64;

const failKey = (who: string) => `cortex:gate:fail:${kvEnv()}:${who}`;

export async function gateAllowed(address: string): Promise<boolean> {
  const store = kv();
  if (!store) return true;
  try {
    const [mine, all] = await Promise.all([
      store.get<number>(failKey(address)),
      store.get<number>(failKey("all")),
    ]);
    return (mine ?? 0) < PER_ADDRESS_LIMIT && (all ?? 0) < GLOBAL_LIMIT;
  } catch {
    return true;
  }
}

export async function gateFailed(address: string): Promise<void> {
  const store = kv();
  if (!store) return;
  try {
    const p = store.pipeline();
    p.incr(failKey(address));
    p.expire(failKey(address), WINDOW_SECONDS);
    p.incr(failKey("all"));
    p.expire(failKey("all"), WINDOW_SECONDS);
    await p.exec();
  } catch {
    // Swallowed on purpose: a metering write must never 500 the prompt.
  }
}
