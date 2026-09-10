import { z } from "zod";

export type SettingsFamily = "reader" | "learning" | "guest";
type JsonObject = Record<string, unknown>;

// This module is deliberately client-safe. It mirrors the public Settings response domains
// without importing lib/reader (provider SDKs/process env), lib/guest (KV), or lib/learning
// (KV and corpus-related modules) into the browser bundle.
export const SETTINGS_READER_MODELS = [
  "claude-sonnet-5",
  "claude-opus-5",
  "claude-haiku-4-5",
  "gpt-5.6-sol",
  "gpt-5.6-terra",
  "gemini-3.6-flash",
  "gemini-3.1-pro-preview",
] as const;

export const SETTINGS_PROVIDERS = ["anthropic", "openai", "google"] as const;

const SETTINGS_READER_PROVIDER: Record<
  (typeof SETTINGS_READER_MODELS)[number],
  (typeof SETTINGS_PROVIDERS)[number]
> = {
  "claude-sonnet-5": "anthropic",
  "claude-opus-5": "anthropic",
  "claude-haiku-4-5": "anthropic",
  "gpt-5.6-sol": "openai",
  "gpt-5.6-terra": "openai",
  "gemini-3.6-flash": "google",
  "gemini-3.1-pro-preview": "google",
};

export const SETTINGS_LEARNING_BOUNDS = {
  ansCacheTtlDays: { min: 1, max: 30 },
  handoffBudget: { min: 4_000, max: 100_000 },
  coaccessFloor: { min: 2, max: 10 },
} as const;

export const SETTINGS_GUEST_BOUNDS = {
  dailyAsks: { min: 1, max: 1_000 },
  maxK: { min: 1, max: 40 },
} as const;

const readerModel = z.enum(SETTINGS_READER_MODELS);
const provider = z.enum(SETTINGS_PROVIDERS);
const providers = z.array(provider).refine(
  (items) => new Set(items).size === items.length,
  "providers must be unique",
);

const readerFields = {
  defaultReader: readerModel.nullable(),
  disabledProviders: providers,
};

const readerConsistent = (value: {
  defaultReader: (typeof SETTINGS_READER_MODELS)[number] | null;
  disabledProviders: (typeof SETTINGS_PROVIDERS)[number][];
}) =>
  value.defaultReader === null ||
  !value.disabledProviders.includes(SETTINGS_READER_PROVIDER[value.defaultReader]);

const readerCurrent = z.strictObject(readerFields).refine(
  readerConsistent,
  "the default reader provider cannot be disabled",
);

const readerReceipt = z.strictObject({
  ...readerFields,
  source: z.literal("store"),
  conflicts: z.array(z.string()),
}).refine(readerConsistent, "the default reader provider cannot be disabled");

const boundedInteger = (bounds: { readonly min: number; readonly max: number }) =>
  z.number().int().min(bounds.min).max(bounds.max);

const learningSelection = z.strictObject({
  ansCache: z.boolean().optional(),
  ansCacheTtlDays: boundedInteger(SETTINGS_LEARNING_BOUNDS.ansCacheTtlDays).optional(),
  handoffBudget: boundedInteger(SETTINGS_LEARNING_BOUNDS.handoffBudget).optional(),
  watchSupersededLink: z.boolean().optional(),
  watchCoaccessGap: z.boolean().optional(),
  watchCorrectionChain: z.boolean().optional(),
  watchOversizedPage: z.boolean().optional(),
  coaccessFloor: boundedInteger(SETTINGS_LEARNING_BOUNDS.coaccessFloor).optional(),
});

const learningReceipt = z.strictObject({
  ok: z.literal(true),
  learning: learningSelection,
});

const SCOPE_RE = /^(profile\.md|(projects|notes|log|history)\/([A-Za-z0-9._-]+\.md|[A-Za-z0-9._/-]*\/)?)$/;
const scopeEntry = z.string().refine(
  (value) => value.length > 0 && !value.includes("..") && SCOPE_RE.test(value),
  "scope entry must be an allowed exact note or directory prefix",
);

const guestPolicy = z.strictObject({
  revision:z.string().regex(/^[a-f0-9]{40}$/),
  scope: z.array(scopeEntry).min(1),
  citations: z.boolean(),
  dailyAsks: boundedInteger(SETTINGS_GUEST_BOUNDS.dailyAsks),
  maxK: boundedInteger(SETTINGS_GUEST_BOUNDS.maxK),
});

const guestReceipt = z.strictObject({
  ok: z.literal(true),
  guest: guestPolicy,
});

const readerSnapshot = z.strictObject({ family: z.literal("reader"), current: readerCurrent });
const learningSnapshot = z.strictObject({ family: z.literal("learning"), current: learningSelection });
const guestSnapshot = z.strictObject({ family: z.literal("guest"), current: guestPolicy });

/** Return the fully validated current family, or null without repairing an invalid response. */
export function parseSettingsReceipt(family: SettingsFamily, value: unknown): JsonObject | null {
  if (family === "reader") {
    const result = readerReceipt.safeParse(value);
    return result.success
      ? { defaultReader: result.data.defaultReader, disabledProviders: result.data.disabledProviders }
      : null;
  }
  if (family === "learning") {
    const result = learningReceipt.safeParse(value);
    return result.success ? result.data.learning : null;
  }
  const result = guestReceipt.safeParse(value);
  return result.success ? result.data.guest : null;
}

/** Validate both the family discriminant and the complete current-state DTO. */
export function parseSettingsSnapshot(family: SettingsFamily, value: unknown): JsonObject | null {
  if (family === "reader") {
    const result = readerSnapshot.safeParse(value);
    return result.success ? result.data.current : null;
  }
  if (family === "learning") {
    const result = learningSnapshot.safeParse(value);
    return result.success ? result.data.current : null;
  }
  const result = guestSnapshot.safeParse(value);
  return result.success ? result.data.current : null;
}
