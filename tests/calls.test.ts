import { describe, expect, it, vi, beforeEach } from "vitest";
import { record, readCalls, stampOf, withSurface, currentSurface } from "../lib/calls";

/**
 * The call log is the console's only non-corpus source, so what matters is that it never
 * overstates what it knows: the window it reports must be the window it actually covers.
 */
describe("call log", () => {
  beforeEach(async () => {
    vi.useRealTimers();
    // The memory-path suite must stay off the real store even when a shell has sourced
    // .env.local — empty strings read as unset, and the memo is cleared so they take effect.
    vi.stubEnv("KV_REST_API_URL", "");
    vi.stubEnv("KV_REST_API_TOKEN", "");
    (await import("../lib/calls")).resetStoreForTests();
  });

  it("keeps rows inside the window and drops the rest", async () => {
    const now = Date.now();
    record({ ts: now - 90_000_000, surface: "terminal", tool: "brain_ask", stamp: "VERIFIED", ms: 10 });
    record({ ts: now - 1_000, surface: "terminal", tool: "brain_ask", stamp: "VERIFIED", ms: 10 });
    const { rows } = await readCalls(86_400_000, now);
    expect(rows.every((r) => r.ts >= now - 86_400_000)).toBe(true);
    expect(rows.length).toBeGreaterThanOrEqual(1);
  });

  it("reports the window as partial when the log is younger than it", async () => {
    // The log starts when the module loads, so a 24h window on a fresh process is partial —
    // that flag is what stops the console from drawing 24 hours of implied silence.
    const { partial, covers, durable } = await readCalls(86_400_000, Date.now());
    expect(partial).toBe(true);
    expect(covers).toBeLessThan(86_400_000);
    expect(durable).toBe(false);
  });

  it("reads the verdict off the head of the reply, not from anywhere in it", () => {
    // The shapes render() actually emits: the verdict is the leading token of line 1.
    expect(stampOf("VERIFIED — this quote is verbatim in notes/x.md @abc.\n\nThe answer.")).toBe("VERIFIED");
    expect(stampOf("PARTIALLY VERIFIED — the quote is verbatim, but it appears in 3 notes.")).toBe(
      "PARTIALLY VERIFIED",
    );
    expect(stampOf("SUPERSEDED — the quote is verbatim in x, but that passage is retracted.")).toBe(
      "SUPERSEDED",
    );
    expect(stampOf("NOT IN BRAIN\n\nNothing here covers it.")).toBe("NOT IN BRAIN");
    expect(stampOf("here is an answer with no stamp")).toBe("ANSWERED");
  });

  it("is not fooled by the answer's own body text", () => {
    // This brain documents the verifier, so a VERIFIED answer routinely quotes the words
    // UNVERIFIED and NOT IN BRAIN in its evidence. Scanning the whole reply logged those
    // as failures — the console then disagreed with the answer the caller was handed.
    const real = [
      "VERIFIED — this quote is verbatim in notes/verification-contract.md @abc123.",
      "",
      "The verifier stamps UNVERIFIED when the quote is not in the cited file, and",
      "NOT IN BRAIN when the reader found nothing.",
      "",
      "source: notes/verification-contract.md",
      'evidence: "…SUPERSEDED means the quote is real and the passage is retracted…"',
    ].join("\n");
    expect(stampOf(real)).toBe("VERIFIED");
  });

  it("carries the surface through async work, and defaults to terminal", () => {
    expect(currentSurface()).toBe("terminal");
    const seen = withSurface("connector", () => currentSurface());
    expect(seen).toBe("connector");
    expect(currentSurface()).toBe("terminal");
  });

  it("advances its coverage claim when the ring buffer evicts", async () => {
    // A long-lived instance that fills the buffer no longer holds the window its start time
    // implies. Reporting the full 24h then draws the evicted hours as silence.
    const now = Date.now();
    for (let i = 0; i < 5200; i++) {
      record({ ts: now - 3_600_000 + i, surface: "terminal", tool: "brain_read", stamp: "READ", ms: 1 });
    }
    const { rows, partial, covers } = await readCalls(86_400_000, now);
    expect(rows.length).toBeLessThanOrEqual(5000);
    expect(partial).toBe(true);
    // Everything surviving started within the last hour, so that is all it can claim.
    expect(covers).toBeLessThanOrEqual(3_600_000 + 60_000);
  });

  it("returns rows oldest first even when a slow call finishes last", async () => {
    const now = Date.now();
    // A 40s ask that started first is appended after a fast read that started later.
    record({ ts: now - 40_000, surface: "terminal", tool: "brain_read", stamp: "READ", ms: 5 });
    record({ ts: now - 60_000, surface: "terminal", tool: "brain_ask", stamp: "VERIFIED", ms: 40_000 });
    const { rows } = await readCalls(120_000, now);
    const ts = rows.map((r) => r.ts);
    expect(ts).toEqual([...ts].sort((a, b) => a - b));
  });

  it("keeps the surface across an await boundary", async () => {
    const seen = await withSurface("connector", async () => {
      await new Promise((r) => setTimeout(r, 1));
      return currentSurface();
    });
    expect(seen).toBe("connector");
  });
});

