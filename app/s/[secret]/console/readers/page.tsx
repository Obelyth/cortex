import { requireSecret } from "@/lib/gate";
import { readCalls } from "@/lib/calls";
import { readSettings, safeActiveReader, readerCards } from "@/lib/settings";
import { PROVIDERS, PROVIDER_KEY_ENV, providerConfigured, modelsOf } from "@/lib/reader";
import { DEFAULT_MODEL } from "@/lib/ask";
import { ReadersClient, type ReaderVM, type ProviderVM } from "./readers-client";
import styles from "../console.module.css";

export const dynamic = "force-dynamic";
export const maxDuration = 60;
export const metadata = { title: "Readers · Cortex console" };

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/**
 * Readers — which models may read this brain, which one does, and how each has actually
 * behaved. The screen that stopped this being a Claude brain and started it being a brain.
 *
 * An instrument, not a control panel: the registry facts and each reader's record are read off
 * the server and cannot be argued with; the controls live on the settings screen, their one
 * home. Where a panel cannot know
 * something — an unmeasured model, a reader with no calls yet, a store that is not configured
 * — it says so in that many words. An empty column here must never read as a zero.
 */
export default async function Readers({
  params,
}: {
  params: Promise<{ secret: string }>;
}) {
  await requireSecret(params);

  const settings = await readSettings();
  const { active, error: resolveError } = await safeActiveReader(settings);
  const cards = readerCards(settings, active);
  const activeProvider = cards.find((c) => c.isDefault)?.provider ?? null;

  const now = Date.now();
  const { rows, durable, source, covers } = await readCalls(86_400_000, now);
  const asks = rows.filter((r) => r.tool === "brain_ask");
  const attributed = asks.filter((r) => r.model);

  const readers: ReaderVM[] = cards.map((c) => {
    const mine = attributed.filter((r) => r.model === c.model);
    const ms = mine.map((r) => r.ms).sort((a, b) => a - b);
    return {
      model: c.model,
      provider: c.provider,
      configured: c.configured,
      disabled: c.disabled,
      evalState: c.eval.state,
      evalNote: c.eval.note,
      isDefault: c.isDefault,
      defaultSource: c.defaultSource ?? null,
      calls: mine.length,
      verified: mine.filter((r) => r.stamp === "VERIFIED").length,
      unverified: mine.filter((r) => r.stamp === "UNVERIFIED").length,
      errors: mine.filter((r) => r.stamp === "ERROR").length,
      // Median, not mean: one 45-second timeout would otherwise redefine a reader's typical
      // call, and the timeout is already on the row above as an error.
      p50: ms.length ? ms[Math.floor((ms.length - 1) / 2)] : null,
    };
  });

  const providers: ProviderVM[] = PROVIDERS.map((p) => ({
    provider: p,
    keyEnv: PROVIDER_KEY_ENV[p],
    configured: providerConfigured(p),
    disabled: settings.disabledProviders.includes(p),
    models: modelsOf(p).length,
  }));

  const envReader = process.env.READER_MODEL?.trim() || null;
  const unattributed = asks.length - attributed.length;
  const window =
    covers < 60_000
      ? "the log just started"
      : `the log covers ${covers < 3_600_000 ? `${Math.round(covers / 60_000)} min` : `${Math.round(covers / 3_600_000)} hr`}`;

  return (
    <div className={styles.screen}>
      <div className={styles.headRow}>
        <div>
          <div className={styles.label}>Reading as</div>
          <div className={styles.bigRow}>
            <span className={styles.activeModel}>{active ? active.model : "nothing"}</span>
          </div>
          <div className={styles.note}>
            {!active || !activeProvider
              ? "no reader resolves — brain_ask errors on every call until this is fixed"
              : `${
                  active.source === "console"
                    ? "set in settings"
                    : active.source === "env"
                      ? "from READER_MODEL in the environment"
                      : "the built-in default — nothing has overridden it"
                } · ${
                  providerConfigured(activeProvider)
                    ? "provider key present"
                    : "PROVIDER KEY MISSING — this reader will error on call"
                }`}
          </div>
        </div>
        <div className={styles.statTrio}>
          <div className={styles.stat}>
            <div className={styles.label}>Models wired</div>
            <div className={styles.statN}>{readers.length}</div>
            <div className={styles.note}>{PROVIDERS.length} providers</div>
          </div>
          <div className={styles.stat}>
            <div className={styles.label}>Keyed</div>
            <div className={styles.statN}>{providers.filter((p) => p.configured).length}</div>
            <div className={styles.note}>of {providers.length} providers</div>
          </div>
          <div className={styles.stat}>
            <div className={styles.label}>Measured</div>
            <div className={`${styles.statN} ${readers.some((r) => r.evalState === "unmeasured") ? styles.statWarn : ""}`}>
              {readers.filter((r) => r.evalState === "measured").length}
            </div>
            <div className={styles.note}>
              {readers.filter((r) => r.evalState !== "measured").length} unproven
            </div>
          </div>
        </div>
      </div>

      <div className={styles.rule} />

      <ReadersClient
        readers={readers}
        providers={providers}
        conflicts={resolveError ? [resolveError, ...settings.conflicts] : settings.conflicts}
        envReader={envReader}
        builtIn={DEFAULT_MODEL}
        usageNote={

          durable
            ? attributed.length === 0
              ? asks.length === 0
                ? "No brain_ask calls in the last 24 hours, so no reader has a record here yet. Empty means quiet, not broken."
                : `${plural(asks.length, "ask")} in this window, none attributed — logged before the model field shipped`
              : unattributed > 0
                ? `${attributed.length} of ${plural(asks.length, "ask")} attributed · ${unattributed} logged before the model field shipped`
                : `${plural(attributed.length, "ask")} in the last 24 hours${covers < 86_400_000 ? ` · ${window}` : ""}`
            : `${source === "unconfigured" ? "No durable call store is configured" : "The call store was unreachable"}, so this is one instance's in-memory log — usage here is a fragment, not the record.`
        }
      />
    </div>
  );
}
