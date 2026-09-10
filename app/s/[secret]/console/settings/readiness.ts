export const FEATURE_REQUIREMENTS = {
  MCP_TOKEN: ["MCP_TOKEN"],
  CONNECTOR_PATH_SECRET: ["CONNECTOR_PATH_SECRET", "MCP_TOKEN"],
  GUEST_PATH_SECRET: ["GUEST_PATH_SECRET", "MCP_TOKEN"],
  CONSOLE_PASSCODE: ["CONSOLE_PASSCODE"],
  SUPABASE_URL: ["SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY"],
  KV_REST_API_URL: ["KV_REST_API_URL", "KV_REST_API_TOKEN"],
  RESEND_API_KEY: ["RESEND_API_KEY", "OPS_ALERT_TO"],
  SENTRY_DSN: ["SENTRY_DSN"],
} as const;

export type FeatureName = keyof typeof FEATURE_REQUIREMENTS;

export interface FeatureReadiness {
  ready: boolean;
  /** Variable names only. Values never leave the server-side input. */
  missing: string[];
}

/** Reduce server-only env values to the only client-safe readiness facts. */
export function featureReadiness(
  feature: FeatureName,
  env: Readonly<Record<string, string | undefined>>,
): FeatureReadiness {
  const missing = FEATURE_REQUIREMENTS[feature].filter((name) => !env[name]?.trim());
  return { ready: missing.length === 0, missing };
}
