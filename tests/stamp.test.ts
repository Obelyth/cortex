import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  gateAllowed,
  gateFailed,
  passcodeConfigured,
  passcodeMatches,
  readCookie,
  stampIsValid,
  stampValue,
} from "../lib/stamp";

/**
 * The device stamp is the whole difference between "holds the link" and "typed the passcode".
 * What these tests pin is the derivation's three promises — the link can't forge it, a cookie
 * doesn't reveal the passcode, either rotation kills it — plus the fail-closed edges, because
 * a stamp that validates against an unconfigured deployment would be an open door with extra
 * steps.
 */

const SECRET = "s".repeat(64);
const CODE = "correct horse battery staple";

beforeEach(() => {
  vi.stubEnv("CONNECTOR_PATH_SECRET", SECRET);
  vi.stubEnv("CONSOLE_PASSCODE", CODE);
});

describe("stampValue", () => {
  it("is a hex digest, never the passcode and never the secret", () => {
    const v = stampValue();
    expect(v).toMatch(/^[0-9a-f]{64}$/);
    expect(v).not.toContain(CODE);
    expect(v).not.toContain(SECRET);
  });

  it("is deterministic for a fixed passcode + secret", () => {
    expect(stampValue()).toBe(stampValue());
  });

  it("rotating the passcode changes it", () => {
    const before = stampValue();
    vi.stubEnv("CONSOLE_PASSCODE", "a different phrase");
    expect(stampValue()).not.toBe(before);
  });

  it("rotating the path secret changes it", () => {
    const before = stampValue();
    vi.stubEnv("CONNECTOR_PATH_SECRET", "t".repeat(64));
    expect(stampValue()).not.toBe(before);
  });

  it("is null while either half is unconfigured — including a whitespace-only passcode", () => {
    vi.stubEnv("CONSOLE_PASSCODE", "");
    expect(stampValue()).toBeNull();
    vi.stubEnv("CONSOLE_PASSCODE", "   ");
    expect(stampValue()).toBeNull();
    vi.stubEnv("CONSOLE_PASSCODE", CODE);
    vi.stubEnv("CONNECTOR_PATH_SECRET", "");
    expect(stampValue()).toBeNull();
  });
});

describe("stampIsValid", () => {
  it("accepts exactly the derived value", () => {
    expect(stampIsValid(stampValue()!)).toBe(true);
  });

  it("rejects absence, garbage, and both raw credentials", () => {
    expect(stampIsValid(undefined)).toBe(false);
    expect(stampIsValid("")).toBe(false);
    expect(stampIsValid("f".repeat(64))).toBe(false);
    // The pre-passcode cookie carried the path secret verbatim; it must not still be entry.
    expect(stampIsValid(SECRET)).toBe(false);
    expect(stampIsValid(CODE)).toBe(false);
  });

  it("fails closed when the passcode is unconfigured — even against a stale real stamp", () => {
    const stamp = stampValue()!;
    vi.stubEnv("CONSOLE_PASSCODE", "");
    expect(stampIsValid(stamp)).toBe(false);
  });
});

describe("passcodeMatches / passcodeConfigured", () => {
  it("matches the configured passcode, trimmed on both sides", () => {
    expect(passcodeMatches(CODE)).toBe(true);
    expect(passcodeMatches(`  ${CODE}  `)).toBe(true);
    vi.stubEnv("CONSOLE_PASSCODE", ` ${CODE} `);
    expect(passcodeMatches(CODE)).toBe(true);
  });

  it("refuses wrong, empty, and prefix guesses", () => {
    expect(passcodeMatches("wrong")).toBe(false);
    expect(passcodeMatches("")).toBe(false);
    expect(passcodeMatches(CODE.slice(0, -1))).toBe(false);
  });

  it("fails closed when unconfigured — the empty guess never matches the empty setting", () => {
    vi.stubEnv("CONSOLE_PASSCODE", "");
    expect(passcodeConfigured()).toBe(false);
    expect(passcodeMatches("")).toBe(false);
    vi.stubEnv("CONSOLE_PASSCODE", "  ");
    expect(passcodeConfigured()).toBe(false);
    expect(passcodeMatches("  ")).toBe(false);
  });
});

describe("readCookie", () => {
  it("finds the named cookie among others, whitespace and all", () => {
    expect(readCookie("a=1; cortex-console=abc; b=2", "cortex-console")).toBe("abc");
    expect(readCookie("cortex-console=abc", "cortex-console")).toBe("abc");
    expect(readCookie("  cortex-console = abc ", "cortex-console")).toBe("abc");
  });

  it("never matches on a name suffix or prefix", () => {
    expect(readCookie("xcortex-console=evil", "cortex-console")).toBeUndefined();
    expect(readCookie("cortex-console2=evil", "cortex-console")).toBeUndefined();
  });

  it("handles an absent header and an absent cookie", () => {
    expect(readCookie(null, "cortex-console")).toBeUndefined();
    expect(readCookie("a=1; b=2", "cortex-console")).toBeUndefined();
  });
});

describe("failure metering without a store", () => {
  it("degrades open: no KV means allowed, and recording a failure is a no-op, not a throw", async () => {
    // Unstubbed KV env in tests = kv() returns null; the door must still work.
    await expect(gateAllowed("203.0.113.9")).resolves.toBe(true);
    await expect(gateFailed("203.0.113.9")).resolves.toBeUndefined();
  });
});
