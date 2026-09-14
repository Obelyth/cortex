"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { agoIso } from "@/lib/overview";
import { safeText } from "@/lib/frontmatter";
import { readWorkingPage, workingStateUrl } from "@/lib/working-state-client";
import { readProjectOptions, requestHandoffPreview } from "@/lib/handoff-client";
import type { HandoffPreview } from "@/lib/handoff";
import type { WorkingCursor, WorkingItem, WorkingPage } from "@/lib/working-state-contract";
import { useLens } from "../lens";
import { WorkingStateEditor } from "../working-state-editor";
import { ContextPreview } from "./context-preview";
import styles from "../working-state-editor.module.css";
import context from "./working-context.module.css";

type Preview = { kind: "loading" } | { kind: "error"; message: string } | { kind: "ready"; view: HandoffPreview };

/** One home for temporary notes and project handoff. None is local selection, not a delete.
 * The list still comes from the redacted, paginated management endpoint; raw server props
 * never supply working prose. A preview is explicitly requested and never cached across opens. */
export function WorkingState({ now }: Readonly<{ now: number }>) {
  const lens = useLens();
  const router = useRouter();
  const [project, setProject] = useState("");
  const [projects, setProjects] = useState<string[]>([]);
  const [projectsLoading, setProjectsLoading] = useState(true);
  const [projectsError, setProjectsError] = useState(false);
  const [truncated, setTruncated] = useState(false);
  const [arrivalMissing, setArrivalMissing] = useState(false);
  const [scope, setScope] = useState<string | null>(null);
  const [listRevision, setListRevision] = useState(0);
  const [cursors, setCursors] = useState<(WorkingCursor | null)[]>([null]);
  const [page, setPage] = useState<WorkingPage | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [preview, setPreview] = useState<Preview | null>(null);
  const generation = useRef(0);
  const optionsGeneration = useRef(0);
  const previewGeneration = useRef(0);
  const pendingPreview = useRef<AbortController | null>(null);
  const arrived = useRef(false);
  const before = cursors[cursors.length - 1];

  const clearPreview = useCallback(() => {
    previewGeneration.current++;
    pendingPreview.current?.abort();
    pendingPreview.current = null;
    setPreview(null);
  }, []);
  const selectProject = useCallback((value: string) => {
    clearPreview();
    setProject(value);
    setScope(value || null);
    setCursors([null]);
    setPage(null);
    // None may keep an already selected All-projects filter. Still reload the cleared page.
    setListRevision(value => value + 1);
    setArrivalMissing(false);
  }, [clearPreview]);

  const loadProjects = useCallback(async () => {
    const id = ++optionsGeneration.current;
    setProjectsLoading(true); setProjectsError(false);
    try {
      const options = await readProjectOptions(window.location.pathname);
      if (id !== optionsGeneration.current) return;
      setProjects(options.projects); setTruncated(options.truncated);
      if (!arrived.current) {
        arrived.current = true;
        // A one-time, explicit shortcut from Ask. Consume the fragment so a reload returns to
        // None; no draft/project selection goes into server requests, storage or analytics.
        const prefix = "#working-context?";
        if (window.location.hash.startsWith(prefix)) {
          const requested = new URLSearchParams(window.location.hash.slice(prefix.length)).get("project");
          window.history.replaceState(window.history.state, "", window.location.pathname + window.location.search + "#working-context");
          if (requested && options.projects.includes(requested)) selectProject(requested);
          else if (requested) setArrivalMissing(true);
          document.getElementById("working-context")?.scrollIntoView({ block: "start" });
        }
      }
    } catch {
      if (id === optionsGeneration.current) setProjectsError(true);
    } finally {
      if (id === optionsGeneration.current) setProjectsLoading(false);
    }
  }, [selectProject]);
  useEffect(() => { void loadProjects(); return () => { optionsGeneration.current++; }; }, [loadProjects]);

  const load = useCallback(async () => {
    const id = ++generation.current; setLoading(true); setError(null);
    try {
      const result = await readWorkingPage(workingStateUrl(window.location.pathname), scope, before);
      if (id === generation.current) setPage(result);
    } catch (e) {
      if (id === generation.current) { setPage(null); setError(e instanceof Error ? e.message : "Working notes did not answer."); }
    } finally { if (id === generation.current) setLoading(false); }
  }, [scope, before, listRevision]);
  useEffect(() => { void load(); return () => { generation.current++; }; }, [load]);
  useEffect(() => () => { previewGeneration.current++; pendingPreview.current?.abort(); }, []);

  async function openPreview() {
    if (!project || pendingPreview.current) return;
    const id = ++previewGeneration.current;
    const controller = new AbortController(); pendingPreview.current = controller;
    setPreview({ kind: "loading" });
    try {
      const view = await requestHandoffPreview(window.location.pathname, project, fetch, controller.signal);
      if (id === previewGeneration.current) setPreview({ kind: "ready", view });
    } catch (e) {
      if (id === previewGeneration.current) setPreview({ kind: "error", message: e instanceof Error ? e.message : "Preview unavailable. Retry when the source returns." });
    } finally {
      if (id === previewGeneration.current) pendingPreview.current = null;
    }
  }
  const edit = (item?: WorkingItem) => {
    clearPreview();
    lens.open({
      id: item ? "working:" + item.id : "working:new", kind: "working context",
      title: item ? "Edit working item #" + item.id : project ? "Add project handoff" : "Add general note",
      body: <WorkingStateEditor key={item?.id ?? "new"} item={item} project={project}
        onSaved={() => { clearPreview(); void load(); router.refresh(); }} />,
    });
  };
  const changeScope = (value: string | null) => { setScope(value); setCursors([null]); setPage(null); setListRevision(revision => revision + 1); };
  const scopeLabel = scope === null ? "all projects and general notes" : scope || "general notes";
  const status = page
    ? scopeLabel + " · " + page.total + " open · " + page.items.length + " on page " + cursors.length + (loading ? " · refreshing…" : "")
    : loading ? "Reading saved working notes…" : "Working notes unavailable";

  return <>
    <div className="ovPanelHead">
      <h2 className="ovPanelTitle" id="ov-working">Working context</h2>
      <span className="ovPanelNote">{page ? page.total + " open in this view" : loading ? "reading…" : "unavailable"}</span>
    </div>
    <section className={context.notes} aria-labelledby="working-note">
    <h3 className={context.heading} id="working-note">Leave a working note</h3>
    <p className={context.intro}>Save a quick note or project handoff for the next session. Preview a project to see the bounded context it would receive.</p>
    <div className={context.controls}>
      <label className={styles.field} htmlFor="working-project">Project for handoff
        <select id="working-project" value={project} onChange={e => selectProject(e.target.value)}>
          <option value="">None · no project selected</option>
          {projects.map(name => <option key={name} value={name}>{name}</option>)}
        </select>
      </label>
      <button type="button" className={styles.button + " " + styles.primary} onClick={() => edit()}><span className="inkSweep" aria-hidden="true" />{project ? "Add project handoff" : "Add general note"}</button>
      <button type="button" className={styles.button} disabled={!project || preview?.kind === "loading"} onClick={() => void openPreview()}><span className="inkSweep" aria-hidden="true" />{preview?.kind === "loading" ? "Assembling…" : "Preview context"}</button>
      {preview && <button type="button" className={styles.button} onClick={clearPreview}><span className="inkSweep" aria-hidden="true" />Close preview</button>}
    </div>
    <p className={context.description}>{project
      ? "Selection alone saves nothing. Add a handoff to save notes; Preview context shows the current bundle without a model call or access-log entry."
      : "No project selected. General notes remain available at session boot. Choosing None never removes saved notes or changes a model’s current conversation."}</p>
    {projectsLoading && <p className={context.description} role="status">Loading project choices…</p>}
    {projectsError && <p className={context.description} role="alert">Project choices are unavailable. Your saved notes are separate and can still be managed. <button type="button" className={styles.button} onClick={() => void loadProjects()}><span className="inkSweep" aria-hidden="true" />Retry project choices</button></p>}
    {!projectsLoading && !projectsError && !projects.length && <p className={context.description}>No project pages yet. You can save general notes now; a project preview needs a project page in the corpus.</p>}
    {truncated && <p className={context.description}>Showing the first 500 project choices. Other saved notes are still available below under All projects.</p>}
    {arrivalMissing && <p className={context.description} role="status">That project is not in the available choices. Nothing was selected or saved.</p>}
    <div role={preview?.kind === "error" ? "alert" : "status"} aria-live="polite" className={context.description}>
      {preview?.kind === "loading" ? "Assembling the selected project’s context…" : preview?.kind === "error" ? preview.message : preview?.kind === "ready" ? "Preview ready. This is a snapshot; preview again for the latest context." : ""}
    </div>
    {preview?.kind === "ready" && <ContextPreview view={preview.view} />}
    <section className={context.saved} aria-labelledby="working-saved">
      <div className={context.savedHead}>
        <h3 className={context.heading} id="working-saved">Saved working notes</h3>
        <label className={context.filter}>Show
          <select value={scope === null ? "all" : scope === "" ? "general" : "selected"} onChange={e => changeScope(e.target.value === "all" ? null : e.target.value === "general" ? "" : project)}>
            <option value="all">All projects + general notes</option>
            <option value="general">General notes only</option>
            {project && <option value="selected">Selected project</option>}
          </select>
        </label>
      </div>
      <div role="status" className="ovPanelFoot">{status}</div>
      {error && <div role="alert" className="ovEmpty">Working notes did not answer. Sessions can still boot using their fallback context. {/did not answer|is unavailable/i.test(error) ? "" : error} <button type="button" className={styles.button} onClick={() => void load()}><span className="inkSweep" aria-hidden="true" />Retry loading</button></div>}
      {page?.items.length === 0 && <div className="ovEmpty">{cursors.length > 1 ? "No more open items. Previous page goes back." : "No open working notes for " + scopeLabel + ". Add a note when there is something to carry forward."}</div>}
      <div aria-busy={loading || undefined}>
        {page?.items.map(it => <button key={it.id} type="button" className="ovWs" onClick={() => edit(it)}>
          <span className="ovWsId">#{it.id}</span><span className={"ovWsKind ovWsKind-" + it.kind}>{it.kind}</span>
          <span className="ovWsBody"><span>{safeText(it.body, 300)}</span><span className="ovWsMeta">{safeText(it.project || "general", 40)} · {agoIso(it.touchedAt, now)} · version {it.version} · Edit</span></span>
        </button>)}
      </div>
      <div className={styles.tools}>
        {cursors.length > 1 && <button type="button" className={styles.button} disabled={loading} onClick={() => setCursors(c => c.slice(0, -1))}><span className="inkSweep" aria-hidden="true" />Previous page</button>}
        {page?.next && <button type="button" className={styles.button} disabled={loading} onClick={() => setCursors(c => [...c, page.next])}><span className="inkSweep" aria-hidden="true" />Next page</button>}
        <button type="button" className={styles.button} disabled={loading} onClick={() => { clearPreview(); if (before === null) void load(); else setCursors([null]); }}><span className="inkSweep" aria-hidden="true" />Refresh saved notes</button>
      </div>
      <p className="ovPanelFoot">Untouched notes age out after 14 days. To remove one sooner, open it and choose Drop item; confirmation is required and its history stays. General notes join session boot, not a project-only handoff.</p>
    </section>
    </section>
  </>;
}
