"use client";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Reveal } from "../reveal";
import { ToggleRow, StepperRow } from "./settings-client";
import { settingsEndpoint } from "./endpoints";
import styles from "../console.module.css";

/**
 * The Learning section — knobs on what today's learning systems do, every one wired to the code
 * path it names. Settings ride the same gated ../save endpoint as the reader and guest controls
 * (as a `learning` patch); the two actions (clear cache, rebuild graph) ride ../actions. Every
 * write re-renders from the server, because only the server knows what the read path will
 * actually do; a refused write is shown verbatim.
 *
 * Retrieval is on this screen and deliberately NOT a knob: the eval gate is the only door a
 * retrieval change ships through, and a slider here would be a second door with no gate.
 */

type Source = "console" | "env" | "built-in";

export interface LearningVM {
  writable: boolean;
  storeState: "store" | "unconfigured" | "unreachable";
  /** Store-parse and env conflicts, printed verbatim. */
  conflicts: string[];
  ansCache: { on: boolean; source: Source };
  ttl: { days: number; min: number; max: number; source: Source };
  /** null = the store could not answer the count; the row says "—". */
  cacheEntries: number | null;
  /** Cached brain_ask replies in the call log's last 24 h, all doors; null = log unreadable. */
  cacheHits24h: number | null;
  handoff: { bytes: number; min: number; max: number; source: Source };
  watch: {
    supersededLink: { on: boolean; items: number };
    coaccessGap: { on: boolean; items: number };
    correctionChain: { on: boolean; items: number };
  };
  floor: { value: number; min: number; max: number; source: Source };
  graph:
    | { state: "off" | "missing" | "empty" | "unavailable" }
    | {
        state: "built";
        head: string;
        rebuiltAgo: string;
        total: number;
        byKind: Record<string, number>;
      };
}

/** A word per source, shown only when the value did not come from this screen — "set here" on
 *  every row would be noise, but an env override is the one state worth a label. */
function src(s: Source): string {
  return s === "env" ? " · env override" : "";
}

const clamp = (v: number, min: number, max: number) => Math.min(max, Math.max(min, v));

