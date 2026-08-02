import { describe, expect, it } from "vitest";
import { redact, hasSecret } from "../lib/redact";

describe("redact", () => {
  it("catches the shape actually sitting in this brain", () => {
    // archive/memory-2026-07/dir1--project-legacy-app.md carries a live production
    // password. A plain \b(password) misses it entirely — underscore is a word character, so
    // the boundary never matches inside ADMIN_PASSWORD. That near-miss is the whole reason the
    // key-name pattern allows a prefix.
    expect(redact("ADMIN_PASSWORD=3121 is set for Production")).toBe(
      "ADMIN_PASSWORD=<redacted> is set for Production"
    );
    expect(redact("ADMIN_PASSWORD=3121")).not.toContain("3121");
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
    const once = redact("ADMIN_PASSWORD=3121");
    expect(redact(once)).toBe(once);
  });
});
