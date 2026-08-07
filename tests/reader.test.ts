import { describe, expect, it, vi, afterEach } from "vitest";
import {
  modelReader,
  openaiReader,
  geminiReader,
  resolveModel,
  providerOf,
  READER_MODEL_IDS,
} from "../lib/reader";
import { DEFAULT_MODEL } from "../lib/ask";

/**
 * The reader is pluggable, and what matters is that plugging never weakens the contract:
 * every backend fails loudly on anything that is not a completed answer, because an empty ""
 * downstream renders as NOT IN BRAIN — a broken call must never look like a genuine absence.
 */

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

/** A fetch stub that records its one call and returns the given payload. */
function stubFetch(payload: unknown, status = 200) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fn = vi.fn(async (url: string | URL, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    return new Response(typeof payload === "string" ? payload : JSON.stringify(payload), {
      status,
    });
  });
  vi.stubGlobal("fetch", fn);
  return calls;
}

const openaiReply = (text: string) => ({
  status: "completed",
  output: [
    { type: "reasoning" },
    { type: "message", content: [{ type: "output_text", text }] },
  ],
});

const geminiReply = (texts: string[], finishReason = "STOP") => ({
  candidates: [{ finishReason, content: { parts: texts.map((t) => ({ text: t })) } }],
});

describe("model resolution", () => {
  it("falls back to the measured default, treating a blank READER_MODEL as unset", () => {
    // .env placeholder lines produce "", and "" ?? x does NOT fall through — the natural
    // state of an unfilled line must not become a model named "".
    vi.stubEnv("READER_MODEL", "");
    expect(resolveModel()).toBe(DEFAULT_MODEL);
    vi.stubEnv("READER_MODEL", "   ");
    expect(resolveModel()).toBe(DEFAULT_MODEL);
  });

  it("lets READER_MODEL set the deployment default, and the caller override it", () => {
    vi.stubEnv("READER_MODEL", "gemini-3.6-flash");
    expect(resolveModel()).toBe("gemini-3.6-flash");
    expect(resolveModel("claude-opus-5")).toBe("claude-opus-5");
  });

  it("throws loudly on a READER_MODEL typo instead of silently reading with something else", () => {
    vi.stubEnv("READER_MODEL", "gpt-4");
    expect(() => resolveModel()).toThrow(/READER_MODEL "gpt-4" is not an allowed reader model/);
    expect(() => resolveModel()).toThrow(/claude-sonnet-5/); // the error teaches the fix
  });

  it("maps every allowlisted model to a provider, and nothing else", () => {
    for (const m of READER_MODEL_IDS) expect(providerOf(m)).not.toBeNull();
    expect(providerOf("gpt-4")).toBeNull();
    expect(providerOf("claude-fable-5")).toBeNull();
    expect(providerOf("")).toBeNull();
    // A plain object literal inherits Object.prototype — a bare index would bless these.
    expect(providerOf("toString")).toBeNull();
    expect(providerOf("constructor")).toBeNull();
    expect(providerOf("__proto__")).toBeNull();
  });
});

describe("dispatch", () => {
  it("routes each model ID to its provider's endpoint", async () => {
    vi.stubEnv("OPENAI_API_KEY", "sk-test");
    vi.stubEnv("GEMINI_API_KEY", "g-test");
    const calls = stubFetch(openaiReply('{"answer":"a","tag":"","quote":""}'));
    await modelReader("prompt", "gpt-5.6-terra");
    expect(calls[0].url).toBe("https://api.openai.com/v1/responses");

    const gcalls = stubFetch(geminiReply(['{"answer":"a","tag":"","quote":""}']));
    await modelReader("prompt", "gemini-3.6-flash");
    expect(gcalls[0].url).toBe(
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.6-flash:generateContent"
    );
  });

  it("rejects a model outside the registry without calling anyone", async () => {
    const calls = stubFetch({});
    await expect(modelReader("p", "claude-fable-5")).rejects.toThrow(/unknown reader model/);
    expect(calls).toHaveLength(0);
  });

  it("names the missing key per provider — configuration reads as configuration", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "");
    vi.stubEnv("OPENAI_API_KEY", "");
    vi.stubEnv("GEMINI_API_KEY", "");
    stubFetch({});
    await expect(modelReader("p", "claude-sonnet-5")).rejects.toThrow(/ANTHROPIC_API_KEY not set/);
    await expect(modelReader("p", "gpt-5.6-sol")).rejects.toThrow(/OPENAI_API_KEY not set/);
    await expect(modelReader("p", "gemini-3.6-flash")).rejects.toThrow(/GEMINI_API_KEY not set/);
  });
});

