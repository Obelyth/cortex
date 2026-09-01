import { requireSecret } from "@/lib/gate";
import { modelRecordRows, readCalls } from "@/lib/calls";
import { readSettings, safeActiveReader, readerCards } from "@/lib/settings";
import roster from "@/lib/tool-roster.json";
import { AskClient } from "./ask-client";
import { ModelsTable, type ReaderVM } from "../settings/models-table";
import { Band } from "../band";
import { Reveal } from "../reveal";
import styles from "../console.module.css";

export const dynamic = "force-dynamic";
export const maxDuration = 60;
export const metadata = { title: "Ask · Cortex console" };

/**
 * Ask — the demonstration, and the tool surface it belongs to.
 *
 * The console had no surface where a newcomer could see the product work. `guide/` is a redirect
 * stub; every other screen measures the brain rather than using it. This screen answers "what is
 * this thing" by doing it, then explains the shape of what just happened.
 *
 * The roster below is READ FROM lib/tool-roster.json, never retyped. That file is pinned to
 * registerTools() by a test, and its own comment records that a hardcoded roster going stale in
 * a verifier caused three separate multi-night outages. A console screen listing the tools from
 * memory would be a fourth copy waiting to drift.
 */
const WHAT: Record<string, string> = {
  brain_ask: "Fetches the whole live corpus, hands a reader model the actual notes, then checks the quote it cited against the file.",
  brain_corpus: "Returns the notes into the calling conversation instead, with no model call at all.",
  brain_context: "The boot call: profile, the router, and the bubble — what every session pays before you type.",
  brain_bubble: "Working memory: list, add, update in place, file into a note, or drop.",
  brain_handoff: "One call resumes a project: page, bubble items, log mentions and graph neighbours — every piece cited, the bundle budgeted.",
  brain_read: "One note, by path.",
  brain_write: "Create, replace, append, or edit in place. Returns the commit SHA.",
  brain_capture: "Timestamped append to today's log. Zero friction, any device.",
  brain_propose: "Guest-only. Leaves a suggestion in a review queue — commits nothing, ever.",
  brain_proposals: "The review queue, for the door that may decide.",
  brain_accept: "Accepting is what commits.",
  brain_reject: "Rejecting leaves no trace.",
};

