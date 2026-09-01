import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { kv, kvEnv, resetKvForTests } from "../lib/kv";

/**
 * lib/kv.ts had no test file at all, and it exports a helper NAMED for tests that no test used.
 *
 * What matters here is the failure direction. Every KV-backed module (guest, settings, calls,
 * proposals) branches on `kv()` returning null, and each has a documented degradation for that
 * case. If kv() ever threw instead of returning null — the constructor validates its URL
 * synchronously and does throw on a malformed value — those degradations would be bypassed and
 * a stray newline in an env var would 500 the console rather than degrade it.
 */
beforeEach(() => {
  resetKvForTests();
});

afterEach(() => {
  vi.unstubAllEnvs();
  resetKvForTests();
});

describe("kv", () => {
  it("returns null when the store is unconfigured", () => {
    vi.stubEnv("KV_REST_API_URL", "");
    vi.stubEnv("KV_REST_API_TOKEN", "");
    expect(kv()).toBeNull();
  });

  it("returns null when only one half of the credential pair is set", () => {
    vi.stubEnv("KV_REST_API_URL", "https://example.upstash.io");
    vi.stubEnv("KV_REST_API_TOKEN", "");
    expect(kv()).toBeNull();

    resetKvForTests();
    vi.stubEnv("KV_REST_API_URL", "");
    vi.stubEnv("KV_REST_API_TOKEN", "tok");
    expect(kv()).toBeNull();
  });

  it("returns null rather than throwing on a malformed URL", () => {
    // The case the memoization exists for: a pasted env var with a stray newline. Callers all
    // handle null; none handles a throw.
    vi.stubEnv("KV_REST_API_URL", "not a url\n");
    vi.stubEnv("KV_REST_API_TOKEN", "tok");
    expect(() => kv()).not.toThrow();
    expect(kv()).toBeNull();
  });

  it("memoizes, so a later env change does not silently swap the client", () => {
    vi.stubEnv("KV_REST_API_URL", "");
    vi.stubEnv("KV_REST_API_TOKEN", "");
    expect(kv()).toBeNull();
    vi.stubEnv("KV_REST_API_URL", "https://example.upstash.io");
    vi.stubEnv("KV_REST_API_TOKEN", "tok");
    expect(kv()).toBeNull(); // still the memoized null
    resetKvForTests();
    expect(kv()).not.toBeNull(); // the seam is what clears it
  });
});

describe("kvEnv", () => {
  it("uses VERCEL_ENV when present", () => {
    vi.stubEnv("VERCEL_ENV", "preview");
    expect(kvEnv()).toBe("preview");
  });

  it("falls back to development locally", () => {
    // undefined, not "": kvEnv uses ?? so an empty string would pass through as an env name.
    vi.stubEnv("VERCEL_ENV", undefined);
    expect(kvEnv()).toBe("development");
  });
});
