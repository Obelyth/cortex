/**
 * reader — the one place a model is called on the read path.
 *
 * Kept separate from ask.ts so the whole answer pipeline stays testable without a key, and
 * so "which model reads the brain" is a deployment decision rather than something buried in
 * a tool definition. Egress is disclosed on every answer, same discipline as the retired
 * rerank path: a credential is not consent.
 *
 * PLUGGABLE, BY DESIGN. The brain's substrate — markdown, git, deterministic verification —
 * never depended on which model reads it, and this file is where that promise is kept: three
 * backends behind one contract (prompt in, schema-constrained JSON out, fail loudly on
 * anything else). The verifier downstream treats every reader identically, which is the
 * point — the trust comes from the verification, not from the model. The OpenAI and Gemini
 * paths are raw fetch on purpose: no SDK means no hidden retry policy, and a hidden retried
 * timeout is exactly what the Anthropic SDK path below had to be defended against.
 */
import Anthropic from "@anthropic-ai/sdk";
import type { Reader, ReaderPrompt } from "./ask";
import { DEFAULT_MODEL } from "./ask";
import { redact } from "./redact";

/** Must stay comfortably under the platform function ceiling (60s on Vercel). */
export const READER_TIMEOUT_MS = 45_000;

export type Provider = "anthropic" | "openai" | "google";

/**
 * Reader models this server will call, and who serves each. An open string let a caller
 * pick any model on the operator's key — a 3.3x price swing per call, chosen by whoever holds the
 * connector URL — so this registry is an allowlist first and a router second. IDs verified
 * against each provider's live model list 2026-08-03; gemini-3.1-pro-preview is the one
 * non-GA entry (Google ships no GA Gemini-3 Pro) and is listed as such.
 *
 * Claude readers carry the measured result (Sonnet/Opus 97% on the 185-label eval; Haiku
 * 47-98% across runs and not recommended). The OpenAI and Gemini readers are held to the
 * same contract but have NOT been run on the eval — the tool description says so. The
 * honest-data rule applies to model-quality claims exactly as it does to dashboard panels.
 *
 * The spread inside the allowlist is ~1.7x (sonnet -> opus on the measured pack), and one
 * leaked connector URL can now burn spend on up to three provider keys instead of one.
 * Accepted deliberately: the ceiling is the priciest allowlisted model, never attacker-
 * chosen, and the original 3.3x open-string hole stays closed.
 */
export const READER_MODEL_IDS = [
  "claude-sonnet-5",
  "claude-opus-5",
  "claude-haiku-4-5",
  "gpt-5.6-sol",
  "gpt-5.6-terra",
  "gemini-3.6-flash",
  "gemini-3.1-pro-preview",
] as const;
export type ReaderModel = (typeof READER_MODEL_IDS)[number];

const PROVIDER: Record<ReaderModel, Provider> = {
  "claude-sonnet-5": "anthropic",
  "claude-opus-5": "anthropic",
  "claude-haiku-4-5": "anthropic",
  "gpt-5.6-sol": "openai",
  "gpt-5.6-terra": "openai",
  "gemini-3.6-flash": "google",
  "gemini-3.1-pro-preview": "google",
};

export function providerOf(model: string): Provider | null {
  // Own-property check, not a bare index: a plain object literal inherits Object.prototype,
  // so PROVIDER["toString"] is a function and "__proto__" an object — either would sail
  // through a `?? null` and let resolveModel bless a nonsense model name.
  return Object.hasOwn(PROVIDER, model) ? PROVIDER[model as ReaderModel] : null;
}

/** Every provider this server routes to, in registry order. */
export const PROVIDERS = ["anthropic", "openai", "google"] as const;

/**
 * Which env var carries each provider's credential. Declared once so the console reports
 * "configured" from the same fact the backends read — a second list of key names is a second
 * thing to keep true, and the one that goes stale is always the one nobody calls.
 */
export const PROVIDER_KEY_ENV: Record<Provider, string> = {
  anthropic: "ANTHROPIC_API_KEY",
  openai: "OPENAI_API_KEY",
  google: "GEMINI_API_KEY",
};

/** Whether a provider's key is present. Never reports the value, only that there is one. */
export function providerConfigured(p: Provider): boolean {
  return Boolean(process.env[PROVIDER_KEY_ENV[p]]?.trim());
}

export function modelsOf(p: Provider): ReaderModel[] {
  return READER_MODEL_IDS.filter((m) => PROVIDER[m] === p);
}

