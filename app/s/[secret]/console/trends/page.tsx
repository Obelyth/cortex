import { requireSecret } from "@/lib/gate";
import { readCalls } from "@/lib/calls";
import { readSettings, readerCards, safeActiveReader } from "@/lib/settings";
import { HOUR } from "@/lib/trends";
import { consoleHealth } from "../loaders";
import { buildTrendsVM, TrendsScreen } from "./trends-screen";
import "./trends.css";

export const dynamic = "force-dynamic";
export const maxDuration = 60;
export const metadata = { title: "Trends · Cortex console" };

/**
 * Trends (v2) — the pulse, the mirrored bars, the 24 h clock, the heat and the donut, fed by the
 * call log and captioned with the window the log really covers. The strip's token figure is
 * the memory read FOR each ask, server-side — what a session would have hauled in by hand
 * without the brain — estimated against today's corpus size and labelled est. Patterns render
 * only when their premise holds in the data. Every click opens the lens: a window of calls
 * (L9), a pattern's derivation (L10), a reader and its asks (L11).
 */
export default async function Trends({ params }: { params: Promise<{ secret: string }> }) {
  await requireSecret(params);
  const now = Date.now();
  const [calls48, life, h, settings] = await Promise.all([
    readCalls(48 * HOUR, now),
    readCalls(157_680_000_000, now),
    consoleHealth(),
    readSettings(),
  ]);
  const { active } = await safeActiveReader(settings);
  const vm = buildTrendsVM({
    now,
    calls48,
    life,
    corpusTokens: h.totals.tokens,
    readers: readerCards(settings, active).map((c) => ({
      model: c.model, provider: c.provider, configured: c.configured, disabled: c.disabled,
      evalState: c.eval.state, evalNote: c.eval.note, isDefault: c.isDefault,
    })),
    writable: settings.source === "store",
  });
  return <TrendsScreen vm={vm} />;
}
