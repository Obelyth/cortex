"use client";
import type { ReactNode } from "react";
import type { LensContent } from "../lens";
import { agoIso, type CallsWindow, type NoteLite, type Save } from "@/lib/overview";
import { elapsedLabel } from "@/lib/trends";
import type { BubbleItem } from "@/lib/bubble";
import { safeText } from "@/lib/frontmatter";

/**
 * The bodies this screen renders into the shared lens (lens.tsx): a note (L1), a commit (L8),
 * a window of calls (L9) and a bubble item (W11). One grammar for all four, the one v2 draws —
 * an eyebrow, the id, a description, a key/value list, ties, actions, a note — so the drawer
 * reads the same whatever opened it. Links between screens are relative, like every link in
 * this console: the secret never appears in markup.
 */
export interface Tie { kind: string; label: string; why?: string; go?: () => void }
export interface Act { label: string; href?: string; external?: boolean; go?: () => void; primary?: boolean }

export function LensBody({ eyebrow, tone = "muted", id, desc, kv, tiesLabel, ties = [], actions = [], note }: Readonly<{
  eyebrow: string; tone?: "accent" | "warn" | "muted"; id: string; desc?: ReactNode;
  kv: Array<{ k: string; v: string }>; tiesLabel?: string; ties?: Tie[]; actions?: Act[]; note?: string;
}>) {
  return (
    <>
      <span className={`ovChip ovChip-${tone}`}>{eyebrow}</span>
      <div className="ovLensId">{id}</div>
      {desc ? <p className="ovLensDesc">{desc}</p> : null}
      <dl className="ovLensKv">
        {kv.map((x) => (
          <div key={x.k} className="ovLensKvRow">
            <dt>{x.k}</dt>
            <dd>{x.v}</dd>
          </div>
        ))}
      </dl>
      {ties.length > 0 && (
        <>
          <div className="ovLensTies">{tiesLabel}</div>
          {ties.map((t, i) =>
            t.go ? (
              <button key={i} type="button" className="ovLensTie" onClick={t.go}>
                <span className="ovLensTieKind">{t.kind}</span>
                <span><span className="ovLensTieLabel">{t.label}</span>{t.why && <span className="ovLensTieWhy">{t.why}</span>}</span>
              </button>
            ) : (
              <div key={i} className="ovLensTie ovLensTieStill">
                <span className="ovLensTieKind">{t.kind}</span>
                <span><span className="ovLensTieLabel">{t.label}</span>{t.why && <span className="ovLensTieWhy">{t.why}</span>}</span>
              </div>
            )
          )}
        </>
      )}
      {actions.length > 0 && (
        <div className="ovLensActs">
          {actions.map((a) =>
            a.href ? (
              <a key={a.label} className={`ovLensAct${a.primary ? " ovLensActPrimary" : ""}`} href={a.href} target={a.external ? "_blank" : undefined} rel={a.external ? "noopener" : undefined}>{a.label}</a>
            ) : (
              <button key={a.label} type="button" className={`ovLensAct${a.primary ? " ovLensActPrimary" : ""}`} onClick={a.go}>{a.label}</button>
            )
          )}
        </div>
      )}
      {note && <div className="ovLensNote">{note}</div>}
    </>
  );
}

const enc = encodeURIComponent;

/** L1 · a note, from health.notes[path]. The ledger is the interrogation; this is the glance. */
export function noteLens(n: NoteLite, sha: string): LensContent {
  return {
    kind: `memory · ${n.dir}`,
    title: n.title,
    body: (
      <LensBody
        eyebrow={`memory · ${n.dir}`}
        tone="accent"
        id={n.path}
        desc={n.desc || undefined}
        kv={[
          { k: "size", v: `~${n.tokens.toLocaleString()} estimated body tokens · ${n.blocks} block${n.blocks === 1 ? "" : "s"}` },
          { k: "retracted", v: n.retracted ? `${n.retracted} passage${n.retracted > 1 ? "s" : ""} crossed out, kept on the page` : "none" },
          { k: "last write", v: n.age === null ? "—" : n.age === 0 ? "today" : `${n.age} d ago` },
          { k: "head", v: sha },
        ]}
        actions={[
          { label: "Open in the ledger", href: `corpus?note=${enc(n.path)}`, primary: true },
          { label: "Ask about it", href: `ask?q=${enc(`what does ${n.title} decide, and what was corrected?`)}` },
        ]}
        note="the ledger is the interrogation; this is the glance"
      />
    ),
  };
}

