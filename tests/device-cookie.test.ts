import { beforeEach, expect, it, vi } from "vitest";
import { deviceCookie, readDeviceCookie, signDeviceCookie, prepareDeviceIntent, readDeviceIntent, deviceInputFingerprint } from "../lib/device-cookie";
import { stampValue } from "../lib/stamp";

const id = "bbbbbbbb-1111-4111-8111-bbbbbbbbbbbb";
const now = Date.parse("2026-09-08T12:00:00Z");
beforeEach(() => {
  vi.stubEnv("CONNECTOR_PATH_SECRET", "synthetic-secret");
  vi.stubEnv("CONSOLE_PASSCODE", "synthetic-passcode");
});
it("keeps one browser identity across visits without using the shared console stamp", () => {
  const signed = signDeviceCookie(id, now);
  expect(readDeviceCookie(signed, now + 300_000)).toBe(id);
  expect(readDeviceCookie(stampValue()!, now)).toBeNull();
  expect(readDeviceCookie(undefined, now)).toBeNull();
});
it("rejects identity/signature/expiry tampering and expired inventory bindings", () => {
  const signed = signDeviceCookie(id, now);
  expect(readDeviceCookie(signed.replace(id, "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa"), now)).toBeNull();
  expect(readDeviceCookie(signed + "x", now)).toBeNull();
  expect(readDeviceCookie(signed, now + 366 * 86400_000)).toBeNull();
  vi.stubEnv("CONSOLE_PASSCODE", "rotated-synthetic-passcode");
  expect(readDeviceCookie(signed, now)).toBeNull();
});
it("uses a separate scoped HTTP-only same-site secure cookie and can clear it", () => {
  vi.stubEnv("NODE_ENV", "production");
  const header = deviceCookie(signDeviceCookie(id, now), "synthetic-secret");
  expect(header).toContain("cortex-inventory=");
  expect(header).toContain("Path=/s/synthetic-secret/console");
  expect(header).toContain("HttpOnly");
  expect(header).toContain("SameSite=Strict");
  expect(header).toContain("Secure");
  expect(deviceCookie(null, "synthetic-secret")).toContain("Max-Age=0");
});
it("expires signed intents at 24 hours, isolates cookie signatures, and keys input fingerprints",()=>{
  const prepared=prepareDeviceIntent(now);
  expect(readDeviceIntent(prepared.intent,now+86399_000)).toMatchObject({expiresAt:"2026-09-09T12:00:00.000Z"});
  expect(readDeviceIntent(prepared.intent,now+86400_000)).toBeNull();
  expect(readDeviceIntent(signDeviceCookie(id,now),now)).toBeNull();
  expect(readDeviceCookie(prepared.intent,now)).toBeNull();
  expect(readDeviceIntent(prepared.intent+"x",now)).toBeNull();
  const hash=deviceInputFingerprint("Phone","phone");
  expect(deviceInputFingerprint("Phone","phone")).toBe(hash);
  expect(deviceInputFingerprint("Laptop","computer")).not.toBe(hash);
  vi.stubEnv("CONSOLE_PASSCODE","different-passcode");expect(deviceInputFingerprint("Phone","phone")).not.toBe(hash);
});