/**
 * What has actually been MEASURED, per model, on the 185-label eval — and, just as loudly,
 * what has not. The honest-data rule governs model-quality claims exactly as it governs
 * dashboard panels: an unmeasured reader must never borrow the credibility of a measured one
 * just by sitting in the same list. Three surfaces quote this (the tool description, the
 * README, the console), so it lives in one place; three copies of a measurement is three
 * chances to keep quoting a number after it stops being true.
 *
 * "unstable" is its own state rather than a footnote on "measured": Haiku's 47-98% spread
 * across runs is not a low score, it is an unreliable one, and those fail differently.
 */
export type EvalState = "measured" | "unstable" | "unmeasured";
export const EVAL: Record<ReaderModel, { state: EvalState; note: string }> = {
  "claude-sonnet-5": { state: "measured", note: "97% on 185 labels" },
  "claude-opus-5": { state: "measured", note: "97% on 185 labels" },
  "claude-haiku-4-5": { state: "unstable", note: "47-98% across runs — not recommended" },
  "gpt-5.6-sol": { state: "unmeasured", note: "wired, never run on the eval" },
  "gpt-5.6-terra": { state: "unmeasured", note: "wired, never run on the eval" },
  "gemini-3.6-flash": { state: "unmeasured", note: "wired, never run on the eval" },
  "gemini-3.1-pro-preview": { state: "unmeasured", note: "preview model; never run on the eval" },
};

/**
 * Which model reads, resolved in order: the caller's explicit pick, then the deployment's
 * READER_MODEL, then the measured default. Every step must land on the allowlist or throw —
 * a typo'd READER_MODEL failing loudly on first use beats silently reading with a different
 * model than the deployment asked for. An empty or whitespace READER_MODEL (the natural
 * state of a placeholder line in .env) reads as unset, not as a model named "".
 */
export function resolveModel(requested?: string): ReaderModel {
  const env = process.env.READER_MODEL?.trim();
  const pick = requested ?? (env || undefined) ?? DEFAULT_MODEL;
  if (!providerOf(pick)) {
    const src = requested !== undefined ? "requested model" : "READER_MODEL";
    throw new Error(
      `${src} "${pick}" is not an allowed reader model — allowed: ${READER_MODEL_IDS.join(", ")}`
    );
  }
  return pick as ReaderModel;
}

/**
 * The answer contract, as a schema the API ENFORCES rather than a paragraph the model may
 * ignore. On its first contact with a real model the prose contract lost: Sonnet returned a
 * markdown answer with `**Tag:**` and `**Quote:**` headings instead of JSON, so parseReply
 * found no object, ask() saw an empty tag, and a correct, well-sourced answer rendered as
 * NOT IN BRAIN with no verification run at all. Asking politely for JSON is not a contract.
 *
 * Written as a plain JSON Schema rather than through the SDK's zod helper: that helper is
 * built against zod v4 and this project is on 3.25, so the typed path does not compile here.
 * `additionalProperties: false` and a complete `required` list are both mandatory for
 * structured outputs — and happen to be exactly what OpenAI's strict mode and Gemini's
 * schema subset require too, so all three backends enforce the same shape verbatim.
 */
const REPLY_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: {
    answer: { type: "string", description: "The answer in <=3 sentences, faithful to the corpus." },
    tag: {
      type: "string",
      description: 'The TAG of the file the answer came from, copied exactly, or "" if none.',
    },
    quote: {
      type: "string",
      description: 'A VERBATIM sentence from that file supporting the answer, or "".',
    },
  },
  required: ["answer", "tag", "quote"],
  additionalProperties: false,
};

/**
 * Enough room for adaptive thinking AND the answer. `max_tokens` caps the two together, and
 * thinking is on by default on Sonnet 5 and Opus 5 — at the old 1024 a long verbatim quote
 * could be truncated by reasoning that ran first, which reads downstream as an unverifiable
 * citation rather than as a truncation.
 */
const MAX_TOKENS = 8192;

/**
 * OpenAI bills reasoning as output inside max_output_tokens and the gpt-5.6 family reasons
 * by default, so the Anthropic-sized cap could be eaten whole before a message item exists.
 * Effort is pinned low — fact extraction over a provided pack is the workload OpenAI's own
 * guidance points at low — and the cap is doubled as headroom.
 */
const OPENAI_MAX_OUTPUT_TOKENS = 16_384;
/** Gemini 3 thinks by default inside maxOutputTokens too; level "low" per the docs'
 *  fact-retrieval guidance, with the same budget the Anthropic path uses. */
const GEMINI_MAX_OUTPUT_TOKENS = 8192;

/** Error bodies ride along for diagnosis — flattened, capped, and passed through the egress
 *  redactor first: a provider's invalid-key error can echo a recognisable slice of the key
 *  it rejected, and that must not ride an error message out to whoever made the call. */
function snip(s: string): string {
  const t = redact(s).replace(/\s+/g, " ").trim();
  return t ? ` — ${t.slice(0, 240)}` : "";
}