/** L8 · a commit. Every write to the brain is one; the Contents API is the only write path. */
export function commitLens(s: Save, commitBase: string | null, sha: string, open: (c: LensContent) => void): LensContent {
  return {
    kind: "commit",
    title: s.message,
    body: (
      <LensBody
        eyebrow="commit"
        id={s.sha}
        desc="Every write to the brain is a commit; the Contents API is the only write path."
        kv={[{ k: "when", v: s.date ? `${s.date.replace("T", " ").slice(0, 19)} utc` : "—" }]}
        tiesLabel="Touches"
        ties={s.note ? [{ kind: "note", label: s.note.title, why: s.note.path, go: () => open(noteLens(s.note!, sha)) }] : []}
        actions={commitBase ? [{ label: "Open on GitHub", href: `${commitBase}/commit/${s.sha}`, external: true, primary: true }] : []}
        note={commitBase ? undefined : "BRAIN_REPO is not set, so the commit has no address to open"}
      />
    ),
  };
}

const hhmm = (ts: number) => new Date(ts).toISOString().slice(11, 16);

/** L9 · a window of calls: the rows the chart counted, listed. The list is capped (ASK_ROWS_CAP),
 *  so when it is short of the window's ask count the label says how many of how many — a list
 *  that silently drops the older half would read as the whole window. */
export function callsLens(title: string, id: string, w: CallsWindow): LensContent {
  // Errors, cut-offs and timeouts all answered nothing, so none of them is scored either way.
  const scored = w.asks - w.errors - w.cut - w.timedOut;
  const unscored = [w.cut ? "get cut off" : "", w.timedOut ? "time out" : ""].filter(Boolean);
  const by = (xs: Array<[string, number]>) => (xs.length ? xs.map(([k, n]) => `${k.replace("brain_", "")} ${n}`).join(" · ") : "—");
  return {
    kind: "call log · window",
    title,
    body: (
      <LensBody
        eyebrow="call log · window"
        tone="accent"
        id={id}
        desc={w.total
          ? `${w.total} call${w.total === 1 ? "" : "s"}, ${w.asks} of them ask${w.asks === 1 ? "" : "s"}. Every row is one tool call as the log recorded it — surface, tool, stamp and latency.`
          : "No calls in this window. Silence, not zero: the log covers it and nothing happened."}
        kv={[
          { k: "asks", v: w.asks ? `${w.asks} · ${w.mem} from memory · ${w.fresh} not in memory · ${w.errors} error${w.errors === 1 ? "" : "s"}${w.cut ? ` · ${w.cut} cut off by the platform` : ""}${w.timedOut ? ` · ${w.timedOut} timed out in budget` : ""}` : "0" },
          // Named base: the row above lists asks, and this is not against asks — an errored ask
          // could not be answered from anywhere, so it is not scored either way.
          { k: "from memory", v: scored > 0 ? `${Math.round((w.mem / scored) * 100)}% of the ${scored} ask${scored === 1 ? "" : "s"} that did not error${unscored.map((u) => ` or ${u}`).join("")}` : "—" },
          { k: "p50 latency", v: w.p50ms === null ? "—" : `${(w.p50ms / 1000).toFixed(1)} s` },
          { k: "by tool", v: by(w.byTool) },
          { k: "by door", v: by(w.byDoor) },
        ]}
        tiesLabel={w.askRows.length < w.asks
          ? `Asks in this window · newest ${w.askRows.length} of ${w.asks}`
          : "Asks in this window · newest first"}
        ties={w.askRows.map((r) => ({ kind: r.stamp, label: `${hhmm(r.ts)} utc · ${r.model ?? "—"} · ${elapsedLabel(r)}`, why: `${r.surface}${r.cached ? " · served from cache" : ""}` }))}
        actions={[{ label: "Ask the brain now", href: "ask", primary: true }]}
        note="rows are CallRow {ts, surface, tool, stamp, ms, model, cached, saved} · question text is never logged"
      />
    ),
  };
}

/** W11 · a bubble item: working state, written deliberately, ages out untouched. */
export function bubbleLens(it: BubbleItem, projectNote: NoteLite | null, now: number, sha: string, open: (c: LensContent) => void): LensContent {
  const body = safeText(it.body, 600);
  const title = safeText(it.body, 90);
  const project = safeText(it.project, 40);
  return {
    kind: `working state · ${it.kind}`,
    title,
    body: (
      <LensBody
        eyebrow={`working state · ${it.kind}`}
        tone={it.kind === "handoff" ? "accent" : it.kind === "question" ? "warn" : "muted"}
        id={`#${it.id}`}
        desc={body.length > title.length ? body : undefined}
        kv={[
          { k: "project", v: project || "general" },
          { k: "surface", v: safeText(it.surface, 20) || "unknown" },
          { k: "added", v: agoIso(it.created_at, now) },
          { k: "touched", v: agoIso(it.touched_at, now) },
          { k: "ages out", v: "14 d after the last touch, on its own" },
        ]}
        tiesLabel="Project"
        ties={projectNote ? [{ kind: "note", label: projectNote.title, why: projectNote.path, go: () => open(noteLens(projectNote, sha)) }] : []}
        actions={[{ label: "Ask about it", href: `ask?q=${enc(title)}` }]}
        note={`from any session: brain_bubble update ${it.id} · brain_bubble file ${it.id} + note path · brain_bubble drop ${it.id}`}
      />
    ),
  };
}
