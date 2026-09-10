/**
 * The ground — ink or paper — is a per-device choice kept in a cookie scoped to the console
 * path. Ink is the default (v2, 2026-09-05); paper is the setting. A plain module, no React,
 * so the layout (server), the route (server) and the switch (client) read one definition.
 */
export type Ground = "ink" | "paper";
export const GROUND_COOKIE = "cx-ground";

export function groundFrom(value: string | undefined | null): Ground {
  return value === "paper" ? "paper" : "ink";
}

/** The Set-Cookie value: a year, path-scoped to this console, Lax, Secure over https. */
export function groundCookie(ground: Ground, secret: string, secure: boolean): string {
  return `${GROUND_COOKIE}=${ground}; Path=/s/${encodeURIComponent(secret)}/console; Max-Age=31536000; SameSite=Lax${secure ? "; Secure" : ""}`;
}
