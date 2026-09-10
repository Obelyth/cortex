import type { ConfigurationCapability } from "../../../../../lib/console-configuration-contract";

/**
 * What each env row is for, where its value comes from, and how it gets set — the steps the
 * console can honestly walk you through.
 *
 * It cannot walk you through all of it. Capability-specific forms may send complete write-only
 * groups to the fixed provider project, but this reference still covers console, path, passcode,
 * monitoring and other one-time authority that must be set out of band. No value is displayed or
 * read back, and every environment change needs a separate explicit deployment before it is active.
 *
 * A step must set the WHOLE feature. The connector and guest paths also need the server bearer;
 * the mirror also needs SUPABASE_SERVICE_ROLE_KEY (lib/mirror.ts), the store needs
 * KV_REST_API_TOKEN (lib/kv.ts), and mail needs OPS_ALERT_TO (lib/mail.ts). Handing over only the
 * row's headline variable is worse than handing over nothing: readiness.ts keeps the row held and
 * names every missing prerequisite, while each command below installs every variable its row
 * claims to govern.
 */
export interface SetupStep {
  /** Plain words: what this unlocks, and what the console does without it. */
  unlocks: string;
  /** Where the value is minted, when it is minted somewhere. */
  mint?: { label: string; href: string };
  /** The exact line that installs it, ready to copy. */
  command: string;
  /** Existing write-only editor, when this screen includes capability configuration. */
  capability?: ConfigurationCapability;
}

const vercelAdd = (name: string) => `vercel env add ${name} production`;

export const SETUP: Record<string, SetupStep> = {
  MCP_TOKEN: {
    unlocks:
      "The bearer every door checks. Without it the terminal door answers 401 (lib/auth.ts hands withMcpAuth no identity) while the Claude-app connector and the guest door answer 404, because a path secret is checked before a bearer and a wrong path must never confirm that anything lives there. No assistant reaches the brain either way, however set their own secrets are.",
    command: `openssl rand -hex 32 | ${vercelAdd("MCP_TOKEN")}`,
  },
  CONNECTOR_PATH_SECRET: {
    unlocks:
      "The path segment this console and the header-less connector live behind. Without it both 404 and the root stops redirecting.",
    command: `openssl rand -hex 32 | ${vercelAdd("CONNECTOR_PATH_SECRET")}\nopenssl rand -hex 32 | ${vercelAdd("MCP_TOKEN")}`,
  },
  GUEST_PATH_SECRET: {
    unlocks:
      "The guest door, where an assistant may ask and propose and nothing more. Unset means no guest door — which is a fine state to be in. It must differ from the connector secret; the route refuses them equal.",
    command: `openssl rand -hex 32 | ${vercelAdd("GUEST_PATH_SECRET")}\nopenssl rand -hex 32 | ${vercelAdd("MCP_TOKEN")}`,
  },
  CONSOLE_PASSCODE: {
    unlocks:
      "What stamps a device so it stays signed in. Rotating it re-prompts every device, which is the point.",
    command: vercelAdd("CONSOLE_PASSCODE"),
  },
  SUPABASE_URL: {
    capability: "mirror",
    unlocks:
      "Connects the database used for the notes mirror, handoffs, Devices and Ops history. Without it Cortex falls back to reading the notes repository and database-backed features are unavailable. Both the project URL and service role key are required; their presence does not prove the database is reachable or its schema is up to date.",
    mint: { label: "Supabase project settings", href: "https://supabase.com/dashboard/project/_/settings/api" },
    command: `${vercelAdd("SUPABASE_URL")}\n${vercelAdd("SUPABASE_SERVICE_ROLE_KEY")}`,
  },
  KV_REST_API_URL: {
    capability: "cache",
    unlocks:
      "Stores saved preferences, cached answers, guest budgets, proposals and notice read marks. Both the REST URL and token are required. Without this store, reader and memory preferences use deployment defaults; guest access stays closed.",
    mint: { label: "Upstash console", href: "https://console.upstash.com/" },
    command: `${vercelAdd("KV_REST_API_URL")}\n${vercelAdd("KV_REST_API_TOKEN")}`,
  },
  RESEND_API_KEY: {
    capability: "alerts",
    unlocks:
      "Ops alert mail needs the exact environment names RESEND_API_KEY and OPS_ALERT_TO. Paste the Resend API key value and the recipient email address; an integration's CORTEX_RESEND_API_KEY and Resend Contacts do not supply those settings. The dashboard saves a complete three-field group, so OPS_ALERT_FROM is required in its form. Use that exact singular name for a sender address or Name <email@example.com>. Manual provider setup can omit OPS_ALERT_FROM and use Resend's onboarding sender. Saving these values requires a separate deployment and does not test mail delivery.",
    mint: { label: "Resend API keys", href: "https://resend.com/api-keys" },
    command: `${vercelAdd("RESEND_API_KEY")}\n${vercelAdd("OPS_ALERT_TO")}\n${vercelAdd("OPS_ALERT_FROM")}`,
  },
  SENTRY_DSN: {
    unlocks: "Error reporting. Unset means errors are logged to the platform and nowhere else.",
    mint: { label: "Sentry client keys", href: "https://sentry.io/settings/projects/" },
    command: vercelAdd("SENTRY_DSN"),
  },
};

/* Keyed to the rows settings/page.tsx actually builds, and no others. It also carried steps for
   ANTHROPIC_API_KEY, OPENAI_API_KEY and GEMINI_API_KEY, which no door row names — setupFor is
   called only from DoorFold and DoorFold is rendered only over p.doors, so those three folds could
   never be opened by anyone, while still shipping their prose and links in the client bundle. If a
   reader-key row is ever added to p.doors, its steps come back with it. */

/** The env row labels carry a middle dot for the pair; the setup table is keyed by the bare name. */
export function setupFor(label: string): SetupStep | null {
  return SETUP[label.split(" · ")[0]] ?? null;
}