/**
 * One POST against the reader's deadline, returning parsed JSON or throwing an error that
 * names the model and provider. AbortSignal.timeout is the whole retry policy: zero retries,
 * one budget, same 45s the Anthropic client is pinned to.
 */
async function postJson(
  model: string,
  provider: string,
  url: string,
  headers: Record<string, string>,
  body: unknown
): Promise<unknown> {
  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(READER_TIMEOUT_MS),
    });
  } catch (e) {
    const why =
      e instanceof Error && e.name === "TimeoutError"
        ? `no response within ${READER_TIMEOUT_MS / 1000}s`
        : e instanceof Error
          ? e.message
          : String(e);
    throw new Error(`reader ${model}: ${provider} request failed — ${why}`);
  }
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`reader ${model}: ${provider} returned ${res.status}${snip(text)}`);
  }
  // A 200 with a non-JSON body (proxy interstitial, CDN error page) makes res.json() throw
  // V8's SyntaxError, which since Node 20 EMBEDS a raw slice of the body in its message —
  // an unredacted, unlabelled channel straight to the caller. Shape it here instead.
  try {
    return await res.json();
  } catch {
    throw new Error(`reader ${model}: ${provider} returned unparseable JSON`);
  }
}

/**
 * One user turn, split at the prompt-cache boundary. The stable prefix (contract + note pack)
 * carries the breakpoint; the question rides after it, so five questions at the same commit
 * pay the pack's tokens once (+25% on the write) and read it at ~10% thereafter. An empty
 * stable part degrades to a single uncached block — the API rejects empty text blocks, and a
 * breakpoint on nothing would be a cache entry for nothing.
 */
function splitContent(prompt: ReaderPrompt): Anthropic.TextBlockParam[] {
  if (!prompt.stable) return [{ type: "text", text: prompt.question }];
  return [
    { type: "text", text: prompt.stable, cache_control: { type: "ephemeral" } },
    { type: "text", text: prompt.question },
  ];
}

/** Fails loudly rather than degrading to a worse answer — a brain that quietly stops
 *  citing is harder to notice than one that errors. */
export const anthropicReader: Reader = async (prompt, model) => {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) throw new Error("ANTHROPIC_API_KEY not set — brain_ask needs a reader model");
  // The SDK default timeout is 600s and timeouts are RETRIED, so an unbounded client can sit
  // for 20 minutes behind a function that Vercel kills at 60. The caller would get a gateway
  // timeout page instead of JSON-RPC — a protocol error with no explanation, and no way to
  // tell whether Anthropic was billed. Budget inside the wall instead: corpus fetch is ~1.5s
  // cold, so 45s leaves headroom to return a real error. maxRetries is ZERO because the
  // timeout is per ATTEMPT — one retry stacks 45s twice behind the same 60s wall, which is
  // the exact failure the budget exists to prevent. Same policy the raw-fetch backends get
  // from AbortSignal: one call, one budget.
  const client = new Anthropic({ apiKey: key, maxRetries: 0, timeout: READER_TIMEOUT_MS });

  const res = await client.messages.create({
    model,
    max_tokens: MAX_TOKENS,
    output_config: { format: { type: "json_schema", schema: REPLY_SCHEMA } },
    messages: [{ role: "user", content: splitContent(prompt) }],
  });

  const text = res.content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("\n");

  // An empty completion is a MODEL failure, and reporting it as "" makes ask() render it as
  // NOT IN BRAIN — a broken call becomes indistinguishable from a genuine absence, which is
  // the one confusion this system exists to prevent. Fail loudly instead. And not only on
  // emptiness: thinking shares max_tokens with the answer on Sonnet 5 / Opus 5, so a long
  // thinking pass can cut the JSON off MID-EMISSION — non-empty text, stop_reason
  // "max_tokens", unparseable downstream, rendered as NOT IN BRAIN. Every backend holds the
  // same line: anything short of a completed answer throws.
  if (!text.trim() || res.stop_reason !== "end_turn") {
    throw new Error(`reader ${model} returned no usable answer (stop_reason: ${res.stop_reason})`);
  }
  return text;
};

/**
 * OpenAI backend, on /v1/responses — the endpoint OpenAI recommends for new integrations
 * (chat/completions survives, but its interactions with reasoning are the documented rough
 * edge). Same schema, enforced as a strict json_schema text format.
 */