export default async function Ask({
  params,
  searchParams,
}: {
  params: Promise<{ secret: string }>;
  searchParams: Promise<{ q?: string }>;
}) {
  await requireSecret(params);
  // ?q= arrives from a triage item's "ask the brain about it" — the question lands typed and
  // ready, but NOT auto-submitted: this endpoint spends a model call, and a link that bills on
  // arrival is a link nobody can safely share or reload.
  const { q: prefill } = await searchParams;
  const now = Date.now();
  const { rows } = await readCalls(2_592_000_000);
  const calls = new Map<string, number>();
  for (const r of rows) calls.set(r.tool, (calls.get(r.tool) ?? 0) + 1);

  // The eval table moved here from Settings. It is reference material, not a control: it says
  // which readers have been measured against the labelled set and which have not, which is the
  // question a newcomer has immediately after watching one of them answer. On a screen of
  // switches it was the largest block and the only one you could not act on.
  const settings = await readSettings();
  const { active } = await safeActiveReader(settings);
  const cards = readerCards(settings, active);
  const { rows: dayRows, durable, source: callSource, covers } = await readCalls(86_400_000, now);
  const asks = dayRows.filter((r) => r.tool === "brain_ask");
  // The model record counts only calls the model actually answered. Cached rows are replays of
  // an earlier answer — modelRecordRows drops them, so a question asked five times at one
  // commit is one entry in the model's record, not five. Their count is reported below.
  const attributed = modelRecordRows(asks);
  const cachedAsks = asks.filter((r) => r.cached).length;
  const models: ReaderVM[] = cards.map((c) => {
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
      p50: ms.length ? ms[Math.floor((ms.length - 1) / 2)] : null,
    };
  });
  // Cached rows are attributed but deliberately outside the record, so they get their own
  // count here — folding them into "pre-date per-model logging" would misname what they are.
  const unattributed = asks.length - asks.filter((r) => r.model).length;
  const usageNote = durable
    ? asks.length === 0
      ? "no asks in the window yet"
      : `${attributed.length} of ${asks.length} asks attributed${cachedAsks > 0 ? ` · ${cachedAsks} served from the answer cache (no model call — not counted in the record)` : ""}${unattributed > 0 ? ` · ${unattributed} pre-date per-model logging` : ""}${covers < 86_400_000 ? " · partial log" : ""}`
    : callSource === "unconfigured"
      ? "no durable call store — this is one instance's view"
      : "call store unreachable — in-memory view";

  const trusted: string[] = roster.trusted;
  const guest: string[] = roster.guest;
  // Both memberships are tested. Painting "trusted" on every row would have shown brain_propose
  // as reachable from the trusted doors, which is exactly backwards — it is the guest-only tool,
  // and the trusted doors cannot see it at all.
  const trustedSet = new Set(trusted);
  const guestSet = new Set(guest);
  const all = [...new Set([...trusted, ...guest])].sort();

  return (
    <div className="ovSheet">
      <Band
        n="01"
        label="Ask"
        tone="ink"
        grid
        title={<>Ask the brain a question<br />and watch it <b>prove the answer.</b></>}
        lede="A reader model is handed the actual notes. Its quote is then checked against the file at a commit — deterministically, with no model in that step. The stamp is the product."
      >
        <AskClient prefill={prefill} />
      </Band>

      {/* The control is NOT here — picking the answering model stays on Settings. This is the
          record: measured, shaky, or not yet run against the labelled set. */}
      <Band
        n="02"
        label="Readers"
        tone="grey"
        title={<>Any model may read the brain.<br /><b>Claude earned the default.</b></>}
        lede="The default follows the measurement, not the logo. A reader takes the chair by beating the labelled eval, which is what scripts/eval.ts exists to referee."
      >
        <ModelsTable readers={models} usageNote={usageNote} writable={false} />
      </Band>

      <Band
        n="03"
        label="The tools"
        tone="paper"
        title={<>{trusted.length} tools on a trusted door.<br /><b>{guest.length} on the guest door.</b></>}
        lede="A guest sees a smaller toolset, not a refused one — nothing else is registered on that handler. A tool that appears and then errors teaches a model to keep trying, and tells it what exists to attack."
      >
        {/* A guest sees a SMALLER toolset, not a refused one — nothing else is registered on that
            handler, so nothing else appears in its tools/list. A tool that appears and then
            errors teaches a model to keep trying, and tells it what exists to attack. That is
            why this table marks reach rather than listing everything as available. */}
        <div className="toolTable" data-cx="rise">
          {all.map((t) => {
            const n = calls.get(t) ?? 0;
            return (
              <div key={t} className="toolRow2">
                <span className="toolName2">{t}</span>
                <span className="toolWhat2">{WHAT[t] ?? ""}</span>
                <span className="toolDoors">
                  <span className={trustedSet.has(t) ? "toolDoor toolDoorOn" : "toolDoor"}>trusted</span>
                  <span className={guestSet.has(t) ? "toolDoor toolDoorOn" : "toolDoor"}>guest</span>
                </span>
                <span className={n > 0 ? "toolCalls toolCallsOn" : "toolCalls"}>
                  {n > 0 ? n.toLocaleString() : "—"}
                </span>
              </div>
            );
          })}
        </div>
        <div className={styles.note}>
          Counts come from this environment&rsquo;s call log, so a dash means never called here —
          not that the tool is unavailable.{" "}
          <Reveal label="where the roster comes from">
            The roster itself is read from lib/tool-roster.json,
            which a test pins to the real registration.
          </Reveal>
        </div>
      </Band>
    </div>
  );
}
