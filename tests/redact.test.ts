import { describe, expect, it } from "vitest";
import { redact, hasSecret, SECRETS } from "../lib/redact";

describe("redact", () => {
  it.each(["Authorization: Bearer opaque-synthetic-value-4821", '"Authorization": "Bearer opaque-synthetic-value-4821"', "Bearer opaque-synthetic-value-4821", "Authorization: Basic dXNlcjpwYXNz", "Authorization: Basic YTpi", "Proxy-Authorization: Bearer c3ludGhldGlj", "Authorization: opaque_header_value", "Bearer abcdefghijklmnopqrstuvwxyzabcdef", "Bearer abcdefghijklmnopqrst", "Bearer ab+cd/ef==ghijklmn", "Authorization: ApiKey VnVhbGlkOnNlY3JldA==", "Authorization: SSWS 00Qh3syntheticokta", "Authorization: GenieKey eb24synthetic-4821", "Authorization: Splunk 1234synthetic", "Authorization: Zoho-oauthtoken 1000.8cbsynthetic", "github_pat_synthetic", "github_pat_a"])("classifies and masks recognized complete or partial credentials: %s", value => {
    expect(hasSecret(value)).toBe(true);
    expect(redact(value)).not.toContain("opaque-synthetic");
    expect(redact(value)).not.toContain("github_pat_");
    expect(SECRETS.some(([p])=>new RegExp(p.source,p.flags).test(value))).toBe(true);
  });
  it("keeps benign URL tokens intact and does bounded work on repeated URL starts", () => {
    const benign="http://".repeat(16384);
    const started=performance.now();expect(redact(benign)).toBe(benign);expect(hasSecret(benign)).toBe(false);
    expect(performance.now()-started).toBeLessThan(500);
    for(const value of ["https://example.test/path?q=hello", "Bearer of good news", "Authorization is required", "https://one.test/path https://two.test/path"]){expect(redact(value)).toBe(value);expect(hasSecret(value)).toBe(false);}
  });

  it("leaves prose alone: a scheme word followed by a word is a sentence, not a header", () => {
    // Each of these came back censored from brain_ask on 2026-09-09 — the memory system
    // redacting its own notes. A word after "bearer" has no digit, no underscore and no
    // 24-character run; a header value has at least one of them, or a scheme in front of it.
    for (const value of [
      "Use bearer authentication for the door",
      "The bearer readiness row shows presence only",
      "Authorization: none is required for the guest door",
      "Bearer Grylls-fan",
      "the bearer of this note is the operator",
      "Authorization: Bearer",
      "Authorization: see section four for the door policy",
      "Authorization: operator-only, see the guest door",
      "Authorization: see notes/door.md for the policy",
    ]) {
      expect(redact(value)).toBe(value);
      expect(hasSecret(value)).toBe(false);
    }
    expect(redact("https://one.test/?next=https://two.test/?token=syntheticValue")).not.toContain("syntheticValue");
  });
  it("catches the shape actually sitting in this brain", () => {
    // The brain's archive carries a real ADMIN_PASSWORD=… line. A plain \b(password) misses it
    // entirely — underscore is a word character, so the boundary never matches inside
    // ADMIN_PASSWORD. That near-miss is the whole reason the key-name pattern allows a prefix.
    //
    // THE VALUE HERE IS SYNTHETIC, and must stay that way. These fixtures used to carry the
    // real production password for a live site, which is how it ended up committed to the
    // public port — the export gate could not catch it, because that gate matches whole brain
    // lines and a secret is a short token inside a longer one. Redaction behaviour is proven by
    // the SHAPE of the input; the true value never adds coverage and only adds exposure.
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
    // Google's key shape — the one vendor form the operator's GAS/Sheets stack actually mints, and
    // the shape a Gemini invalid-key error body echoes back.
    expect(redact("API key not valid: AIzaSyD-9tSrke72PouQMnMX-a7eZSW0jkFMBWY")).toBe(
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