describe("openai reader", () => {
  it("sends the strict schema and low reasoning effort, and returns the message text", async () => {
    vi.stubEnv("OPENAI_API_KEY", "sk-test");
    const calls = stubFetch(openaiReply('{"answer":"x","tag":"t","quote":"q"}'));
    const out = await openaiReader("the prompt", "gpt-5.6-terra");
    expect(out).toBe('{"answer":"x","tag":"t","quote":"q"}');

    const body = JSON.parse(String(calls[0].init.body));
    expect(body.model).toBe("gpt-5.6-terra");
    expect(body.text.format).toMatchObject({ type: "json_schema", name: "brain_reply", strict: true });
    expect(body.text.format.schema.additionalProperties).toBe(false);
    expect(body.reasoning).toEqual({ effort: "low" });
    expect((calls[0].init.headers as Record<string, string>).authorization).toBe("Bearer sk-test");
    // The 45s budget only exists if the signal actually rides the request — dropping it
    // would leave the reader hanging into Vercel's 60s kill with every test still green.
    expect(calls[0].init.signal).toBeInstanceOf(AbortSignal);
  });

  it("fails loudly when reasoning ate the budget and no message item exists", async () => {
    vi.stubEnv("OPENAI_API_KEY", "sk-test");
    stubFetch({
      status: "incomplete",
      incomplete_details: { reason: "max_output_tokens" },
      output: [{ type: "reasoning" }],
    });
    await expect(openaiReader("p", "gpt-5.6-sol")).rejects.toThrow(/max_output_tokens/);
  });

  it("fails loudly on an incomplete response even when partial text arrived", async () => {
    // Truncated JSON parses as nothing downstream and renders as NOT IN BRAIN — the one
    // confusion this system exists to prevent.
    vi.stubEnv("OPENAI_API_KEY", "sk-test");
    stubFetch({ ...openaiReply('{"answer":"cut off'), status: "incomplete" });
    await expect(openaiReader("p", "gpt-5.6-sol")).rejects.toThrow(/no usable answer/);
  });

  it("surfaces a refusal as a refusal, not an empty answer", async () => {
    vi.stubEnv("OPENAI_API_KEY", "sk-test");
    stubFetch({
      status: "completed",
      output: [{ type: "message", content: [{ type: "refusal", refusal: "cannot comply" }] }],
    });
    await expect(openaiReader("p", "gpt-5.6-sol")).rejects.toThrow(/refused.*cannot comply/);
  });

  it("reports an HTTP error with its status, body capped", async () => {
    vi.stubEnv("OPENAI_API_KEY", "sk-test");
    stubFetch(`{"error":{"message":"rate limited ${"x".repeat(2000)}"}}`, 429);
    const err = await openaiReader("p", "gpt-5.6-terra").catch((e: Error) => e);
    expect(String(err)).toMatch(/OpenAI returned 429/);
    expect(String(err).length).toBeLessThan(400);
  });

  it("redacts a credential echo in a provider error body before it rides the error out", async () => {
    vi.stubEnv("OPENAI_API_KEY", "sk-test");
    stubFetch('{"error":{"message":"Incorrect API key provided: sk-proj-abcdefghijklmnop1234"}}', 401);
    const err = String(await openaiReader("p", "gpt-5.6-terra").catch((e: Error) => e));
    expect(err).toMatch(/OpenAI returned 401/);
    expect(err).not.toContain("sk-proj-abcdefghijklmnop1234");
    expect(err).toContain("<redacted-token>");
  });

  it("shapes a 200 with a non-JSON body instead of leaking V8's raw body echo", async () => {
    // A proxy or CDN interstitial serves HTML with a 200; res.json()'s SyntaxError embeds a
    // slice of that body, unredacted and unlabelled, unless it is caught and reshaped.
    vi.stubEnv("OPENAI_API_KEY", "sk-test");
    stubFetch("<html>upstream error page</html>", 200);
    const err = String(await openaiReader("p", "gpt-5.6-terra").catch((e: Error) => e));
    expect(err).toMatch(/OpenAI returned unparseable JSON/);
    expect(err).not.toContain("<html>");
  });

  it("labels a timeout with the budget it blew, and a network failure with its provider", async () => {
    vi.stubEnv("OPENAI_API_KEY", "sk-test");
    const timeout = Object.assign(new Error("The operation was aborted due to timeout"), {
      name: "TimeoutError",
    });
    vi.stubGlobal("fetch", vi.fn(async () => { throw timeout; }));
    await expect(openaiReader("p", "gpt-5.6-sol")).rejects.toThrow(/no response within 45s/);

    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("ECONNRESET"); }));
    await expect(openaiReader("p", "gpt-5.6-sol")).rejects.toThrow(
      /OpenAI request failed — ECONNRESET/
    );
  });
});

