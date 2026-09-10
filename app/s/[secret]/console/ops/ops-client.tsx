"use client";
import { useEffect, useReducer, useRef, useState, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import type { Board, BoardRow } from "@/lib/ops-board";
import { primaryControl, STATE_TONE } from "@/lib/ops-board";
import { receiptReducer, DONE_HOLD_MS, type ReceiptState } from "@/lib/receipt-state";
import { useLens, type LensContent } from "../lens";
import { ReceiptLensBody, UnitLensBody, type ControlVM } from "./ops-lens";
import { CommandPanel } from "./command-panel";
import { parseOpsActionResponse } from "@/lib/ops-action-response";

const REST: ReceiptState = { phase: "rest", receipt: null, error: null, since: 0 };
const LABEL: Record<string, [string, string, string]> = {
  ack: ["Acknowledge", "Acknowledging", "Acknowledged"],
  snooze: ["Snooze 24h", "Snoozing", "Snoozed"],
  // The window is part of the label: a control that hides what it commits to invites a
  // click nobody meant (critique 2026-09-05).
  pause: ["Pause 3d", "Pausing", "Paused 3d"],
  resume: ["Resume", "Resuming", "Resumed"],
  "run-now": ["Run now", "Dispatching", "Dispatched"],
};

/** The receipted feedback grammar (spec §12.3), as a thin useReducer wrapper: press clears any
 *  prior error and shows the working state immediately; ok/fail land only while working, so a
 *  stale response after a later press can never overwrite what the operator is looking at; done
 *  holds for DONE_HOLD_MS so the receipt is actually readable before the row settles back. */
function useReceipt(secret: string) {
  const [s, dispatch] = useReducer(receiptReducer, REST);
  const [opened, setOpened] = useState<string | null>(null);
  const router = useRouter();
  useEffect(() => {
    if (s.phase !== "done") return;
    const t = setTimeout(() => {
      dispatch({ type: "settle", at: Date.now() });
      // The control changed server state the register was rendered from; the hold keeps the
      // receipt readable, and settling is the moment to go and re-read the board rather than
      // leave a stale row (a paused unit still saying "Scheduled") on screen.
      router.refresh();
    }, DONE_HOLD_MS);
    return () => clearTimeout(t);
  }, [s.phase, s.since, router]);

  async function fire(body: Record<string, unknown>) {
    dispatch({ type: "press", at: Date.now() });
    setOpened(null);
    try {
      const res = await fetch(`/s/${secret}/console/ops/actions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const parsed = parseOpsActionResponse(res.status, await res.json().catch(() => null));
      if (parsed.outcome !== "confirmed") {
        dispatch({ type: "fail", error: parsed.message, at: Date.now() });
        return;
      }
      // Never window.open here: this runs after an await, so the browser no longer counts it as
      // user-initiated and the popup blocker eats it silently. The link is rendered in the
      // lens instead, and the operator's own click opens it.
      if (parsed.opened) setOpened(parsed.opened);
      dispatch({ type: "ok", receipt: parsed.receipt, at: Date.now() });
    } catch {
      dispatch({ type: "fail", error: "Outcome uncertain · recheck receipts before retrying", at: Date.now() });
    }
  }
  const reset = () => { setOpened(null); dispatch({ type: "reset", at: Date.now() }); };
  return { s, fire, reset, opened };
}

type Receipt = Board["timeline"][number];

/** Thirty days of hh:mm lines need their days back: a rule with the date opens each one. */
function withDays(timeline: Receipt[]): Array<{ day: string } | Receipt> {
  const out: Array<{ day: string } | Receipt> = [];
  let last = "";
  for (const e of timeline) {
    const day = e.at.slice(0, 10);
    if (day !== last) { out.push({ day }); last = day; }
    out.push(e);
  }
  return out;
}

/**
 * The register and the timeline, and the two lens bodies they open — a unit (L3) and a receipt
 * (L4). One client component, because a receipt's lens offers "Open unit" and a unit's lens
 * lists its receipts, and both need the same opener and the same receipt machine.
 *
 * THE LENS SHOWS THE ROW THE REGISTER SHOWS. The drawer holds a snapshot, so this component
 * publishes a fresh body whenever the board re-reads (router.refresh() after a control settles)
 * or the receipt machine moves; the row it marks is derived from what the lens says it is
 * showing, never from a second notion of "selected".
 */
export function OpsClient({ board, secret, decisions, initialOpenId = null }: Readonly<{
  board: Board; secret: string;
  /** The Decisions panel, server-rendered behind its own Suspense boundary, placed beside the timeline. */
  decisions: ReactNode;
  /** A row to mark before the lens has opened it — the static render, and a deep link's first paint. */
  initialOpenId?: string | null;
}>) {
  const rows = board.groups.flatMap((g) => g.rows);
  const lens = useLens();
  const api = useRef(lens);
  api.current = lens;
  const { s, fire, reset, opened } = useReceipt(secret);
  const [pending, setPending] = useState<string | null>(null);
  const [seed, setSeed] = useState<string | null>(initialOpenId);
  const lensId = lens.lens?.id ?? null;
  const openId = lensId?.startsWith("unit:") ? lensId.slice(5) : seed;
  const sel = openId ? rows.find((r) => r.id === openId) ?? null : null;

  useEffect(() => {
    if (s.phase === "rest") setPending(null);
  }, [s.phase]);

  const act = (row: BoardRow, control: string) => {
    if (s.phase === "working") return;
    setPending(control);
    const body: Record<string, unknown> = { action: control, unit: row.id };
    if (control === "snooze") body.hours = 24;
    if (control === "pause") body.until = new Date(Date.now() + 3 * 86400_000).toISOString();
    void fire(body);
  };

  const unitName = (id: string) => rows.find((r) => r.id === id)?.name ?? null;

  const receiptContent = (e: Receipt): LensContent => ({
    id: `receipt:${e.id}`, kind: "receipt", title: e.line,
    body: <ReceiptLensBody key={e.id} e={e} unitName={unitName(e.unit)} onUnit={rows.some((r) => r.id === e.unit) ? () => openUnit(e.unit) : null} />,
  });

  const unitContent = (row: BoardRow): LensContent => {
    const busy = s.phase === "working";
    const primary = primaryControl(row);
    const controls: ControlVM[] = row.selectedControls.map((c) => {
      // A link target isn't dispatched anywhere — the POST writes the receipt and hands back a
      // URL for the operator to open. "Dispatched" would claim work nothing did.
      const [rest, working, done] = c === "run-now" && row.runNowKind === "link" ? ["Run now", "Preparing", "Ready · open on claude.ai"] : LABEL[c];
      const phase = pending === c ? s.phase : "rest";
      return { key: c, label: phase === "working" ? working : phase === "done" ? done : rest, primary: c === primary, phase, inert: busy && pending !== c, go: () => act(row, c) };
    });
    const receipts = board.timeline.filter((e) => e.unit === row.id);
    return {
      id: `unit:${row.id}`, kind: `unit · ${row.kind}`, title: row.name,
      body: (
        <UnitLensBody
          key={row.id}
          row={row}
          receipts={receipts.slice(0, 8).map((e) => ({ id: e.id, at: e.at, line: e.line, field: e.field ? e.field.text : null }))}
          total={receipts.length}
          controls={controls}
          busy={busy}
          receipt={s.phase === "done" ? `receipt ${s.receipt ?? "—"} · ${new Date(s.since).toISOString().slice(11, 19)} utc` : null}
          opened={opened}
          error={s.phase === "failed" ? s.error : null}
          onReceipt={(id) => { const e = board.timeline.find((x) => x.id === id); if (e) api.current.open(receiptContent(e)); }}
        />
      ),
    };
  };

  const openUnit = (id: string) => {
    const row = rows.find((r) => r.id === id);
    if (!row) return;
    // A request in flight belongs to the row it was pressed on; switching rows mid-write would
    // attribute its receipt to a same-named control on another unit.
    if (s.phase === "working") return;
    if (id !== openId) { reset(); setPending(null); }
    lens.open(unitContent(row));
  };

  // Publish the open unit again whenever what it shows could have changed.
  useEffect(() => {
    if (!lensId?.startsWith("unit:")) return;
    const row = rows.find((r) => r.id === lensId.slice(5));
    if (row) api.current.open(unitContent(row));
    // unitContent() closes over the board, the receipt state and the pending control.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [board, s, opened, pending, lensId]);

  // "Open on the register" (the notices tray) links #<unit>. Honoured once, on arrival: the unit
  // opens in the lens, and the browser's own scroll-to-fragment lands its row under the sticky
  // masthead thanks to the row's scroll-margin. The seed — the static render's marked row — is
  // spent the same way.
  useEffect(() => {
    const hash = decodeURIComponent(window.location.hash.slice(1));
    const id = rows.some((r) => r.id === hash) ? hash : seed;
    setSeed(null);
    const row = id ? rows.find((r) => r.id === id) : undefined;
    if (row) api.current.open(unitContent(row));
    // Read once on mount; `rows` is the server render and does not change underneath this.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // What a screen reader hears while the button's own label changes under the pointer.
  const announce = !sel || !pending
    ? ""
    : s.phase === "working" ? `${LABEL[pending]?.[1] ?? "Working on"} ${sel.name}`
    : s.phase === "done" ? `${LABEL[pending]?.[2] ?? "Done"} · ${sel.name} · receipt ${s.receipt ?? "—"}`
    : s.phase === "failed" ? `Failed · ${s.error ?? "outcome unavailable"}`
    : "";

  return (
    <>
      <section className="opsRegister" aria-labelledby="ops-register">
        <div className="opsPanelHead">
          <span className="opsHeadLead">
            <span className="opsTag">
              <span className="opsTagN">01</span>
              <h2 id="ops-register" className="opsTagLabel">Register</h2>
            </span>
            <span className="opsHeadMeta">{rows.length} unit{rows.length === 1 ? "" : "s"}</span>
          </span>
          <span className="opsHeadMeta">state is derived · every control writes a receipt first</span>
        </div>
        <div className="opsTable" role="table" aria-label="Units">
          <div className="opsCols" role="row">
            <span role="columnheader">No.</span>
            <span role="columnheader">Unit</span>
            <span role="columnheader">Schedule</span>
            <span role="columnheader">Last run · evidence</span>
            <span role="columnheader">State</span>
            <span role="columnheader"><span className="srOnly">Open</span></span>
          </div>
          {board.groups.filter((g) => g.rows.length > 0 || g.reserved).map((g) => (
            <div key={g.owner} className="opsGroup" role="rowgroup">
              <div className="opsGroupHead" role="row">
                <span role="cell">{g.label}</span>
                {g.rows.length === 0 && g.reserved && <span role="cell" className="opsReserved">{g.reserved}</span>}
              </div>
              {g.rows.map((r, i) => {
                const on = openId === r.id;
                return (
                  <div
                    key={r.id}
                    id={r.id}
                    role="row"
                    className={`opsRow${r.state === "needs_you" ? " opsRowCrit" : ""}${on ? " opsRowOn" : ""}`}
                    aria-current={on ? "true" : undefined}
                    onClick={() => openUnit(r.id)}
                  >
                    <span role="cell" className="opsNo">{String(i + 1).padStart(2, "0")}</span>
                    <span role="cell" className="opsUnit">
                      {/* The name is the accessible control; the row around it is the pointer's
                          target, and the chevron at the right is the hint. */}
                      <button type="button" className="opsName" aria-haspopup="dialog" aria-expanded={on}>{r.name}</button>
                      <span className="opsKind">{r.kind}{r.kind === "machine" ? " · never pages" : ""}</span>
                    </span>
                    <span role="cell" className="opsSched" data-col="Schedule">{r.schedule}</span>
                    <span role="cell" className="opsLast" data-col="Last run">
                      <span className="opsLastRun">{r.lastRun}</span>
                      {r.evidence.map((e) => <span key={e} className="opsEv">{e}</span>)}
                    </span>
                    <span role="cell" className="opsState">
                      <span className={`opsChip opsChip-${STATE_TONE[r.state]}${r.state === "running" ? " opsChipLive" : ""}`}>{r.stateLabel}</span>
                    </span>
                    <span role="cell" className="opsGo" aria-hidden="true">›</span>
                  </div>
                );
              })}
            </div>
          ))}
        </div>
      </section>
      <span className="srOnly" role="status" aria-live="polite">{announce}</span>

      <div className="opsBeneath">
        {decisions}
        <section className="opsTimeline" aria-labelledby="ops-timeline">
          <div className="opsPanelHead">
            <span className="opsHeadLead">
              <span className="opsTag">
                <span className="opsTagN">03</span>
                <h2 id="ops-timeline" className="opsTagLabel">Timeline</h2>
              </span>
            </span>
            <span className="opsHeadMeta">receipts · newest first · 30 d</span>
          </div>
          <ol className="opsReceipts">
            {withDays(board.timeline).map((x) =>
              "day" in x ? (
                <li key={`day-${x.day}`} className="opsDay">{x.day}</li>
              ) : (
                <li key={x.id}>
                  <button type="button" className="opsReceipt" aria-haspopup="dialog" aria-expanded={lensId === `receipt:${x.id}`} onClick={() => lens.open(receiptContent(x))}>
                    <span className="opsWhen">{x.at.slice(11, 16)}</span>
                    <span className="opsLine">
                      {x.line}
                      {x.field && <span className={`opsMark opsMark-${x.field.tone}`}>· {x.field.text}</span>}
                    </span>
                  </button>
                </li>
              )
            )}
            {board.timeline.length === 0 && <li className="opsEmpty">no receipts yet · the first run writes the first row</li>}
          </ol>
        </section>
      </div>
      {/* Commands sits beneath the register, not above it: the register is the screen's centre of
          gravity, and a panel that fills with rows after a fetch must never push it down the page. */}
      <CommandPanel secret={secret} />
    </>
  );
}
