"use client";
import { useState } from "react";

/**
 * The one place the console does the product's job in front of you.
 *
 * Everything else on this surface is telemetry ABOUT the brain — counts, windows, pipelines.
 * A newcomer could read every screen and the README's "Read. Cite. Abstain." and still never
 * watch it happen. This is that, once: a real question, a real reader over real notes, and the
 * deterministic verifier's verdict with the file's own text beside it.
 *
 * The stamp is computed server-side and arrives as a string. This component styles it and does
 * not decide it — a client that could talk itself into "VERIFIED" would defeat the entire point.
 */
type Citation = {
  path: string;
  evidence: string;
  verified: boolean;
  reason: string;
  commit: string;
  line: number | null;
  heading: string | null;
  superseded: boolean;
};
type Answer = {
  stamp: string;
  answer: string;
  model: string;
  commit: string;
  packTokens: number;
  corpusTokens: number;
  candidates: string[];
  citation: Citation | null;
};

/** The stamp's field colour. VERIFIED and NOT IN BRAIN are both successes on their own terms —
 *  abstaining correctly is the behaviour this product is proudest of, so it is not painted as a
 *  failure. UNVERIFIED is the only one that means "do not trust this". */
function stampTone(stamp: string): string {
  const s = stamp.toUpperCase();
  if (s.startsWith("VERIFIED") || s.startsWith("CORRECTED")) return "askStampOk";
  if (s.startsWith("NOT IN BRAIN")) return "askStampAbstain";
  if (s.startsWith("UNVERIFIED")) return "askStampBad";
  return "askStampWarn";
}

/** The POST handler lives at ask/run because a segment cannot hold both a page and a route
 *  handler — the handler would win and the screen would 405. Same shape as settings/save. */
function runUrl(): string {
  let p = window.location.pathname;
  while (p.endsWith("/")) p = p.slice(0, -1);
  if (!p.endsWith("/ask")) p = `${p}/ask`;
  return `${p}/run`;
}

export function AskClient({ prefill }: Readonly<{ prefill?: string }>) {
  const [q, setQ] = useState(prefill ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [a, setA] = useState<Answer | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!q.trim() || busy) return;
    setBusy(true);
    setError(null);
    setA(null);
    try {
      // Built from the address bar, like the settings write: the browser supplies the secret,
      // so it never appears in markup. A bare relative "run" would resolve against the parent
      // segment on a URL with no trailing slash and miss the handler.
      const res = await fetch(runUrl(), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ question: q.trim() }),
      });
      const body = await res.json().catch(() => null);
      if (!res.ok) {
        setError(body?.error ?? `the ask was refused (${res.status})`);
        return;
      }
      setA(body as Answer);
    } catch {
      setError("the ask did not reach the server");
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <form className="askForm" onSubmit={submit}>
        <label className="askLabel" htmlFor="askQ">
          Ask the brain
        </label>
        <div className="askBar">
          <input
            id="askQ"
            className="askInput"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="what did we decide about the guest door?"
            maxLength={500}
            autoComplete="off"
            disabled={busy}
          />
          <button type="submit" className="askGo" disabled={busy || !q.trim()}>
            {busy ? "reading…" : "ask"}
          </button>
        </div>
        {/* The hint that lived here said the same sentence as the band's lede directly above it.
            The band owns the explanation now; this form owns the control. */}
      </form>

      {error && <div className="askError">{error}</div>}

      {busy && (
        <div className="askWait">
          <span className="askWaitBar" />
          loading the corpus, narrowing it, and reading
        </div>
      )}

      {a && (
        <div className="askResult">
          <div className={`askStamp ${stampTone(a.stamp)}`}>{a.stamp}</div>

          <p className="askAnswer">{a.answer}</p>

          {a.citation ? (
            <div className="askCite">
              <div className="askCiteHead">
                <span className="askCitePath">
                  {a.citation.path}
                  {a.citation.line !== null ? `:${a.citation.line}` : ""}
                </span>
                <span className="askCiteAt">@{a.citation.commit}</span>
              </div>
              {/* The file's own text for the block, not the model's paraphrase of it. */}
              <blockquote className="askEvidence">{a.citation.evidence}</blockquote>
              {a.citation.superseded && (
                <div className="askRetracted">
                  this passage is retracted — the quote is real and the claim is not current
                </div>
              )}
              {!a.citation.verified && <div className="askWhy">{a.citation.reason}</div>}
            </div>
          ) : (
            <div className="askCite askCiteNone">
              nothing was cited. The reader found no supporting text in the notes it was shown,
              and said so rather than composing an answer from outside the brain.
            </div>
          )}

          <div className="askMeta">
            <span>
              read by <b>{a.model}</b>
            </span>
            <span>
              {a.candidates.length} {a.candidates.length === 1 ? "note" : "notes"} in the pack
            </span>
            <span>
              {a.packTokens.toLocaleString()} of {a.corpusTokens.toLocaleString()} tokens hauled
            </span>
            <span>@{a.commit}</span>
          </div>
        </div>
      )}
    </>
  );
}
