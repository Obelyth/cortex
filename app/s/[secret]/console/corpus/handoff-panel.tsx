"use client";
import { useState } from "react";
import type { HandoffPreview } from "@/lib/handoff";

/**
 * The handoff staging panel — what a session resuming a project gets handed TODAY.
 *
 * A live call into the exact bundle walk brain_handoff runs (same gather, same budget, same
 * citations), shown as decisions rather than text: the coverage line verbatim, every included
 * piece with its WHY, and every excluded candidate with the reason it is out — over budget,
 * over the log share, or cut by the neighbour shortlist before the budget ever saw it. The
 * preview reads nothing into the access log, so staging a bundle cannot warm its subjects.
 */

const KIND_LABEL: Record<string, string> = {
  page: "page",
  bubble: "bubble",
  log: "log",
  pinned: "pinned",
  neighbour: "graph",
};

const EXCLUDED_WORD: Record<string, string> = {
  budget: "over the bundle budget — later pieces still walked",
  "log-share": "over the log section's 50% share — kept so a busy week cannot crowd out the graph",
};

export function HandoffPanel({ projects }: Readonly<{ projects: string[] }>) {
  const [sel, setSel] = useState("");
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [view, setView] = useState<HandoffPreview | null>(null);

  async function run(project: string) {
    if (!project) return;
    setLoading(true);
    setErr(null);
    try {
      // Relative, like every console fetch — the secret stays in the address bar, out of markup.
      const res = await fetch("heat/handoff", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ project }),
      });
      const data = (await res.json().catch(() => ({}))) as HandoffPreview & { error?: string };
      if (!res.ok) throw new Error(data.error ?? `preview failed (HTTP ${res.status})`);
      setView(data);
    } catch (e) {
      setView(null);
      setErr(`${e instanceof Error ? e.message : String(e)} — nothing was assembled; the bundle itself is untouched`);
    } finally {
      setLoading(false);
    }
  }

  if (projects.length === 0) {
    return (
      <div className="hoNone">
        no projects/ pages exist yet — brain_handoff has nothing to stage until one is written
      </div>
    );
  }

  return (
    <div className="hoWrap">
      <div className="hoBar">
        <select
          className="modelSelect"
          name="project"
          value={sel}
          onChange={(e) => setSel(e.target.value)}
          aria-label="Project to stage"
          disabled={loading}
        >
          <option value="">none — pick a project</option>
          {projects.map((name) => (
            <option key={name} value={name}>
              {name}
            </option>
          ))}
        </select>
        <button type="button" className="hoGo" disabled={loading || !sel} onClick={() => run(sel)}>
          {loading ? "assembling…" : "stage the bundle"}
        </button>
        <span className="hoHint">
          runs the exact brain_handoff walk at the live head · reads nothing into the access log
        </span>
      </div>

      {err && <div className="hoErr">{err}</div>}

      {view && !loading && (
        <div className="hoResult">
          <div className="hoCoverage">{view.coverage}</div>

          <div className="hoCols">
            <div>
              <div className="hoColHead">
                rides — {view.pieces.filter((x) => x.included).length} pieces
              </div>
              {view.pieces
                .filter((x) => x.included)
                .map((x) => (
                  <div key={`${x.kind}|${x.label}`} className="hoPiece">
                    <span className={`hoKind hoKind-${x.kind}`}>{KIND_LABEL[x.kind] ?? x.kind}</span>
                    <span className="hoLabel">{x.label}</span>
                    <span className="hoBytes">{(x.bytes / 1000).toFixed(1)} KB</span>
                    <span className="hoWhy">{x.why}</span>
                  </div>
                ))}
            </div>

            <div>
              <div className="hoColHead">
                left out — {view.pieces.filter((x) => !x.included).length + view.rankExcludedTotal} candidates
              </div>
              {view.pieces
                .filter((x) => !x.included)
                .map((x) => (
                  <div key={`${x.kind}|${x.label}`} className="hoPiece hoOut">
                    <span className={`hoKind hoKind-${x.kind}`}>{KIND_LABEL[x.kind] ?? x.kind}</span>
                    <span className="hoLabel">{x.label}</span>
                    <span className="hoBytes">{(x.bytes / 1000).toFixed(1)} KB</span>
                    <span className="hoWhy">
                      {EXCLUDED_WORD[x.excludedBy ?? ""] ?? "excluded"} · would have said: {x.why}
                    </span>
                  </div>
                ))}
              {view.rankExcluded.map((n) => (
                <div key={n.path} className="hoPiece hoOut">
                  <span className="hoKind hoKind-rank">rank</span>
                  <span className="hoLabel">{n.path}</span>
                  <span className="hoBytes">·</span>
                  <span className="hoWhy">
                    below the top-8 neighbour shortlist (temperature score {n.score}) · {n.why}
                  </span>
                </div>
              ))}
              {view.rankExcludedTotal > view.rankExcluded.length && (
                <div className="hoMore">
                  +{view.rankExcludedTotal - view.rankExcluded.length} more rank-excluded neighbours not
                  listed here
                </div>
              )}
              {view.pieces.every((x) => x.included) && view.rankExcludedTotal === 0 && (
                <div className="hoMore">nothing was left out — every candidate fit the budget</div>
              )}
            </div>
          </div>

          {view.warnings.map((w) => (
            <div key={w} className="hoWarn">
              {w}
            </div>
          ))}
        </div>
      )}

      {!view && !err && !loading && (
        <div className="hoNone">
          pick a project and stage it — the panel shows the bundle's decisions, piece by piece,
          exactly as a resuming session would receive them
        </div>
      )}
    </div>
  );
}
