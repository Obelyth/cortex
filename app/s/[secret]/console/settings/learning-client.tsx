"use client";
import { HeldLine, Stepper, Switch, useWrites } from "./settings-client";
import { settingsEndpoint } from "./endpoints";
import { Row, Val } from "./rows";

/**
 * The Learning group — knobs on what today's learning systems do, every one wired to the code
 * path it names. Settings ride the same gated ../save endpoint as the reader and guest controls
 * (as a `learning` patch); the two actions (clear cache, rebuild graph) ride ../actions. Every
 * write re-renders from the server, because only the server knows what the read path will
 * actually do; a refused write is shown verbatim on the sheet's one refused line.
 *
 * Retrieval is on this screen and deliberately NOT a knob: the eval gate is the only door a
 * retrieval change ships through, and a slider here would be a second door with no gate.
 */

type Source = "console" | "env" | "built-in";

export interface LearningVM {
  writable: boolean;
  storeState: "store" | "unconfigured" | "unreachable";
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
    oversizedPage: { on: boolean; items: number };
  };
  floor: { value: number; min: number; max: number; source: Source };
  graph:
    | { state: "off" | "missing" | "empty" | "unavailable" }
    | { state: "built"; head: string; rebuiltAgo: string; total: number; byKind: Record<string, number> };
  /** Retrieval, shown not tuned: the real constants from lib/ask. */
  retrieval: { k: number; budgetBytes: number };
}

/** A word per source, shown only when the value did not come from this screen — "set here" on
 *  every row would be noise, but an env override is the one state worth a label. */
const src = (s: Source): string => (s === "env" ? " · env override" : "");
const clamp = (v: number, min: number, max: number) => Math.min(max, Math.max(min, v));