describe("anthropic reader", () => {
  it("fails loudly on a truncated max_tokens reply even when text arrived", async () => {
    // Thinking shares max_tokens with the answer, so a long thinking pass can cut the JSON
    // off mid-emission: non-empty text, stop_reason "max_tokens", unparseable downstream —
    // which would render and be logged as NOT IN BRAIN. Same contract as the other backends.
    vi.resetModules();
    vi.doMock("@anthropic-ai/sdk", () => ({
      default: class {
        messages = {
          create: async () => ({
            stop_reason: "max_tokens",
            content: [{ type: "text", text: '{"answer":"cut off mid' }],
          }),
        };
      },
    }));
    vi.stubEnv("ANTHROPIC_API_KEY", "test-key");
    const { anthropicReader: reader } = await import("../lib/reader");
    await expect(reader("p", "claude-sonnet-5")).rejects.toThrow(/max_tokens/);
    vi.doUnmock("@anthropic-ai/sdk");
  });

  it("returns a completed end_turn reply as-is", async () => {
    vi.resetModules();
    vi.doMock("@anthropic-ai/sdk", () => ({
      default: class {
        messages = {
          create: async () => ({
            stop_reason: "end_turn",
            content: [{ type: "text", text: '{"answer":"a","tag":"t","quote":"q"}' }],
          }),
        };
      },
    }));
    vi.stubEnv("ANTHROPIC_API_KEY", "test-key");
    const { anthropicReader: reader } = await import("../lib/reader");
    await expect(reader("p", "claude-sonnet-5")).resolves.toBe('{"answer":"a","tag":"t","quote":"q"}');
    vi.doUnmock("@anthropic-ai/sdk");
  });
});

describe("gemini reader", () => {
  it("sends the schema via responseFormat with low thinking, key in the header only", async () => {
    vi.stubEnv("GEMINI_API_KEY", "g-test");
    const calls = stubFetch(geminiReply(['{"answer":"x","tag":"t","quote":"q"}']));
    const out = await geminiReader("the prompt", "gemini-3.6-flash");
    expect(out).toBe('{"answer":"x","tag":"t","quote":"q"}');

    expect(calls[0].url).not.toContain("key="); // the key never rides the query string
    expect((calls[0].init.headers as Record<string, string>)["x-goog-api-key"]).toBe("g-test");
    expect(calls[0].init.signal).toBeInstanceOf(AbortSignal);
    const body = JSON.parse(String(calls[0].init.body));
    // The proto-enum name, NOT "application/json" — the MIME string draws a live 400
    // INVALID_ARGUMENT from generateContent (reproduced against the real API 2026-08-03).
    expect(body.generationConfig.responseFormat.text.mimeType).toBe("APPLICATION_JSON");
    expect(body.generationConfig.responseFormat.text.schema.additionalProperties).toBe(false);
    expect(body.generationConfig.thinkingConfig).toEqual({ thinkingLevel: "low" });
  });

  it("joins multiple parts byte-exact — a part boundary can fall inside a JSON string", async () => {
    // An inserted "\n" inside a string literal is an unescaped control character: the parse
    // fails and a completed, correct answer silently degrades to NOT IN BRAIN.
    vi.stubEnv("GEMINI_API_KEY", "g-test");
    stubFetch(geminiReply(['{"answer":"split acr', 'oss parts","tag":"","quote":""}']));
    await expect(geminiReader("p", "gemini-3.6-flash")).resolves.toBe(
      '{"answer":"split across parts","tag":"","quote":""}'
    );
  });

  it("fails loudly on a truncated generation even when text arrived", async () => {
    vi.stubEnv("GEMINI_API_KEY", "g-test");
    stubFetch(geminiReply(['{"answer":"cut'], "MAX_TOKENS"));
    await expect(geminiReader("p", "gemini-3.6-flash")).rejects.toThrow(/MAX_TOKENS/);
  });

  it("fails loudly when thinking ate the budget and parts came back empty", async () => {
    vi.stubEnv("GEMINI_API_KEY", "g-test");
    stubFetch({ candidates: [{ finishReason: "MAX_TOKENS", content: {} }] });
    await expect(geminiReader("p", "gemini-3.1-pro-preview")).rejects.toThrow(/MAX_TOKENS/);
  });

  it("surfaces a prompt-level block, which returns no candidates at all", async () => {
    vi.stubEnv("GEMINI_API_KEY", "g-test");
    stubFetch({ promptFeedback: { blockReason: "SAFETY" } });
    await expect(geminiReader("p", "gemini-3.6-flash")).rejects.toThrow(/blocked.*SAFETY/);
  });

  it("reports an HTTP error with its status", async () => {
    vi.stubEnv("GEMINI_API_KEY", "g-test");
    stubFetch("Service Unavailable", 503);
    await expect(geminiReader("p", "gemini-3.6-flash")).rejects.toThrow(/Gemini returned 503/);
  });

  it("redacts Google's key shape out of an invalid-key error body", async () => {
    vi.stubEnv("GEMINI_API_KEY", "g-test");
    stubFetch('{"error":{"message":"API key not valid: AIzaSyD-9tSrke72PouQMnMX-a7eZSW0jkFMBWY"}}', 400);
    const err = String(await geminiReader("p", "gemini-3.6-flash").catch((e: Error) => e));
    expect(err).toMatch(/Gemini returned 400/);
    expect(err).not.toContain("AIzaSyD");
    expect(err).toContain("<redacted-token>");
  });
});
