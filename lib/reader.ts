/**
 * reader — the one place a model is called on the read path.
 *
 * Kept separate from ask.ts so the whole answer pipeline stays testable without a key, and
 * so "which model reads the brain" is a deployment decision rather than something buried in
 * a tool definition. Egress is disclosed on every answer, same discipline as the retired
 * rerank path: a credential is not consent.
 */
import Anthropic from "@anthropic-ai/sdk";
import type { Reader } from "./ask";

/** Must stay comfortably under the platform function ceiling (60s on Vercel). */
export const READER_TIMEOUT_MS = 45_000;

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
 * structured outputs.
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

/** Fails loudly rather than degrading to a worse answer — a brain that quietly stops
 *  citing is harder to notice than one that errors. */
export const anthropicReader: Reader = async (prompt, model) => {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) throw new Error("ANTHROPIC_API_KEY not set — brain_ask needs a reader model");
  // The SDK default timeout is 600s and timeouts are RETRIED, so an unbounded client can sit
  // for 20 minutes behind a function that Vercel kills at 60. The caller would get a gateway
  // timeout page instead of JSON-RPC — a protocol error with no explanation, and no way to
  // tell whether Anthropic was billed. Budget inside the wall instead: corpus fetch is ~1.5s
  // cold, so 45s leaves headroom to return a real error.
  const client = new Anthropic({ apiKey: key, maxRetries: 1, timeout: READER_TIMEOUT_MS });

  const res = await client.messages.create({
    model,
    max_tokens: MAX_TOKENS,
    output_config: { format: { type: "json_schema", schema: REPLY_SCHEMA } },
    messages: [{ role: "user", content: prompt }],
  });

  const text = res.content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("\n");

  // An empty completion is a MODEL failure, and reporting it as "" makes ask() render it as
  // NOT IN BRAIN — a broken call becomes indistinguishable from a genuine absence, which is
  // the one confusion this system exists to prevent. Fail loudly instead. A refusal or a
  // truncation lands here too: the schema constrains a completed response, it does not
  // guarantee one arrives.
  if (!text.trim()) {
    throw new Error(`reader ${model} returned no answer (stop_reason: ${res.stop_reason})`);
  }
  return text;
};