export function LearningRows({ vm }: Readonly<{ vm: LearningVM }>) {
  const w = useWrites();
  const disabledAll = !vm.writable || w.working;
  const send = (patch: Record<string, unknown>, tag: string) => w.post(settingsEndpoint("save"), { learning: patch }, tag);
  const act = (action: string, tag: string, said: (json: Record<string, unknown>) => string) =>
    w.post(settingsEndpoint("actions"), { action }, tag, said);
  /** −/+ for the three numbers; the server re-validates, these bounds only shape the click. */
  function step(field: string, value: number, delta: number, min: number, max: number) {
    const next = clamp(value + delta, min, max);
    if (next !== value) void send({ [field]: next }, `learning.${field}`);
  }

  const g = vm.graph;
  const W = vm.watch;
  // "—" is the store-could-not-answer state, never zero wearing a dash.
  const entries = vm.cacheEntries === null ? "— entries" : `${vm.cacheEntries} entr${vm.cacheEntries === 1 ? "y" : "ies"}`;
  const hits = vm.cacheHits24h === null ? "— hits" : `${vm.cacheHits24h} hit${vm.cacheHits24h === 1 ? "" : "s"}`;
  const watchSub = (on: boolean, what: string, n: number) => (on ? `${what} · ${n} open` : "off — contributes nothing to the inbox");
  const graphSub =
    g.state === "built"
      ? `${g.total} ties · rebuilt ${g.rebuiltAgo} at ${g.head.slice(0, 8)}`
      : g.state === "off"
        ? "no graph store is configured (SUPABASE_URL unset) — nothing to show or rebuild"
        : g.state === "missing"
          ? "the database needs an upgrade before connections can be built — review database checks in Ops; an administrator must handle initial or legacy setup"
          : g.state === "empty"
            ? "migrated, never built — the next brain write triggers the first build, or rebuild now"
            : "the graph store did not answer this render — the graph itself is untouched";
  const canRebuild = g.state === "built" || g.state === "empty";

  return (
    <>
      {!vm.writable && (
        <HeldLine>
          {vm.storeState === "unconfigured"
            ? "Preference store not connected — these controls have nowhere durable to write. Deployment defaults are in use."
            : "The preference store was unreachable this render. Saving is paused; deployment defaults are in use."}
        </HeldLine>
      )}
      <Row label="Answer cache" sub={`${entries} · ${hits} in the call log's last 24 h · a cached ask costs no model call${src(vm.ansCache.source)}`}>
        <Switch label="Answer cache" on={vm.ansCache.on} disabled={disabledAll} busy={w.busy === "learning.ansCache"} onClick={() => void send({ ansCache: !vm.ansCache.on }, "learning.ansCache")} />
      </Row>
      <Row label="Cache lifetime · days" sub={`an answer is replayed only at the same commit — the head SHA is in the key · ${vm.ttl.min}–${vm.ttl.max}${src(vm.ttl.source)}`}>
        <Stepper label="cache lifetime" value={vm.ttl.days} display={`${vm.ttl.days} d`} disabled={disabledAll} onStep={(d) => step("ansCacheTtlDays", vm.ttl.days, d, vm.ttl.min, vm.ttl.max)} />
      </Row>
      <Row label="Clear the cache" sub="deletes every stored answer in this environment; the next asks answer fresh and re-fill">
        <button
          type="button"
          className="inkControl setBtn"
          disabled={w.working || vm.storeState !== "store"}
          onClick={() =>
            void act("clear-answer-cache", "clear", (j) => {
              const n = Number(j.cleared ?? 0);
              return `answer cache cleared — ${n} entr${n === 1 ? "y" : "ies"} removed`;
            })
          }
        ><span className="inkSweep" aria-hidden="true" />
          {w.busy === "clear" ? "…" : "clear now"}
        </button>
      </Row>
      <Row label="Handoff size limit · KB" sub={`Limits the context packed for the next session. Items that do not fit are reported as excluded; a caller can request a different budget. Range: ${vm.handoff.min / 1000}–${vm.handoff.max / 1000} KB${src(vm.handoff.source)}`}>
        <Stepper label="handoff budget" value={vm.handoff.bytes} display={`${Math.round(vm.handoff.bytes / 1000)} KB`} disabled={disabledAll} onStep={(d) => step("handoffBudget", vm.handoff.bytes, d * 4000, vm.handoff.min, vm.handoff.max)} />
      </Row>
      <Row label="Watch · superseded links" sub={watchSub(W.supersededLink.on, "a [[link]] that points into a retracted passage", W.supersededLink.items)}>
        <Switch label="Watch superseded links" on={W.supersededLink.on} disabled={disabledAll} busy={w.busy === "learning.watchSupersededLink"} onClick={() => void send({ watchSupersededLink: !W.supersededLink.on }, "learning.watchSupersededLink")} />
      </Row>
      <Row label="Watch · co-read, never linked" sub={watchSub(W.coaccessGap.on, `pairs read together ${vm.floor.value}+ times with no link between them`, W.coaccessGap.items)}>
        <Switch label="Watch co-read pairs" on={W.coaccessGap.on} disabled={disabledAll} busy={w.busy === "learning.watchCoaccessGap"} onClick={() => void send({ watchCoaccessGap: !W.coaccessGap.on }, "learning.watchCoaccessGap")} />
      </Row>
      <Row label="Related-note suggestion threshold" sub={`Minimum reading windows shared by two notes before a link can be suggested. Relevance filters still apply; reaching this number does not add a link. Range: ${vm.floor.min}–${vm.floor.max}${src(vm.floor.source)}`}>
        <Stepper label="related-note suggestion threshold" value={vm.floor.value} disabled={disabledAll} onStep={(d) => step("coaccessFloor", vm.floor.value, d, vm.floor.min, vm.floor.max)} />
      </Row>
      <Row label="Watch · correction chains" sub={watchSub(W.correctionChain.on, "corrections crossing notes, three deep, that could collapse to one", W.correctionChain.items)}>
        <Switch label="Watch correction chains" on={W.correctionChain.on} disabled={disabledAll} busy={w.busy === "learning.watchCorrectionChain"} onClick={() => void send({ watchCorrectionChain: !W.correctionChain.on }, "learning.watchCorrectionChain")} />
      </Row>
      <Row label="Watch · oversized pages" sub={watchSub(W.oversizedPage.on, "a page past the router budget, a split candidate", W.oversizedPage.items)}>
        <Switch label="Watch oversized pages" on={W.oversizedPage.on} disabled={disabledAll} busy={w.busy === "learning.watchOversizedPage"} onClick={() => void send({ watchOversizedPage: !W.oversizedPage.on }, "learning.watchOversizedPage")} />
      </Row>
      <Row label="Note connections index" sub={graphSub}>
        <Val tone="muted">
          {g.state === "built"
            ? Object.entries(g.byKind).filter(([, n]) => n > 0).map(([k, n]) => `${k} ${n}`).join(" · ") || "no ties"
            : "—"}
        </Val>
      </Row>
      <Row label="Rebuild note connections" sub="Recalculates connections from the current notes mirror. It does not edit notes or restore the removed Map. If the notes change during the rebuild, that result is refused.">
        <button
          type="button"
          className="inkControl setBtn"
          disabled={w.working || !canRebuild}
          title={canRebuild ? undefined : "needs a migrated, answering graph store"}
          onClick={() =>
            void act("rebuild-graph", "rebuild", (j) =>
              j.state === "rebuilt"
                ? `graph rebuilt at ${String(j.head).slice(0, 8)} — ${Number(j.derived)} edges derived server-side, coaccess derived in-store`
                : `graph already current at ${String(j.head).slice(0, 8)}`
            )
          }
        ><span className="inkSweep" aria-hidden="true" />
          {w.busy === "rebuild" ? "…" : "rebuild"}
        </button>
      </Row>
      <Row
        label="Retrieval limits · read-only"
        sub="Maximum notes and reading budget for the built-in retrieval path. Changes must pass the labelled recall tests before release; these are configuration limits, not a live accuracy measurement."
      >
        <Val tone="muted">{`k=${vm.retrieval.k} · ${Math.round(vm.retrieval.budgetBytes / 1000)} KB · BM25 in-memory`}</Val>
      </Row>
    </>
  );
}