export function LearningClient({ vm }: Readonly<{ vm: LearningVM }>) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const working = pending || busy !== null;
  const disabledAll = !vm.writable || working;

  async function post(
    leaf: "save" | "actions",
    body: Record<string, unknown>,
    tag: string
  ): Promise<Record<string, unknown> | null> {
    setBusy(tag);
    setError(null);
    setNotice(null);
    try {
      const res = await fetch(settingsEndpoint(leaf), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      const json = (await res.json().catch(() => null)) as Record<string, unknown> | null;
      if (!res.ok) {
        setError((json?.error as string | undefined) ?? `the write was refused (${res.status})`);
        return null;
      }
      return json ?? {};
    } catch {
      setError("the write did not reach the server");
      return null;
    } finally {
      setBusy(null);
    }
  }

  async function send(patch: Record<string, unknown>, tag: string) {
    if (await post("save", { learning: patch }, tag)) start(() => router.refresh());
  }

  async function act(action: string, tag: string, said: (json: Record<string, unknown>) => string) {
    const json = await post("actions", { action }, tag);
    if (json) {
      setNotice(said(json));
      start(() => router.refresh());
    }
  }

  /** −/+ for the three numbers; the server re-validates, these bounds only shape the click. */
  function step(field: string, value: number, delta: number, min: number, max: number, tag: string) {
    const next = clamp(value + delta, min, max);
    if (next !== value) send({ [field]: next }, tag);
  }

  const w = vm.watch;
  const g = vm.graph;
  // "—" is the store-could-not-answer state, never zero wearing a dash.
  const entriesWord =
    vm.cacheEntries === null ? "— entries" : `${vm.cacheEntries} entr${vm.cacheEntries === 1 ? "y" : "ies"}`;
  const hitsWord = vm.cacheHits24h === null ? "— hits" : `${vm.cacheHits24h} hit${vm.cacheHits24h === 1 ? "" : "s"}`;

  return (
    <>
      {error && <div className={styles.refused}>{error}</div>}
      {notice && <div className={styles.refused}>{notice}</div>}
      {vm.conflicts.map((c) => (
        <div key={c} className={styles.refused}>{c}</div>
      ))}
      {!vm.writable && (
        <div className={styles.refused}>
          {vm.storeState === "unconfigured"
            ? "No KV store is configured — these knobs have nowhere durable to write. Everything below runs on env and code defaults."
            : "The settings store was unreachable this render — knobs are held, env and code defaults are in force."}
        </div>
      )}

      <div className={styles.setGrid}>
        <section className="card">
          <div className="setHead">
            <span className={styles.label}>Answer cache</span>
            <span className="setHeadMeta">repeat questions at an unchanged head</span>
          </div>
          <div className={styles.setRows}>
            <ToggleRow
              label="answer cache"
              sub={`${entriesWord} stored · ${hitsWord} in the call log's last 24 h (all doors)${src(vm.ansCache.source)}`}
              on={vm.ansCache.on}
              disabled={disabledAll}
              busy={busy === "ansCache"}
              onClick={() => send({ ansCache: !vm.ansCache.on }, "ansCache")}
            />
            <StepperRow
              label="entry TTL"
              sub={`bounds storage only — invalidation is the head SHA in the key${src(vm.ttl.source)}`}
              value={vm.ttl.days}
              display={`${vm.ttl.days} d`}
              disabled={disabledAll}
              onStep={(d) => step("ansCacheTtlDays", vm.ttl.days, d, vm.ttl.min, vm.ttl.max, "ttl")}
            />
            <div className="setRow">
              <span className="setBody">
                <span className="setTitle">clear the cache</span>
                <span className="setSub">deletes every stored answer in this environment; the next asks answer fresh and re-fill</span>
              </span>
              <button
                type="button"
                className={styles.rdBtn}
                disabled={working || vm.storeState !== "store"}
                onClick={() =>
                  act("clear-answer-cache", "clear", (j) => {
                    const n = Number(j.cleared ?? 0);
                    return `answer cache cleared — ${n} entr${n === 1 ? "y" : "ies"} removed`;
                  })
                }
              >
                {busy === "clear" ? "…" : "clear now"}
              </button>
            </div>
          </div>
          <Reveal label="what off means">
            Off, brain_ask skips both the lookup and the store — every ask takes the fresh path,
            which already discloses its model call, and nothing new is pinned. A repeat question
            at an unchanged corpus head then costs a model call again, on both doors. Resolution:
            this switch, else the ANSWER_CACHE env var, else on.
          </Reveal>
        </section>

        <section className="card">
          <div className="setHead">
            <span className={styles.label}>Handoff</span>
            <span className="setHeadMeta">brain_handoff bundle budget</span>
          </div>
          <div className={styles.setRows}>
            <StepperRow
              label="default budget"
              sub={`a call's own budget argument always wins; this decides when none is given${src(vm.handoff.source)}`}
              value={vm.handoff.bytes}
              display={`${Math.round(vm.handoff.bytes / 1000)} KB`}
              disabled={disabledAll}
              onStep={(d) =>
                step("handoffBudget", vm.handoff.bytes, d * 4000, vm.handoff.min, vm.handoff.max, "handoff")
              }
            />
          </div>
          <Reveal label="how the budget resolves">
            Per call: the caller&rsquo;s budget argument, then this setting, then the
            HANDOFF_BUDGET env var, then the built-in 24 KB. Bounds {vm.handoff.min / 1000}
            &ndash;{vm.handoff.max / 1000} KB — the same ceiling and floor the tool enforces on
            the call argument, so nothing set here is unreachable by hand. The bundle&rsquo;s
            coverage line always counts what did not fit.
          </Reveal>
        </section>

        <section className="card">
          <div className="setHead">
            <span className={styles.label}>Graph</span>
            <span className="setHeadMeta">
              {g.state === "built" ? `edges at ${g.head.slice(0, 8)} · rebuilt ${g.rebuiltAgo}` : "derived, never asserted"}
            </span>
          </div>
          <div className={styles.setRows}>
            <div className="setRow">
              <span className="setBody">
                <span className="setTitle">connections graph</span>
                <span className="setSub">
                  {g.state === "built"
                    ? `${g.total} edges — ` +
                      Object.entries(g.byKind)
                        .filter(([, n]) => n > 0)
                        .map(([k, n]) => `${k} ${n}`)
                        .join(" · ")
                    : g.state === "off"
                      ? "no graph store is configured (SUPABASE_URL unset) — nothing to show or rebuild"
                      : g.state === "missing"
                        ? "note_edges is not migrated yet — run scripts/migrate.ts --apply"
                        : g.state === "empty"
                          ? "migrated, never built — the next brain write triggers the first build, or rebuild now"
                          : "the graph store did not answer this render — the graph itself is untouched"}
                </span>
              </span>
            </div>
            <div className="setRow">
              <span className="setBody">
                <span className="setTitle">rebuild now</span>
                <span className="setSub">full replace at the current mirror head; contenders are serialized, a stale head is refused whole</span>
              </span>
              <button
                type="button"
                className={styles.rdBtn}
                disabled={working || (g.state !== "built" && g.state !== "empty")}
                title={
                  g.state !== "built" && g.state !== "empty"
                    ? "needs a migrated, answering graph store"
                    : undefined
                }
                onClick={() =>
                  act("rebuild-graph", "rebuild", (j) =>
                    j.state === "rebuilt"
                      ? `graph rebuilt at ${String(j.head).slice(0, 8)} — ${Number(j.derived)} edges derived server-side, coaccess derived in-store`
                      : `graph already current at ${String(j.head).slice(0, 8)}`
                  )
                }
              >
                {busy === "rebuild" ? "…" : "rebuild"}
              </button>
            </div>
          </div>
          <Reveal label="what a rebuild is">
            The same path every reconcile schedules when the head moves: derive link, tag,
            lexical and correction edges from the corpus in memory, hand them to the
            edges_rebuild RPC, which derives coaccess from note_access in-store and replaces the
            whole table in one transaction. Deleting the graph loses nothing but warm-up time.
          </Reveal>
        </section>

        <section className="card">
          <div className="setHead">
            <span className={styles.label}>Watch checks</span>
            <span className="setHeadMeta">mechanical · watch-tier · re-derived per render</span>
          </div>
          <div className={styles.setRows}>
            <ToggleRow
              label="superseded-link"
              sub={w.supersededLink.on ? `live links to retired pages · ${w.supersededLink.items} in the queue now` : "off — contributes nothing to the inbox"}
              on={w.supersededLink.on}
              disabled={disabledAll}
              busy={busy === "watchSupersededLink"}
              onClick={() => send({ watchSupersededLink: !w.supersededLink.on }, "watchSupersededLink")}
            />
            <ToggleRow
              label="coaccess-gap"
              sub={w.coaccessGap.on ? `co-read pairs neither page names · ${w.coaccessGap.items} in the queue now` : "off — contributes nothing to the inbox"}
              on={w.coaccessGap.on}
              disabled={disabledAll}
              busy={busy === "watchCoaccessGap"}
              onClick={() => send({ watchCoaccessGap: !w.coaccessGap.on }, "watchCoaccessGap")}
            />
            <ToggleRow
              label="correction-chain"
              sub={w.correctionChain.on ? `corrections crossing notes · ${w.correctionChain.items} in the queue now` : "off — contributes nothing to the inbox"}
              on={w.correctionChain.on}
              disabled={disabledAll}
              busy={busy === "watchCorrectionChain"}
              onClick={() => send({ watchCorrectionChain: !w.correctionChain.on }, "watchCorrectionChain")}
            />
            <StepperRow
              label="co-read floor"
              sub={`minimum shared windows before a pair is a candidate — the mutual-top-3 and mention filters then decide what surfaces${src(vm.floor.source)}`}
              value={vm.floor.value}
              disabled={disabledAll}
              onStep={(d) => step("coaccessFloor", vm.floor.value, d, vm.floor.min, vm.floor.max, "floor")}
            />
          </div>
          <Reveal label="how the checks leave">
            An item leaves only because the corpus (or the edge it cites) stopped saying the
            thing — there is no dismiss and no state. An OFF check contributes zero items, so the
            inbox count and the badge reflect the switch on the next render.
          </Reveal>
        </section>

        <section className="card">
          <div className="setHead">
            <span className={styles.label}>Retrieval</span>
            <span className="setHeadMeta">shown, not tunable</span>
          </div>
          <div className={styles.setRows}>
            <div className="setRow">
              <span className="setBody">
                <span className="setTitle">BM25, in-memory — the incumbent</span>
                <span className="setSub">
                  same-run eval 2026-08-11: BM25 95.3% recall@10 · 90.6% recall@5 — every hop
                  shape tied or lost, declined · FTS declined 2026-08-07 (91.2 / 78.8)
                </span>
              </span>
            </div>
            <div className="setRow">
              <span className="setBody">
                <span className="setSub">
                  tuning retrieval is deliberately NOT a knob — the eval gate is the only door
                  (scripts/eval-retrieval.ts against the labelled set)
                </span>
              </span>
            </div>
          </div>
          <Reveal label="why there is no slider">
            Twice now a challenger won at a generous budget and lost at the honest one (FTS
            hybrid, then the hop shapes). A retrieval change ships by beating the incumbent on
            the labelled set at both budgets, and graph-hop stays available off-path as a query
            surface until it does.
          </Reveal>
        </section>
      </div>
    </>
  );
}
