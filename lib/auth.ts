import { timingSafeEqual } from "node:crypto";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";

/** Below this a token is almost certainly a truncated paste. WARNED about, never enforced —
 *  see verifyToken(). */
export const WEAK_TOKEN_LENGTH = 16;

export function safeEqualStrings(a: string, b: string): boolean {
  const ba = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}

export async function verifyToken(
  _req: Request,
  bearerToken?: string
): Promise<AuthInfo | undefined> {
  const expected = process.env.MCP_TOKEN;
  // A misconfigured secret must fail CLOSED. `!expected` already catches unset and "", but
  // "   " is truthy — whitespace would have become a valid credential, and a padded env var is
  // one copy-paste away.
  const secret = expected?.trim() ?? "";
  if (!secret) return undefined;

  // Length is WARNED about, not enforced. An earlier version of this refused anything under 16
  // characters, which is an arbitrary floor that silently invalidates a credential that was
  // working a minute earlier — every surface 401s at once, with a message the client renders
  // as "no authorization provided", and no migration path. Rejecting the deployment's own
  // configured secret is a worse failure than accepting a short one: the operator cannot log
  // in to fix it, and nothing in the response says why. Say so in the log and let it work.
  if (secret.length < WEAK_TOKEN_LENGTH) {
    console.warn(
      `[auth] MCP_TOKEN is ${secret.length} chars; ${WEAK_TOKEN_LENGTH}+ is recommended. Still accepted.`
    );
  }
  if (!bearerToken || !safeEqualStrings(bearerToken.trim(), secret)) {
    return undefined; // → 401 via withMcpAuth(required: true)
  }
  return { token: bearerToken, clientId: "operator", scopes: ["brain"] };
}