export const openaiReader: Reader = async (prompt, model) => {
  const key = process.env.OPENAI_API_KEY;
  if (!key) throw new Error(`OPENAI_API_KEY not set — reader model ${model} needs it`);
  const data = (await postJson(
    model,
    "OpenAI",
    "https://api.openai.com/v1/responses",
    { authorization: `Bearer ${key}` },
    {
      model,
      // Stable pack first, question last — OpenAI's caching is implicit and prefix-matched,
      // so the ordering alone is what lets repeat packs cache; no explicit marker exists.
      input: [{ role: "user", content: prompt.stable + prompt.question }],
      text: {
        format: { type: "json_schema", name: "brain_reply", strict: true, schema: REPLY_SCHEMA },
      },
      reasoning: { effort: "low" },
      max_output_tokens: OPENAI_MAX_OUTPUT_TOKENS,
    }
  )) as {
    status?: string;
    incomplete_details?: { reason?: string };
    output?: Array<{
      type?: string;
      content?: Array<{ type?: string; text?: string; refusal?: string }>;
    }>;
  };

  const message = (data.output ?? []).find((o) => o?.type === "message");
  const parts = message?.content ?? [];
  const refusal = parts.find((p) => p?.type === "refusal");
  if (refusal) {
    // Refusal text is model-generated provider content — through the same redact-and-cap
    // path as an error body before it rides a thrown message out.
    throw new Error(`reader ${model} refused to answer${snip(refusal.refusal ?? "")}`);
  }
  // Joined with "" — a part boundary can fall INSIDE a JSON string literal, where an
  // inserted "\n" is an unescaped control character that breaks the parse and silently
  // degrades a completed answer to NOT IN BRAIN. Between tokens, "" is equally safe.
  const text = parts
    .filter((p) => p?.type === "output_text")
    .map((p) => p.text ?? "")
    .join("");
  // Reasoning can consume the whole budget before any message item exists, and an incomplete
  // response is a truncation, not an answer. Same rule as every reader: fail loudly, because
  // an empty "" downstream renders as NOT IN BRAIN and a broken call must never look like a
  // genuine absence.
  if (!text.trim() || data.status === "incomplete") {
    const why = data.incomplete_details?.reason ?? data.status ?? "no message item";
    throw new Error(`reader ${model} returned no usable answer (${why})`);
  }
  return text;
};

/**
 * Gemini backend, on v1beta generateContent with the current responseFormat schema shape.
 * The key travels in the x-goog-api-key header — never the query string, where it would land
 * in access logs.
 */
export const geminiReader: Reader = async (prompt, model) => {
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new Error(`GEMINI_API_KEY not set — reader model ${model} needs it`);
  const data = (await postJson(
    model,
    "Gemini",
    `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`,
    { "x-goog-api-key": key },
    {
      // Same pack-before-question ordering as the OpenAI path: Gemini's implicit caching is
      // prefix-matched too, and the ordering is the whole opt-in.
      contents: [{ role: "user", parts: [{ text: prompt.stable + prompt.question }] }],
      generationConfig: {
        // mimeType is a PROTO ENUM, not a MIME string — "application/json" draws a live 400
        // INVALID_ARGUMENT from generateContent (verified against the real API 2026-08-03;
        // the lowercase form belongs to the separate Interactions API only).
        responseFormat: { text: { mimeType: "APPLICATION_JSON", schema: REPLY_SCHEMA } },
        thinkingConfig: { thinkingLevel: "low" },
        maxOutputTokens: GEMINI_MAX_OUTPUT_TOKENS,
      },
    }
  )) as {
    promptFeedback?: { blockReason?: string };
    candidates?: Array<{
      finishReason?: string;
      content?: { parts?: Array<{ text?: string }> };
    }>;
  };

  // A prompt-level block returns no candidates at all; a generation cut off by MAX_TOKENS
  // can return truncated JSON that still has text. Both must fail loudly: truncated JSON
  // would fall through parseReply as a citation-less answer and render as NOT IN BRAIN.
  if (data.promptFeedback?.blockReason) {
    throw new Error(`reader ${model} blocked the prompt (${data.promptFeedback.blockReason})`);
  }
  const cand = data.candidates?.[0];
  // Joined with "" for the same reason as the OpenAI path: a part boundary inside a JSON
  // string must not gain a raw newline.
  const text = (cand?.content?.parts ?? []).map((p) => p?.text ?? "").join("");
  if (!text.trim() || (cand?.finishReason && cand.finishReason !== "STOP")) {
    throw new Error(
      `reader ${model} returned no usable answer (finishReason: ${cand?.finishReason ?? "none"})`
    );
  }
  return text;
};

/**
 * The pluggable reader: one contract, routed by model ID. ask() stays reader-agnostic and
 * the registry above is the only place a new provider is ever added.
 */
export const modelReader: Reader = async (prompt, model) => {
  switch (providerOf(model)) {
    case "anthropic":
      return anthropicReader(prompt, model);
    case "openai":
      return openaiReader(prompt, model);
    case "google":
      return geminiReader(prompt, model);
    default:
      throw new Error(
        `unknown reader model "${model}" — allowed: ${READER_MODEL_IDS.join(", ")}`
      );
  }
};
