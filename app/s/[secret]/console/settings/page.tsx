import { requireSecret } from "@/lib/gate";
import { readSettings, safeActiveReader, readerCards } from "@/lib/settings";
import { readGuestPolicy } from "@/lib/guest";
import { listProposals } from "@/lib/proposals";
import { PROVIDERS, PROVIDER_KEY_ENV, providerConfigured } from "@/lib/reader";
import { WEAK_TOKEN_LENGTH } from "@/lib/auth";
import { DEFAULT_MODEL, DEFAULT_K } from "@/lib/ask";
import { SettingsClient, type SettingsVM } from "./settings-client";
import styles from "../console.module.css";

export const dynamic = "force-dynamic";
export const maxDuration = 60;
export const metadata = { title: "Settings · Cortex console" };

/**
 * Settings — every control in one place, and only the controls.
 *
 * The knobs had scattered: reader default and provider switches on the readers screen, guest
 * policy in its rail, appearance in the ribbon, and half the deployment story visible nowhere.
 * This screen is their one home. The instrument screens stay instruments — they show what IS;
 * this screen holds what SHOULD BE.
 *
 * Two laws, inherited and absolute:
 *   PRESENCE, NEVER VALUES. No secret is displayed, stored, or accepted here. Env rows render
 *   as set / not set; the two non-secret identity rows (repo, branch) may show their values
 *   because they are addresses, not credentials.
 *   THE STORE IS NOT THE AUTHORITY. Controls write to KV; when KV is absent or unreachable the
 *   screen says so and shows what the deployment falls back to, rather than pretending.
 */
export default async function Settings({
  params,
}: {
  params: Promise<{ secret: string }>;
}) {
  await requireSecret(params);

  const settings = await readSettings();
  const { active, error: resolveError } = await safeActiveReader(settings);
  const cards = readerCards(settings, active);
  const guest = await readGuestPolicy();
  const queue = await listProposals().catch(() => []);

  const vm: SettingsVM = {
    writable: settings.source === "store",
    storeState: settings.source,
    conflicts: resolveError ? [resolveError, ...settings.conflicts] : settings.conflicts,
    readers: cards.map((c) => ({
      model: c.model,
      provider: c.provider,
      configured: c.configured,
      disabled: c.disabled,
      evalState: c.eval.state,
      isDefault: c.isDefault,
      defaultSource: c.defaultSource ?? null,
    })),
    providers: PROVIDERS.map((p) => ({
      provider: p,
      keyEnv: PROVIDER_KEY_ENV[p],
      configured: providerConfigured(p),
      disabled: settings.disabledProviders.includes(p),
      holdsDefault: p === cards.find((c) => c.isDefault)?.provider,
    })),
    guest: {
      open: Boolean(process.env.GUEST_PATH_SECRET?.trim()),
      kvReady: settings.source === "store",
      scope: guest.scope,
      citations: guest.citations,
      dailyAsks: guest.dailyAsks,
      maxK: guest.maxK,
      usedToday: guest.usedToday,
      queued: queue.length,
    },
  };

  // Deployment rows are server-rendered and read-only: they describe env, and env is not
  // editable from a browser by design. Presence only for anything secret-shaped.
  const mcpToken = process.env.MCP_TOKEN?.trim() ?? "";
  const deployment: Array<{ k: string; v: string; warn?: boolean }> = [
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
    {
      k: "GUEST_PATH_SECRET",
      v: vm.guest.open ? "set — guest door exists" : "not set — guest door inert",
    },
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
            ? "not configured — controls on this screen have nowhere to write"
            : "unreachable this render — controls held, env defaults in force",
      warn: settings.source !== "store",
    },
    { k: "READER_MODEL", v: process.env.READER_MODEL?.trim() || `not set — built-in ${DEFAULT_MODEL}` },
    { k: "built-in defaults", v: `${DEFAULT_MODEL} · k=${DEFAULT_K}` },
    { k: "SENTRY_DSN", v: process.env.SENTRY_DSN ? "set — error reporting on" : "not set" },
  ];

  return (
    <div className={styles.screen}>
      <SettingsClient vm={vm} />

      <div className={styles.rule} />

      <section>
        <div className={styles.sectionHead}>
          <span className={styles.label}>Deployment</span>
          <span className={styles.note}>read-only — env is not editable from a browser, by design</span>
        </div>
        <div className={styles.depGrid}>
          {deployment.map((d) => (
            <div key={d.k} className={styles.depRow}>
              <span className={styles.mono}>{d.k}</span>
              <span className={d.warn ? styles.depWarn : styles.depVal}>{d.v}</span>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}