describe("durable store path", () => {
  // The tests own the env: without these vars readCalls uses memory, with them it must read
  // the store, and a failing store must fall back rather than surface.
  const URL_KEY = "KV_REST_API_URL";
  const TOK_KEY = "KV_REST_API_TOKEN";

  it("reads, parses and windows rows from the store, honestly labelled durable", async () => {
    vi.resetModules();
    vi.doMock("@upstash/redis", () => ({
      Redis: class {
        lrange() {
          const now = Date.now();
          return Promise.resolve([
            JSON.stringify({ ts: now - 1_000, surface: "connector", tool: "brain_ask", stamp: "VERIFIED", ms: 900 }),
            JSON.stringify({ ts: now - 90_000_000, surface: "terminal", tool: "brain_read", stamp: "READ", ms: 5 }),
            JSON.stringify({ ts: now - 2_000, surface: "webhook", tool: "brain_read", stamp: "READ", ms: 5 }),
            "not json at all",
          ]);
        }
        get() { return Promise.resolve(String(Date.now() - 7_200_000)); }
        pipeline() { return { lpush() {}, ltrim() {}, setnx() {}, exec: () => Promise.resolve([]) }; }
      },
    }));
    vi.stubEnv(URL_KEY, "https://example.upstash.io");
    vi.stubEnv(TOK_KEY, "test-token");
    const { readCalls: read } = await import("../lib/calls");
    const w = await read(86_400_000);
    expect(w.durable).toBe(true);
    expect(w.source).toBe("store");
    // The 25h-old row is outside the window; the malformed row and the unknown-surface row
    // are dropped, not fatal — and the unknown surface must NOT be folded into "terminal".
    expect(w.rows).toHaveLength(1);
    expect(w.rows[0].surface).toBe("connector");
    // Coverage comes from the stored since marker (~2h), not the full window.
    expect(w.partial).toBe(true);
    expect(w.covers).toBeLessThanOrEqual(7_300_000);
    vi.unstubAllEnvs();
    vi.doUnmock("@upstash/redis");
  });

  it("carries the reader model through, and leaves older rows unattributed", async () => {
    // The store holds up to two days of rows written before the model field existed. A reader
    // that required the field would drop them all and report the server idle; one that defaulted
    // it would rewrite history as "whatever model reads today". Neither is acceptable.
    vi.resetModules();
    const now = Date.now();
    vi.doMock("@upstash/redis", () => ({
      Redis: class {
        lrange() {
          return Promise.resolve([
            JSON.stringify({ ts: now - 1_000, surface: "terminal", tool: "brain_ask", stamp: "VERIFIED", ms: 900, model: "gpt-5.6-terra" }),
            JSON.stringify({ ts: now - 2_000, surface: "terminal", tool: "brain_ask", stamp: "VERIFIED", ms: 900 }),
            // A model retired from the allowlist still answered this call; the row is history,
            // and history is not re-validated.
            JSON.stringify({ ts: now - 3_000, surface: "terminal", tool: "brain_ask", stamp: "UNVERIFIED", ms: 800, model: "claude-retired-9" }),
            JSON.stringify({ ts: now - 4_000, surface: "terminal", tool: "brain_read", stamp: "READ", ms: 5, model: "" }),
          ]);
        }
        get() { return Promise.resolve(String(now - 7_200_000)); }
        pipeline() { return { lpush() {}, ltrim() {}, setnx() {}, exec: () => Promise.resolve([]) }; }
      },
    }));
    vi.stubEnv(URL_KEY, "https://example.upstash.io");
    vi.stubEnv(TOK_KEY, "test-token");
    const { readCalls: read } = await import("../lib/calls");
    const { rows } = await read(86_400_000, now);
    expect(rows.map((r) => r.model)).toEqual([
      undefined,          // brain_read, empty string is not an attribution
      "claude-retired-9",
      undefined,          // pre-field row
      "gpt-5.6-terra",
    ]);
    vi.unstubAllEnvs();
    vi.doUnmock("@upstash/redis");
  });

  it("carries the cached marker through, dropping junk values, and keeps cached rows out of the model record", async () => {
    // A cached row is a replay: it stays attributed (the console can still say who answered
    // originally) but must not count toward the model's verdict record — a repeated answer
    // must not inflate a model's record. And only literal true marks a row cached: a truthy
    // junk value would silently drop a REAL model call from the record.
    vi.resetModules();
    const now = Date.now();
    vi.doMock("@upstash/redis", () => ({
      Redis: class {
        lrange() {
          return Promise.resolve([
            JSON.stringify({ ts: now - 1_000, surface: "terminal", tool: "brain_ask", stamp: "VERIFIED", ms: 12, model: "claude-sonnet-5", cached: true }),
            JSON.stringify({ ts: now - 2_000, surface: "terminal", tool: "brain_ask", stamp: "VERIFIED", ms: 900, model: "claude-sonnet-5" }),
            JSON.stringify({ ts: now - 3_000, surface: "terminal", tool: "brain_ask", stamp: "VERIFIED", ms: 800, model: "claude-sonnet-5", cached: "yes" }),
          ]);
        }
        get() { return Promise.resolve(String(now - 7_200_000)); }
        pipeline() { return { lpush() {}, ltrim() {}, setnx() {}, exec: () => Promise.resolve([]) }; }
      },
    }));
    vi.stubEnv(URL_KEY, "https://example.upstash.io");
    vi.stubEnv(TOK_KEY, "test-token");
    const { readCalls: read, modelRecordRows } = await import("../lib/calls");
    const { rows } = await read(86_400_000, now);
    expect(rows.map((r) => r.cached)).toEqual([undefined, undefined, true]);
    // The record keeps the two real calls (including the junk-cached one) and drops the replay.
    expect(modelRecordRows(rows).map((r) => r.ms).sort()).toEqual([800, 900]);
    // Unattributed rows never enter the record either, cached or not.
    expect(
      modelRecordRows([{ ts: now, surface: "terminal", tool: "brain_ask", stamp: "VERIFIED", ms: 1 }])
    ).toEqual([]);
    vi.unstubAllEnvs();
    vi.doUnmock("@upstash/redis");
  });

  it("falls back to memory when the store throws, and says so", async () => {
    vi.resetModules();
    vi.doMock("@upstash/redis", () => ({
      Redis: class {
        lrange() { return Promise.reject(new Error("store down")); }
        get() { return Promise.reject(new Error("store down")); }
        pipeline() { return { lpush() {}, ltrim() {}, setnx() {}, exec: () => Promise.reject(new Error("down")) }; }
      },
    }));
    vi.stubEnv(URL_KEY, "https://example.upstash.io");
    vi.stubEnv(TOK_KEY, "test-token");
    const { readCalls: read, record: rec } = await import("../lib/calls");
    // A record against a dead store must not throw — the tool call already succeeded.
    expect(() =>
      rec({ ts: Date.now(), surface: "terminal", tool: "brain_read", stamp: "READ", ms: 3 }),
    ).not.toThrow();
    const w = await read(86_400_000);
    expect(w.durable).toBe(false);
    expect(w.source).toBe("unreachable");
    vi.unstubAllEnvs();
    vi.doUnmock("@upstash/redis");
  });
});
