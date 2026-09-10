import { createHmac, randomUUID } from "node:crypto";
import { safeEqualStrings } from "./auth";

export const DEVICE_COOKIE = "cortex-inventory";
const YEAR_SECONDS = 365 * 86400;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function signature(payload: string, purpose = "browser-inventory"): string | null {
  const key = process.env.CONSOLE_PASSCODE?.trim();
  const secret = process.env.CONNECTOR_PATH_SECRET;
  if (!key || !secret) return null;
  // Domain-separated from authentication. The shared stamp is never signing material.
  return createHmac("sha256", key).update(`cortex-${purpose}-v1:${secret}:${payload}`).digest("hex");
}

/** Inventory only: every caller must independently prove the console gate first. */
export function signDeviceCookie(id: string, now = Date.now()): string {
  if (!UUID.test(id)) throw new Error("invalid inventory identity");
  const payload = `v1.${id}.${Math.floor(now / 1000) + YEAR_SECONDS}`;
  const sig = signature(payload);
  if (!sig) throw new Error("inventory signing unavailable");
  return `${payload}.${sig}`;
}
export function readDeviceCookie(value: string | undefined, now = Date.now()): string | null {
  if (!value || value.length > 200) return null;
  const [version, id, expiry, sig, extra] = value.split(".");
  if (version !== "v1" || !UUID.test(id ?? "") || !/^\d{10}$/.test(expiry ?? "") || !/^[0-9a-f]{64}$/.test(sig ?? "") || extra !== undefined) return null;
  const seconds = Math.floor(now / 1000);
  if (Number(expiry) <= seconds || Number(expiry) > seconds + YEAR_SECONDS) return null;
  const expected = signature(`${version}.${id}.${expiry}`);
  return expected && safeEqualStrings(sig, expected) ? id : null;
}
export function deviceCookie(value: string | null, secret: string): string {
  return `${DEVICE_COOKIE}=${value ?? ""}; Path=/s/${encodeURIComponent(secret)}/console; Max-Age=${value ? YEAR_SECONDS : 0}; HttpOnly; SameSite=Strict${process.env.NODE_ENV === "production" ? "; Secure" : ""}`;
}

export function prepareDeviceIntent(now = Date.now()) {
  const expiry = Math.floor(now / 1000) + 86400;
  const payload = `v1.${randomUUID()}.${expiry}`;
  const sig = signature(payload, "inventory-intent");
  if (!sig) throw new Error("inventory signing unavailable");
  return { outcome: "prepared" as const, intent: `${payload}.${sig}`, expiresAt: new Date(expiry * 1000).toISOString() };
}
export function readDeviceIntent(value: string, now = Date.now()): { id: string; expiresAt: string } | null {
  if (value.length > 200) return null;
  const [version,id,expiry,sig,extra] = value.split(".");
  if (version!=="v1" || !UUID.test(id??"") || !/^\d{10}$/.test(expiry??"") || !/^[0-9a-f]{64}$/.test(sig??"") || extra!==undefined) return null;
  const seconds = Math.floor(now/1000);
  if (Number(expiry)<=seconds || Number(expiry)>seconds+86400) return null;
  const expected=signature(`${version}.${id}.${expiry}`,"inventory-intent");
  return expected && safeEqualStrings(sig,expected) ? { id, expiresAt:new Date(Number(expiry)*1000).toISOString() } : null;
}
export function deviceInputFingerprint(label: string, category: string | null): string {
  const result = signature(JSON.stringify([label,category]),"inventory-input");
  if (!result) throw new Error("inventory signing unavailable");
  return result;
}
