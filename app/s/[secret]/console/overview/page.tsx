import { requireSecret } from "@/lib/gate";
import { consoleHealth } from "../loaders";
import { previewContext } from "@/lib/brain";
import { listCommits, type CommitInfo } from "@/lib/github";
import { readCalls } from "@/lib/calls";
import { readSettings, safeActiveReader, readerCards } from "@/lib/settings";
import { mirrorPulse, accessPulse, temperaturePulse } from "@/lib/pulse";
import { providerConfigured, providerOf } from "@/lib/reader";
import { activity, checkedOut, doors, dotField, noteLite, pipeline, saves, windowLabel, type NoteLite } from "@/lib/overview";
import { OverviewScreen, type OverviewProps } from "./overview-screen";
import "./overview.css";

export const dynamic = "force-dynamic";
export const maxDuration = 60;
export const metadata = { title: "Overview · Cortex console" };

const THIRTY_DAYS = 2_592_000_000;

/**
 * Overview — v2. The loaders WIRING.md names, read once each (health through the request cache
 * the layout shares), derived by lib/overview.ts into the shapes the screen draws. What changed
 * from the canvas is only what honesty requires: every number states the window it covers, and
 * a source that is off says so instead of rendering a zero.
 */
export default async function Overview({ params }: { params: Promise<{ secret: string }> }) {
  await requireSecret(params);
  const now = Date.now();
  const [h, callWin, settings, mirror, reads, temps, boot, commits] = await Promise.all([
    consoleHealth(),
    readCalls(THIRTY_DAYS, now),
    readSettings(),
    mirrorPulse(),
    accessPulse(),
    temperaturePulse(),
    // The real boot payload, so the ring measures what a session pays rather than estimating
    // it. Failing soft matters here more than most: a console that 500s because it could not
    // price itself would be reporting a problem by becoming one.
    previewContext().catch(() => null),
    // In the batch, not after it. Awaited on its own this appended a full GitHub round trip to
    // TTFB, and gh()'s default budget is 15 s (lib/github.ts:24) — so one hung socket held the
    // whole screen, which is the failure lib/pulse.ts:70 already refuses for its own GitHub call.
    // The saves panel states its own degraded mode, so an empty list is a complete answer.
    listCommits(8).catch(() => [] as CommitInfo[]),
  ]);

  const t = h.totals;
  // Measured, not modelled: this is the exact string brain_context hands back. If the boot path
  // is failing the number is unknowable rather than zero, and the screen says so.
  const bootTokens = boot === null ? null : Math.round(boot.bytes / 4);
  const bootPct = bootTokens === null || t.tokens === 0 ? null : Math.round((bootTokens / t.tokens) * 100);

  const { active, error: resolveError } = await safeActiveReader(settings);
  const cards = readerCards(settings, active);
  const activeConfigured = active ? providerConfigured(providerOf(active.model)!) : false;
  const reader: OverviewProps["reader"] = {
    current: active ? active.model : "",
    options: cards.map((c) => ({
      id: c.model,
      label: `${c.model}${c.configured ? "" : " · key missing"}${c.disabled ? " · provider off" : ""}`,
      disabled: !c.configured || c.disabled,
    })),
    writable: settings.source === "store",
    note: resolveError
      ? resolveError
      : settings.source !== "store"
        ? "no settings store — the reader follows READER_MODEL in the environment"
        : active && !activeConfigured
          ? "this model's key is missing — the next ask will error"
          : "plain reads never touch a model",
  };

  const notesByPath = new Map<string, NoteLite>(h.notes.map((n) => [n.path, noteLite(n)]));
  // What the log COVERS, as a noun phrase — every panel that names a window uses this one, so
  // the doors and the chart cannot disagree about the same call window.
  const logWindow = windowLabel(callWin.covers);
  const repo = process.env.BRAIN_REPO;
  const props: OverviewProps = {
    now,
    sha: h.sha.slice(0, 8),
    commitUrl: repo ? `https://github.com/${repo}/commit/${h.sha}` : null,
    commitBase: repo ? `https://github.com/${repo}` : null,
    notes: t.notes,
    retracted: t.retractedBlocks,
    folders: h.byDir.length,
    tokens: t.tokens,
    served: reads ? { last24h: reads.last24h, prior24h: reads.prior24h } : null,
    mirror,
    boot: bootTokens === null || bootPct === null ? null : { tokens: bootTokens, pct: bootPct },
    field: dotField(h.notes, t.blocks),
    activity: activity(callWin, now),
    reader,
    pipeline: pipeline(mirror, reads, temps, now),
    // Presence only, never values: env is not editable from a browser, and no secret is shown.
    // Each door is reported against what its route actually checks, not against one env var —
    // the connector and guest routes are the bearer-gated handler behind a path secret, so both
    // are shut when MCP_TOKEN is absent however set their own secret is.
    doors: doors(callWin.rows, {
      token: Boolean(process.env.MCP_TOKEN?.trim()),
      connector: Boolean(process.env.CONNECTOR_PATH_SECRET?.trim()),
      guest: Boolean(process.env.GUEST_PATH_SECRET?.trim()),
      guestClashes:
        Boolean(process.env.GUEST_PATH_SECRET?.trim()) &&
        process.env.GUEST_PATH_SECRET === process.env.CONNECTOR_PATH_SECRET,
    }, now, logWindow),
    saves: saves(commits, notesByPath),
    logWindow,
    checked: checkedOut(callWin.rows, now),
    checkedWindow: callWin.covers < 86_400_000 ? logWindow : "24 h",
  };
  return <OverviewScreen {...props} />;
}
