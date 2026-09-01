import { readSettings } from "@/lib/settings";
import { PROVIDERS, PROVIDER_KEY_ENV, providerConfigured } from "@/lib/reader";
import { WEAK_TOKEN_LENGTH } from "@/lib/auth";
import { DEFAULT_MODEL, DEFAULT_K } from "@/lib/ask";
import styles from "./console.module.css";

/**
 * Deployment — what this environment IS, moved off Settings.
 *
 * It sat under a screen of controls while being the one block on it nobody can act on: env is
 * not editable from a browser, by design. A read-only row among switches teaches that some rows
 * here just do not respond, which is the wrong lesson for the screen that holds the real ones.
 * It belongs with the other system state, on the screen whose whole job is "confirm it's alive".
 *
 * Two laws, inherited and absolute:
 *   PRESENCE, NEVER VALUES. No secret is displayed, stored or accepted. Env rows render as
 *   set / not set; repo and branch may show their values because they are addresses, not
 *   credentials.
 *   THE STORE IS NOT THE AUTHORITY. When KV is absent or unreachable this says so and shows what
 *   the deployment falls back to, rather than pretending.
 */
export async function Deployment() {
  const settings = await readSettings();
  const mcpToken = process.env.MCP_TOKEN?.trim() ?? "";
  const guestOpen = Boolean(process.env.GUEST_PATH_SECRET?.trim());

  const rows: Array<{ k: string; v: string; warn?: boolean }> = [
    { k: "BRAIN_REPO", v: process.env.BRAIN_REPO ?? "not set", warn: !process.env.BRAIN_REPO },
    { k: "BRAIN_BRANCH", v: process.env.BRAIN_BRANCH ?? "main" },
    { k: "BRAIN_TZ", v: process.env.BRAIN_TZ ?? "UTC" },
    {
      k: "MCP_TOKEN",
      v: !mcpToken
        ? "not set — bearer door closed"
        : mcpToken.length < WEAK_TOKEN_LENGTH
          ? `set · shorter than ${WEAK_TOKEN_LENGTH} chars — rotate to something longer`
          : "set",
      warn: !mcpToken || mcpToken.length < WEAK_TOKEN_LENGTH,
    },
    { k: "CONNECTOR_PATH_SECRET", v: "set — this console rides it" },
    { k: "GUEST_PATH_SECRET", v: guestOpen ? "set — guest door exists" : "not set — guest door inert" },
    ...PROVIDERS.map((p) => ({
      k: PROVIDER_KEY_ENV[p],
      v: providerConfigured(p) ? "set" : "not set",
      warn: p === "anthropic" && !providerConfigured(p),
    })),
    {
      k: "KV store",
      v:
        settings.source === "store"
          ? "connected"
          : settings.source === "unconfigured"
            ? "not configured — the controls on Settings have nowhere to write"
            : "unreachable this render — controls held, env defaults in force",
      warn: settings.source !== "store",
    },
    { k: "READER_MODEL", v: process.env.READER_MODEL?.trim() || `not set — built-in ${DEFAULT_MODEL}` },
    { k: "built-in defaults", v: `${DEFAULT_MODEL} · k=${DEFAULT_K}` },
    { k: "SENTRY_DSN", v: process.env.SENTRY_DSN ? "set — error reporting on" : "not set" },
  ];

  return (
    <section className="card">
      <div className="setHead">
        <span className={styles.label}>Deployment</span>
        <span className="setHeadMeta">read-only · env is not editable from a browser, by design</span>
      </div>
      <div className={styles.depGrid}>
        {rows.map((d) => (
          <div key={d.k} className={styles.depRow}>
            <span className={styles.mono}>{d.k}</span>
            <span className={d.warn ? styles.depWarn : styles.depVal}>{d.v}</span>
          </div>
        ))}
      </div>
    </section>
  );
}
