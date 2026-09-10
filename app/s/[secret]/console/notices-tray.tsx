"use client";
import { useEffect, useRef, useState } from "react";
import type { Notice, NoticeTab } from "@/lib/notices";
import { Glyph } from "./glyph";

type NoticesMode = "live" | "unconfigured" | "unreachable";
interface NoticesData { mode: NoticesMode; notices: Notice[]; unread: number }

/**
 * The masthead bell and the tray it opens. Notices are a read-only, filtered view of
 * ops_events plus this device's read mark — nothing here is a second source of truth; every
 * control that actually changes something (ack, snooze, run) lives on the register, which the
 * "Open on the register" link hands off to.
 *
 * The bell owns its own unread count: it is the notices feed's count, not the layout's
 * unrelated triage/proposals/watch tally, so "Mark all read" always drives the badge to zero.
 * That means one fetch on mount (so the badge is right before the tray is ever opened) plus
 * one on every open (so a stale-while-closed count refreshes).
 */
export function NoticesBell({ secret }: Readonly<{ secret: string }>) {
  const [open, setOpen] = useState(false);
  const bell = useRef<HTMLButtonElement>(null);
  const tray = useRef<HTMLElement>(null);
  const [tab, setTab] = useState<NoticeTab>("all");
  const [data, setData] = useState<NoticesData>({ mode: "live", notices: [], unread: 0 });
  // One fetch on mount, so the badge is right before the tray is ever opened, and one on every
  // open, so a count gone stale while the tray sat closed refreshes.
  useEffect(() => { fetch(`/s/${secret}/console/ops/notices`).then((r) => r.json()).then(setData).catch(() => setData((d) => ({ ...d, mode: "unreachable" }))); }, [secret]);
  useEffect(() => { if (!open) return; fetch(`/s/${secret}/console/ops/notices`).then((r) => r.json()).then(setData).catch(() => setData((d) => ({ ...d, mode: "unreachable" }))); }, [open, secret]);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  // Focus moves on the TRANSITION, not in the keydown effect's cleanup. Restoring from a cleanup
  // also fires on unmount, and on unmount the bell is being removed too — so focus would land on
  // a disappearing node and fall to <body>, which is focus nowhere: exactly the failure the lens
  // work exists to end. Tracking the open→closed edge restores only on a real close.
  const wasOpen = useRef(false);
  useEffect(() => {
    if (open) {
      wasOpen.current = true;
      tray.current?.focus();
      return;
    }
    if (wasOpen.current) {
      wasOpen.current = false;
      bell.current?.focus();
    }
  }, [open]);
  const shown = data.notices.filter((n) => tab === "all" || n.tab === tab);
  const markAll = async () => { const top = data.notices[0]?.id ?? 0; await fetch(`/s/${secret}/console/ops/notices`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ upTo: top }) }); setData({ ...data, unread: 0, notices: data.notices.map((n) => ({ ...n, unread: false })) }); };
  return (
    <>
      <button ref={bell} type="button" className="ntBell" aria-label={`Notices · ${data.unread} unread`} aria-expanded={open} onClick={() => setOpen(!open)}>
        Notices
        {data.unread > 0 && <span className="ntBadge">{data.unread}</span>}
      </button>
      {open && (
        <div className="ntDim">
          <button type="button" className="ntBackdrop" aria-label="Close notices" onClick={() => setOpen(false)} />
          {/* A disclosure, not a modal. It claimed aria-modal="true" — which tells assistive tech
              the rest of the page is hidden — while its own bell sat in the masthead behind it and
              stayed clickable; making that claim true would render the bell inert and stop it
              toggling the tray closed. So the claim goes instead of the behaviour: a labelled
              group the bell owns through aria-expanded, closed by Escape, the dim, or its own
              close button. data-cx also goes: kinetic.tsx excludes client components by
              construction, so the reveal class never reaches a node rendered here. */}
          <aside ref={tray} tabIndex={-1} className="ntTray" role="group" aria-label="Notices">
            <div className="ntHead">
              <span className="secTag"><span className="secTagN">05</span><span className="secTagLabel">Notices</span></span>
              <span className="mono ntCount">{data.unread} unread · {data.notices.length} in 7 d</span>
              <span style={{ flex: 1 }} />
              <button type="button" className="ntClose" aria-label="Close" onClick={() => setOpen(false)}><Glyph name="close" /></button>
            </div>
            <div className="ntTabs">
              {/* Mark all read lives here, with the filters, as the canvas has it — in the head it
                  shared a no-wrap flex row with the counter and broke its own label in half. */}
              {(["all", "needs_you", "runs", "receipts", "mail"] as NoticeTab[]).map((t) => (
                <button key={t} type="button" className={`ntTab ${tab === t ? "ntTabOn" : ""}`} onClick={() => setTab(t)}>
                  {t === "needs_you" ? "Needs you" : t[0].toUpperCase() + t.slice(1)}
                </button>
              ))}
              <span className="ntSpacer" />
              <button type="button" className="opsBtn opsTertiary" onClick={markAll}>Mark all read</button>
            </div>
            {data.mode !== "live" && <p className="opsDegraded">{data.mode === "unconfigured" ? "ops ledger not configured · env" : "unreachable this render"}</p>}
            <ol className="ntList">
              {shown.map((n) => (
                <li key={n.id}>
                  {/* The whole row is the link, as the canvas has it. It used to be an inert row
                      with an "Open on the register" button nested inside, which put a second
                      target inside the first and left that button blending into its own row.
                      Every notice carries a unit, so every row has somewhere to go. */}
                  <a
                    className={`ntItem ${n.tab === "needs_you" ? "ntItemCrit" : ""} ${n.unread ? "ntUnread" : ""}`}
                    href={`/s/${secret}/console/ops#${n.unit}`}
                    // The tray is a disclosure over the page, not a route: following a row while
                    // already on /console/ops is a same-document fragment jump, so nothing
                    // remounts and nothing would otherwise close this. The drawer and its scrim
                    // would stay over the row the operator just asked to see.
                    onClick={() => setOpen(false)}
                  >
                    {/* The unread mark, not a decoration: the glyph that used to sit here was the
                        same on every row whether read or not, so the row had no way of showing the
                        one piece of state the tray exists to clear. */}
                    <i className="ntDot" aria-hidden />
                    <span className="ntBody">
                      {/* The dot is the whole unread signal and it is aria-hidden, so without this
                          the head can say "2 unread" and offer "Mark all read" while giving a
                          screen-reader operator no way to tell WHICH two. It leads the row so the
                          state arrives before the title it qualifies. */}
                      {n.unread && <span className="srOnly">Unread · </span>}
                      <span className="ntTitle">{n.title}</span>
                      <span className="mono ntLine">
                        {n.line}
                        {n.field && <span className={`opsField opsField-${n.field.tone}`}>{n.field.text}</span>}
                      </span>
                    </span>
                    <span className="mono ntWhen">{n.at.slice(5, 16).replace("T", " ")}</span>
                  </a>
                </li>
              ))}
              {shown.length === 0 && <li className="ntEmpty mono">nothing here · the next run writes the next notice</li>}
            </ol>
            <div className="ntFoot mono">
              Notices are receipts with a read mark. Nothing here is a second source of truth.
              <a className="opsBtn opsTertiary" href={`/s/${secret}/console/ops`}>Open the register</a>
            </div>
          </aside>
        </div>
      )}
    </>
  );
}
