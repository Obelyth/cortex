import { describe, expect, it } from "vitest";
import { redact, hasSecret } from "../lib/redact";

describe("redact", () => {
  it("catches the shape actually sitting in this brain", () => {
    // archive/memory-2026-07/dir1--project-example-v2.md carries a live production
    // password. A plain \b(password) misses it entirely — underscore is a word character, so
    // the boundary never matches inside ADMIN_PASSWORD. That near-miss is the whole reason the
    // key-name pattern allows a prefix.
    expect(redact("ADMIN_PASSWORD=synthetic-not-a-real-secret is set for Production")).toBe(
      "ADMIN_PASSWORD=<redacted> is set for Production"
    );
    expect(redact("ADMIN_PASSWORD=synthetic-not-a-real-secret")).not.toContain("synthetic-not-a-real-secret");
  });

  it("handles the separators and casings notes actually use", () => {
    for (const line of [
      "password: hunter2",
      "DB-SECRET = abc123",
      "vercelToken=xyz",
      "api_key: sk-live-abcdef",
      "API-KEY = 99999",
    ]) {
      expect(hasSecret(line)).toBe(true);
      expect(redact(line)).toContain("<redacted>");
    }
  });

  it("catches vendor-shaped tokens with no key name near them", () => {
    expect(redact("use ghp_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa here")).toContain("<redacted-token>");
    expect(redact("AKIAIOSFODNN7EXAMPLE")).toBe("<redacted-token>");
    expect(redact("xoxb-1234567890-abcdef")).toContain("<redacted-token>");
    expect(redact("eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N")).toBe(
      "<redacted-jwt>"
    );
    // Google's key shape, as a Gemini invalid-key error body echoes it back. The value is
    // deliberately nonsense: the real documented example key fires every secret scanner that
    // reads this repo, and the assertion only needs AIza followed by 35 characters.
    expect(redact("API key not valid: AIzaEXAMPLEEXAMPLEEXAMPLEEXAMPLEEXAMPLE")).toBe(
      "API key not valid: <redacted-token>"
    );
  });

  it("catches the shapes provider error bodies actually use", () => {
    // OpenAI's invalid-key echo masks the middle itself, but the visible slice of a real key
    // still must not ride an error out.
    expect(redact("Incorrect API key provided: sk-proj-********************MA5A")).toContain(
      "<redacted-token>"
    );
    // Error bodies are JSON, where the key name is quoted — the char after `token` is a
    // closing quote, which the bare \s*[:=] separator never matched.
    expect(redact('{"token": "supersecretvalue123"}')).not.toContain("supersecretvalue123");
    expect(redact('{"api_key": "sk_live_abc"}')).not.toContain("sk_live_abc");
  });

  it("catches a credential carried in a URL query string", () => {
    expect(redact("https://example.com/hook?token=abc123&x=1")).toBe("<redacted-url>");
  });

  it("leaves ordinary prose alone", () => {
    // Over-redaction is not free: it corrupts quotes and makes verification fail on honest
    // notes. These are the shapes this brain is full of.
    for (const line of [
      "The deploy is dark and both URLs return 404.",
      "Rotate the admin password before the next release.",
      "A save is only real if a tool result returned a 40-hex commit SHA.",
      "type: feedback",
    ]) {
      expect(redact(line)).toBe(line);
      expect(hasSecret(line)).toBe(false);
    }
  });

  it("is idempotent, so redacted text is never re-mangled", () => {
    const once = redact("ADMIN_PASSWORD=synthetic-not-a-real-secret");
    expect(redact(once)).toBe(once);
  });
});
