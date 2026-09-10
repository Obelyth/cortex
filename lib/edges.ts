/**
 * edges — the connections graph, derived from the corpus and never asserted by anyone.
 *
 * Layer 2 of the learning layer (spec 2026-08-11). Every edge is rebuilt from git + the access
 * log; deleting the table loses nothing but warm-up time, and nothing here ever writes a note or
 * calls a model — the four kinds this module derives are lexical and structural, and the fifth
 * (coaccess) is pure SQL inside the edges_rebuild RPC, because its raw material (note_access)
 * never leaves Postgres.
 *
 * THE EVIDENCE RULE. Every edge carries the text that justifies it — the referencing line, the
 * shared tags, the matched terms — capped at 200 characters and passed through redact() BEFORE
 * it is stored: evidence is note-derived text, and writing it raw would copy any credential a
 * note holds into a second store the redaction egress does not guard. safeText() then strips
 * control characters and the router's field separator, the same discipline every other
 * note-derived string obeys on its way to a surface.
 *
 * DERIVATION IS DETERMINISTIC. Same corpus in, byte-identical edge list out, in one defined
 * order — the rebuild is a full delete+insert replace, so a rebuild that shuffled rows would
 * manufacture diffs out of nothing and make "did anything change" unanswerable.
 */
import { after } from "next/server";
import { rank, tokenize } from "./narrow";
import { parseFrontmatter, safeText, byName } from "./frontmatter";
import { splitBlocks, isBannerText } from "./verify";
import { redact } from "./redact";
import { LEARNING_POLICY } from "./prediction";

export interface EdgeRow {
  src: string;
  dst: string;
  kind: "link" | "tag" | "coaccess" | "lexical" | "correction";
  weight: number;
  evidence: string;
}

/** Matches the migration's check constraint. One definition here, asserted by tests. */
export const MAX_EVIDENCE = 200;

/** Every evidence string passes through here — redacted, control-stripped, bounded. Exported
 *  because the inbox checks (lib/inbox.ts) surface note-derived evidence too, and two scrubbing
 *  opinions is the drift this repo keeps deleting. */
export function scrubEvidence(s: string): string {
  const clean = safeText(redact(s), MAX_EVIDENCE);
  // safeText can collapse a pathological input to "" and the schema (rightly) refuses an
  // evidence-free edge. An edge whose justification vanished under scrubbing still HAS one;
  // it just cannot be displayed.
  return clean || "(evidence redacted)";
}
const ev = scrubEvidence;
const byCodeUnit = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** An explicit wiki-style reference. Newlines excluded so an unclosed bracket cannot swallow
 *  the rest of the note into one giant "ref". Exported for the inbox checks — one definition
 *  of "what a [[link]] looks like". */
export const WIKILINK = /\[\[([^\[\]\n]+)\]\]/g;

/**
 * Resolve a [[ref]] against the live corpus. The house convention is loose — the brain writes
 * [[search-comparison]] (a basename), [[notes/document-editing]] (a path minus .md) and
 * could write a full path — so resolution tries exact path, then path+".md", then a unique
 * basename match, case-insensitively.
 *
 * AMBIGUITY RESOLVES TO NOTHING. Two notes named setup.md in different folders both match
 * [[setup]]; picking one would draw a confident edge on a guess, which is the one thing a
 * provable graph must never do. No edge is honest; a wrong edge is a lie with evidence attached.
 */
export function resolveRef(ref: string, files: Map<string, string>): string | null {
  const r = ref.trim().toLowerCase();
  if (!r) return null;
  const hits = new Set<string>();
  for (const path of files.keys()) {
    const p = path.toLowerCase();
    if (p === r || p === `${r}.md`) hits.add(path);
    else {
      const base = p.split("/").pop()!;
      if (base === r || base === `${r}.md`) hits.add(path);
    }
  }
  return hits.size === 1 ? [...hits][0] : null;
}

/** `link` — explicit [[..]] references, resolved to live note paths. Directed src → dst;
 *  weight = how many places in src say so. */
export function linkEdges(files: Map<string, string>): EdgeRow[] {
  return [...linkSteps(files)].filter((edge): edge is EdgeRow => edge !== undefined);
}

class DerivationCapacity extends Error {}
function* linkSteps(files: Map<string, string>, max = Infinity): Generator<EdgeRow | undefined> {
  const out = new Map<string, { dst: string; src: string; sites: Array<{ line: number; text: string }> }>();
  for (const [src, text] of files) {
    yield;
    const lines = text.split("\n");
    for (let i = 0; i < lines.length; i++) {
      for (const m of lines[i].matchAll(WIKILINK)) {
        yield;
        const dst = resolveRef(m[1], files);
        if (!dst || dst === src) continue;
        const key = `${src}\u0000${dst}`;
        const e = out.get(key) ?? { src, dst, sites: [] };
        e.sites.push({ line: i + 1, text: lines[i].trim() });
        out.set(key, e);
        if (out.size > max) throw new DerivationCapacity();
      }
    }
  }
  for (const { src, dst, sites } of out.values()) yield {
    src,
    dst,
    kind: "link" as const,
    weight: sites.length,
    // The first referencing phrase, with its line — plus how many more there are, so a count
    // of 3 never renders as a single quote pretending to be the whole story.
    evidence: ev(
      `L${sites[0].line}: ${sites[0].text}` +
        (sites.length > 1 ? ` (+${sites.length - 1} more: L${sites.slice(1).map((s) => s.line).join(", L")})` : "")
    ),
  };
}

/** `tag` — shared frontmatter tags. Symmetric, stored once with src < dst; weight = overlap. */
export function tagEdges(files: Map<string, string>): EdgeRow[] {
  return [...tagSteps(files)].filter((edge): edge is EdgeRow => edge !== undefined);
}

function* tagSteps(files: Map<string, string>): Generator<EdgeRow | undefined> {
  const tagged: Array<{ path: string; tags: string[] }> = [];
  for (const [path, text] of files) {
    yield;
    const tags = parseFrontmatter(text).tags;
    if (tags.length) tagged.push({ path, tags });
  }
  // byName on the paths first, so "src < dst" means the same thing on every machine.
  tagged.sort((a, b) => byName(a.path, b.path));
  for (let i = 0; i < tagged.length; i++) {
    for (let j = i + 1; j < tagged.length; j++) {
      yield;
      const shared = tagged[i].tags.filter((t) => tagged[j].tags.includes(t));
      if (shared.length === 0) continue;
      yield {
        src: tagged[i].path,
        dst: tagged[j].path,
        kind: "tag",
        weight: shared.length,
        evidence: ev(`${shared.length} shared frontmatter tag${shared.length === 1 ? "" : "s"}: ${shared.sort(byCodeUnit).join(", ")}`),
      };
    }
  }
}

/** How many neighbours `lexical` keeps per note. Matches the ask path's shortlist instinct:
 *  the graph is a suggestion surface, not a ranking, and five is enough to be one. */
export const LEXICAL_K = 5;

/**
 * `lexical` — each note's top-K BM25 neighbours, reusing lib/narrow.ts's scorer verbatim: the
 * note's own text is the "question" and the rest of the corpus is ranked against it. One scorer,
 * one opinion of "lexically close" — a second BM25 here would be the dual-implementation drift
 * this repo keeps deleting. Prepared corpus statistics reuse document tokenization; ranking
 * every note against the corpus still requires quadratic pair scoring. Publication uses the
 * bounded builder below (2,000 notes, 8 MiB source, 5 seconds), retaining stale relationships
 * when that work cannot complete. These bounds do not limit primary note storage or search.
 */
export function lexicalEdges(files: Map<string, string>, k = LEXICAL_K): EdgeRow[] {
  return [...lexicalSteps(files, k)].filter((edge): edge is EdgeRow => edge !== undefined);
}

function* lexicalSteps(files: Map<string, string>, k = LEXICAL_K): Generator<EdgeRow | undefined> {
  const n = files.size;
  // Term rarity for the evidence line: in how many notes does each term appear? The scorer
  // knows this internally but does not expose it, and the evidence needs to name the terms
  // that actually carry the match rather than "trust the number".
  const df = new Map<string, number>();
  const toks = new Map<string, Set<string>>();
  for (const [path, text] of files) {
    yield;
    const set = new Set(tokenize(text));
    toks.set(path, set);
    for (const w of set) df.set(w, (df.get(w) ?? 0) + 1);
  }

  for (const [src, text] of [...files.entries()].sort((a, b) => byName(a[0], b[0]))) {
    yield;
    const top = rank(files, text)
      .filter((s) => s.path !== src)
      .slice(0, k);
    for (const { path: dst, score } of top) {
      // The rarest terms the two notes share — rare is what BM25 rewards, so these are the
      // terms the score is actually made of. Ties break alphabetically; determinism again.
      const shared = [...toks.get(src)!]
        .filter((w) => toks.get(dst)!.has(w))
        .sort((a, b) => (df.get(a) ?? 0) - (df.get(b) ?? 0) || (a < b ? -1 : a > b ? 1 : 0))
        .slice(0, 3);
      yield {
        src,
        dst,
        kind: "lexical",
        weight: Math.round(score * 100) / 100,
        evidence: ev(
          `bm25 ${score.toFixed(1)} across the ${n}-note corpus; rarest shared terms: ${shared.join(", ") || "(none survive tokenising)"}`
        ),
      };
    }
  }
}

/** A note path as it appears in prose. The write-policy shapes plus profile.md — an edge can
 *  only point at something the corpus can hold. */
const PATH_IN_TEXT = /\b(?:profile\.md|(?:projects|notes|log|history)\/[A-Za-z0-9._-]+\.md)\b/g;
/** The in-place correction marker, same shape verify.ts keys on. */
const WAS_MARK = /was:\s*["“]/i;

/**
 * `correction` — a retraction marker in one note naming another. This is the graph's version of
 * what verify.ts already knows block by block: a SUPERSEDED banner or a (was:) correction that
 * points across notes is a correction CHAIN, and the inbox's future "live text links a
 * SUPERSEDED note" check (spec v3) will want exactly these edges. Detection reuses
 * verify.ts's isBannerText — the one definition of "this text retracts something".
 */
export function correctionEdges(files: Map<string, string>): EdgeRow[] {
  return [...correctionSteps(files)].filter((edge): edge is EdgeRow => edge !== undefined);
}

function* correctionSteps(files: Map<string, string>, max = Infinity): Generator<EdgeRow | undefined> {
  const out = new Map<string, { src: string; dst: string; sites: Array<{ line: number; text: string }> }>();
  for (const [src, text] of files) {
    yield;
    for (const b of splitBlocks(text)) {
      yield;
      if (!isBannerText(b.text) && !WAS_MARK.test(b.text)) continue;
      for (const m of b.text.match(PATH_IN_TEXT) ?? []) {
        // Only live targets: a marker naming archive/ or a deleted note is history pointing at
        // history, and an edge endpoint the corpus cannot serve would 404 in every surface.
        if (m === src || !files.has(m)) continue;
        const key = `${src}\u0000${m}`;
        const e = out.get(key) ?? { src, dst: m, sites: [] };
        e.sites.push({ line: b.line, text: b.text.trim() });
        out.set(key, e);
        if (out.size > max) throw new DerivationCapacity();
      }
    }
  }
  for (const { src, dst, sites } of out.values()) yield {
    src,
    dst,
    kind: "correction" as const,
    weight: sites.length,
    evidence: ev(`L${sites[0].line}: ${sites[0].text}`),
  };
}

/**
 * Every derivable kind, in one defined order. coaccess is deliberately absent — it is derived
 * inside the RPC from note_access, which never leaves Postgres.
 */
export function deriveEdges(files: Map<string, string>): EdgeRow[] {
  const all = [...linkEdges(files), ...tagEdges(files), ...lexicalEdges(files), ...correctionEdges(files)];
  all.sort((a, b) => a.kind.localeCompare(b.kind) || byName(a.src, b.src) || byName(a.dst, b.dst));
  return all;
}

/* ── The store plumbing — pulse.ts's raw-fetch pattern, same budget posture ── */

const EDGES_TIMEOUT_MS = 10_000;
/** Persisted graph algorithm identity: Unicode tokenization/preparation changed lexical edges. */
export const STRUCTURAL_EDGE_VERSION = "structural-v2-unicode-bm25-1.5-1";

function env(): { base: string; key: string } | null {
  const base = process.env.SUPABASE_URL?.replace(/\/$/, "");
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  return base && key ? { base, key } : null;
}

function pg(e: { base: string; key: string }, path: string, init: RequestInit = {}): Promise<Response> {
  return fetch(`${e.base}/rest/v1/${path}`, {
    ...init,
    headers: {
      apikey: e.key,
      Authorization: `Bearer ${e.key}`,
      "Content-Type": "application/json",
      ...(init.headers ?? {}),
    },
    signal: init.signal ?? AbortSignal.timeout(EDGES_TIMEOUT_MS),
  });
}

/** PostgREST answers 404 for a relation or RPC it cannot find — which, pre-migration, is the
 *  EXPECTED state, not an error. The code must degrade honestly, never crash, never invent. */
const isMissing = (res: Response) => res.status === 404;

/** Status adapters must not infer freshness from a matching Git head. Check after reading
 * rows, including the original build stamp, so a concurrent publication cannot look coherent. */
async function confirmGraphStamp(e: {base:string;key:string}, head:string, builtAt:string, read:GraphRequest=(path,init)=>pg(e,path,init)): Promise<"current"|"missing"|"unavailable"> {
  const res=await read("rpc/edges_freshness",{method:"POST",body:JSON.stringify({new_head:head})});
  if(isMissing(res))return "missing";
  if(!res.ok)return "unavailable";
  const value=await res.json();
  return value?.state==="current" && value.policy===LEARNING_POLICY && value.structure===STRUCTURAL_EDGE_VERSION && value.builtStructure===STRUCTURAL_EDGE_VERSION && value.builtAt===builtAt ? "current" : "unavailable";
}

export type RebuildResult =
  | { state: "off" | "missing" }
  | { state: "current" | "stale-head" | "stale-input" | "busy" | "capacity" | "budget"; head: string }
  | { state: "rebuilt"; head: string; derived: number };

/** What one edge costs in the payload edges_rebuild_v3 measures: octet_length(edges::text), the
 * jsonb rendering, not JSON.stringify's. jsonb text puts a space after every colon and comma, so a
 * flat object of k members is 2k-1 bytes longer than its compact form and each array separator is
 * two bytes, not one. Counting the compact form let the client admit ~2 MB more than the database
 * accepts at 200k rows, and the refusal arrived only after the upload. */
export function jsonbTextBytes(row: EdgeRow): number {
  return Buffer.byteLength(JSON.stringify(row)) + 2 * Object.keys(row).length + 1;
}

/** Shared generators preserve the pure derivers while allowing bounded background execution.
 * Yield every 128 units (and each lexical rank); checks bracket each bounded unit. A single
 * rank/tokenization is not preemptible, so the 5s budget can overshoot by one bounded unit. */
export async function deriveEdgesBounded(files: Map<string,string>): Promise<EdgeRow[] | "capacity" | "budget"> {
  if (files.size > 2000) return "capacity";
  let bytes=0;
  for (const [path,text] of files) {bytes += Buffer.byteLength(path)+Buffer.byteLength(text);if(bytes>8*1024*1024)return "capacity";}
  const started=performance.now(), all:EdgeRow[]=[];
  let wireBytes=2;
  const lexical=lexicalSteps(files);
  for (const steps of [linkSteps(files,200000),tagSteps(files),lexical,correctionSteps(files,200000)]) {
    let units=0;
    for (;;) {
      if (performance.now()-started>5000) return "budget";
      let step: IteratorResult<EdgeRow | undefined>;
      try {step=steps.next();} catch(e) {if(e instanceof DerivationCapacity)return "capacity";throw e;}
      if (performance.now()-started>5000) return "budget";
      if (step.done) break;
      if (step.value) {
        wireBytes += jsonbTextBytes(step.value);
        // Checked before the push, so the array never holds a 200,001st row and the measured
        // payload never crosses the ceiling; edges_rebuild_v3 refuses the same two limits.
        if (all.length >= 200000 || wireBytes > 16 * 1024 * 1024) return "capacity";
        all.push(step.value);
      }
      if (++units % 128 === 0 || steps === lexical) await new Promise<void>(resolve=>setImmediate(resolve));
    }
    await new Promise<void>(resolve=>setImmediate(resolve));
  }
  all.sort((a,b)=>a.kind.localeCompare(b.kind)||byName(a.src,b.src)||byName(a.dst,b.dst));
  return performance.now()-started>5000 ? "budget" : all;
}

let activeRebuild: {head:string; force:boolean; promise:Promise<RebuildResult>} | null = null;
export function rebuildEdges(files: Map<string,string>, head:string, opts:{force?:boolean}={}): Promise<RebuildResult> {
  if (activeRebuild) return activeRebuild.head===head && (!opts.force || activeRebuild.force) ? activeRebuild.promise : Promise.resolve({state:"busy",head});
  const promise = rebuild(files,head,opts).finally(()=>{activeRebuild=null;});
  activeRebuild={head,force:Boolean(opts.force),promise};
  return promise;
}
async function rebuild(files:Map<string,string>,head:string,opts:{force?:boolean}):Promise<RebuildResult> {
  const e=env();if(!e)return {state:"off"};
  const check=await pg(e,"rpc/edges_freshness",{method:"POST",body:JSON.stringify({new_head:head})});
  if(isMissing(check))return {state:"missing"};
  if(!check.ok)throw new Error(`edges freshness: HTTP ${check.status}`);
  const input=await check.json();
  if (!input || input.policy!==LEARNING_POLICY || input.structure!==STRUCTURAL_EDGE_VERSION || typeof input.watermark!=="string" || typeof input.cutoff!=="string" || typeof input.structural!=="boolean") throw new Error("edges freshness: invalid identity");
  if(input.state==="stale-head")return {state:"stale-head",head};
  if(input.state==="current"&&!opts.force)return {state:"current",head};
  if(input.state!=="stale"&&input.state!=="current")throw new Error("edges freshness: invalid state");
  let edges:EdgeRow[]|null=null;
  if(input.structural||opts.force) {
    const derived=await deriveEdgesBounded(files);
    if(typeof derived==="string")return {state:derived,head};
    edges=derived;
  }
  const res=await pg(e,"rpc/edges_rebuild_v3",{method:"POST",body:JSON.stringify({new_head:head,expected_watermark:input.watermark,expected_cutoff:input.cutoff,expected_structure:STRUCTURAL_EDGE_VERSION,edges,force:Boolean(opts.force)})});
  if(isMissing(res))return {state:"missing"};
  if(!res.ok)throw new Error(`edges rebuild: HTTP ${res.status}; outcome unknown until next freshness check`);
  const state=await res.json();
  if(state==="rebuilt")return {state,head,derived:edges?.length??0};
  if(["current","stale-head","stale-input","busy","capacity"].includes(state))return {state,head};
  throw new Error("edges rebuild: invalid outcome");
}

let scheduled=false, nextCheck=0;
let pendingCorpus:{files:Map<string,string>;head:string}|null=null;
/** Every corpus return path may call this. No fetch/derivation starts before after() runs. */
export function scheduleEdgeRebuild(files:Map<string,string>,head:string):void {
  if(!env())return;
  // Retain only the latest observation, including while another callback is queued/running.
  // No timer: a later request must arm the next callback once the process-wide cooldown ends.
  pendingCorpus={files,head};
  if(scheduled||Date.now()<nextCheck)return;
  scheduled=true;
  try {
    after(async()=>{
      const {files,head}=pendingCorpus!;
      pendingCorpus=null;
      nextCheck=Date.now()+60_000;
      try {
        const result=await rebuildEdges(files,head);
        if(result.state!=="current"&&result.state!=="off")console.log(`[edges] refresh ${result.state} at ${head.slice(0,8)}`);
      } catch(e) {console.error(`[edges] refresh unavailable; last confirmed graph may be stale, outcome requires recheck: ${String(e)}`);}
      finally {scheduled=false;}
    });
  } catch(e) {
    scheduled=false;
    console.error(`[edges] after() unavailable; refresh not started: ${String(e)}`);
  }
}

/* ── The console read path ── */

export interface NoteEdge {
  /** The other end of the edge, whichever column this note sat in. */
  other: string;
  /** Whether this note is the source, the target, or the kind is symmetric. */
  dir: "out" | "in" | "both";
  kind: EdgeRow["kind"];
  weight: number;
  evidence: string;
}

/** tag and coaccess are stored once (src < dst) and mean the same thing read backwards. */
const SYMMETRIC = new Set<EdgeRow["kind"]>(["tag", "coaccess"]);

/** Edges the panel shows per note per kind — a glance, not the whole adjacency list. The panel
 *  says "top 5 by weight" out loud, because a truncated list that does not announce itself
 *  reads as the complete set. */
export const PANEL_TOP_K = 5;

/**
 * Group a flat edge list into each note's view of it, capped at PANEL_TOP_K per kind by weight
 * (path as the deterministic tiebreak). Pure, so the fixture tests can hold it still.
 */
export function groupEdges(rows: EdgeRow[], topK = PANEL_TOP_K): Record<string, NoteEdge[]> {
  const byNote = new Map<string, NoteEdge[]>();
  const add = (note: string, e: NoteEdge) => {
    if (!byNote.has(note)) byNote.set(note, []);
    byNote.get(note)!.push(e);
  };
  for (const r of rows) {
    const sym = SYMMETRIC.has(r.kind);
    add(r.src, { other: r.dst, dir: sym ? "both" : "out", kind: r.kind, weight: r.weight, evidence: r.evidence });
    add(r.dst, { other: r.src, dir: sym ? "both" : "in", kind: r.kind, weight: r.weight, evidence: r.evidence });
  }
  const out: Record<string, NoteEdge[]> = {};
  for (const [note, edges] of byNote) {
    const kept: NoteEdge[] = [];
    const perKind = new Map<string, NoteEdge[]>();
    for (const e of edges) {
      if (!perKind.has(e.kind)) perKind.set(e.kind, []);
      perKind.get(e.kind)!.push(e);
    }
    for (const kind of [...perKind.keys()].sort(byCodeUnit)) {
      kept.push(
        ...perKind
          .get(kind)!
          .sort((a, b) => b.weight - a.weight || byName(a.other, b.other))
          .slice(0, topK)
      );
    }
    out[note] = kept;
  }
  return out;
}

/**
 * Every edge touching ONE note, both columns — the handoff bundle's read. Targeted rather than
 * pagedEdges() because the bundle needs one note's neighbourhood, not the whole adjacency list:
 * at 1,500 edges the full read is two paged round-trips of mostly-discarded rows on a path a
 * session is actively waiting on.
 *
 * Null for every not-an-answer state — store off, table missing, store unwell — because the
 * bundle must degrade to "graph unavailable" honestly rather than render an empty neighbourhood
 * as "this project has no connections". The two claims read the same and mean opposite things.
 */
export async function edgesFor(path: string): Promise<EdgeRow[] | null> {
  const e = env();
  if (!e) return null;
  try {
    // PostgREST or= syntax; the path is quoted because note paths carry dots and slashes, and
    // the whole filter is URI-encoded so no path byte can escape into query structure.
    const filter = encodeURIComponent(`(src.eq."${path}",dst.eq."${path}")`);
    // Paged like every other graph read: PostgREST answers an un-Ranged GET with its max-rows
    // (Supabase's default is 1,000) and a 200, and one request cannot tell 1,000-of-1,000 from
    // 1,000-of-1,500. A hub note past that cap would have lost neighbours silently.
    const rows = await pagedEdges(graphReader(e), `note_edges?select=src,dst,kind,weight,evidence&or=${filter}&order=src.asc,dst.asc,kind.asc`)
      .catch(notAnswered);
    if (!rows) return null;
    // Same egress rule as edgesPulse: evidence was scrubbed at build time, but older rows may
    // predate the rule, and one opinion applied twice cannot drift.
    for (const r of rows) r.evidence = ev(r.evidence);
    return rows;
  } catch (err) {
    console.error(`[edges] edgesFor(${path}) unavailable — the bundle renders without neighbours: ${String(err)}`);
    return null;
  }
}

/** An HTTP refusal (the table missing pre-migration, the store unwell) is a not-an-answer
 *  state these readers report as null without a log line, exactly as their single un-Ranged
 *  GET did; anything else — the read budget, the row cap — is a fault worth logging. */
function notAnswered(err: unknown): null {
  if (typeof (err as { status?: unknown })?.status === "number") return null;
  throw err;
}

/**
 * Every coaccess edge in the store — the raw material for the inbox's "co-read but never
 * linked" check. Coaccess is the one kind that CANNOT be derived from the corpus in memory
 * (its raw material, note_access, never leaves Postgres), so this is the single store read the
 * inbox checks make.
 *
 * Null for every not-an-answer state — store off, table missing, store unwell — for the same
 * reason edgesFor() returns null: the check must go silently absent rather than render "no
 * co-access structure" out of a table it could not reach. The two claims read the same and
 * mean opposite things.
 */
export async function coaccessEdges(): Promise<EdgeRow[] | null> {
  const e = env();
  if (!e) return null;
  try {
    // Paged, for the reason edgesFor gives: one un-Ranged GET stops at the provider's max-rows
    // and says nothing about it. (src, dst) is unique within one kind, so the order is total
    // and the pages cannot overlap or skip.
    const rows = await pagedEdges(graphReader(e), "note_edges?select=src,dst,kind,weight,evidence&kind=eq.coaccess&order=weight.desc,src.asc,dst.asc")
      .catch(notAnswered);
    if (!rows) return null;
    // Evidence was scrubbed at build time, but these strings land on the console and older
    // rows may predate the rule — one opinion applied twice cannot drift.
    for (const r of rows) r.evidence = ev(r.evidence);
    return rows;
  } catch (err) {
    console.error(`[edges] coaccessEdges unavailable — the co-read inbox check goes absent: ${String(err)}`);
    return null;
  }
}

/**
 * The whole graph, flat — shared retrieval and handoff infrastructure. This returns rows, not
 * rendering opinions. Null for every not-an-answer state — store off, table missing, store
 * unwell — so callers never turn an unavailable graph into "this brain has no structure."
 */
export async function allEdges(): Promise<EdgeRow[] | null> {
  const e = env();
  if (!e) return null;
  try {
    const read=graphReader(e);
    const stamp=await read("edges_state?select=built_head,built_at&id=is.true");
    if(!stamp.ok)return null;
    const states=await stamp.json();
    if(!states[0]?.built_head)return null;
    const rows = await pagedEdges(read);
    if(await confirmGraphStamp(e,states[0].built_head,states[0].built_at,read)!=="current")return null;
    // Evidence was scrubbed at build time, but graph consumers are egresses and older rows may
    // predate the rule — one opinion applied twice cannot drift.
    for (const r of rows) r.evidence = ev(r.evidence);
    return rows;
  } catch (err) {
    console.error(`[edges] allEdges unavailable — no partial graph returned: ${String(err)}`);
    return null;
  }
}

export type EdgesPulse =
  /** SUPABASE_URL unset — the opt-in law: the panel does not render at all. */
  | { state: "off" }
  /** The table does not exist yet. The honest state until the migration is applied. */
  | { state: "missing" }
  /** Migrated, never built. The next head advance (or the manual script) fills it. */
  | { state: "empty" }
  /** Configured and migrated, but the store did not answer. The graph itself is untouched. */
  | { state: "unavailable" }
  | { state: "built"; head: string; builtAt: string; byNote: Record<string, NoteEdge[]> };

/** Paged, for the same reason mirror.ts pages: PostgREST caps a response at its own max-rows,
 *  and trusting one response would silently serve a partial graph the day it outgrows the cap. */
type GraphRequest=(path:string,init?:RequestInit)=>Promise<Response>;
/** Read safety, not storage limits. All pages, stamp and freshness share this budget. Body
 * bytes are charged while streaming; a gateway that ignores pagination never yields partial success. */
function graphReader(e:{base:string;key:string}):GraphRequest {
  const deadline=performance.now()+10_000;let bytes=0;
  return async(path,init)=>{
    const remaining=Math.floor(deadline-performance.now());
    if(remaining<=0)throw new Error("graph read budget exceeded");
    const controller=new AbortController();let timer:ReturnType<typeof setTimeout>|undefined;
    let reader:ReadableStreamDefaultReader<Uint8Array>|undefined;
    try {
      return await Promise.race([
        (async()=>{
          const res=await pg(e,path,{...init,signal:controller.signal});
          reader=res.body?.getReader();const chunks:Uint8Array[]=[];
          if(reader)for(;;){const chunk=await reader.read();if(chunk.done)break;bytes+=chunk.value.byteLength;
            if(bytes>64*1024*1024)throw new Error("graph response capacity exceeded");chunks.push(chunk.value);}
          if(performance.now()>deadline)throw new Error("graph read budget exceeded");
          return new Response(res.status===204?null:Buffer.concat(chunks),{status:res.status,headers:res.headers});
        })(),
        new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new Error("graph read budget exceeded")),remaining);}),
      ]);
    }finally{clearTimeout(timer);controller.abort();void reader?.cancel().catch(()=>{});}
  };
}

/** Every row `query` selects, in pages. The query must carry a total order, or two pages could
 *  overlap or skip a row; every caller here orders on a key that is unique for what it filters. */
async function pagedEdges(read:GraphRequest, query="note_edges?select=src,dst,kind,weight,evidence&order=src.asc,dst.asc,kind.asc"): Promise<EdgeRow[]> {
  const out: EdgeRow[] = [];
  const PAGE = 1000;
  for (let from = 0; ; ) {
    const res = await read(query, {
      headers: { Range: `${from}-${from + PAGE - 1}`, "Range-Unit": "items" },
    });
    if (!res.ok) throw Object.assign(new Error(`edges: GET note_edges ${res.status}`), { status: res.status });
    const rows = (await res.json()) as EdgeRow[];
    if(!Array.isArray(rows)||rows.length>PAGE||out.length+rows.length>350_000)throw new Error("graph row capacity exceeded");
    if(rows.length===0)return out;
    out.push(...rows);
    from+=rows.length;
  }
}

/**
 * What the corpus screen needs, in one call: the build stamp and every note's grouped edges.
 * FAILS SOFT — a console that 500s because a derived table blinked has its priorities backwards
 * — but never fails SILENT: each degraded state names itself so the screen can say what is
 * actually going on and what would change it.
 */
export async function edgesPulse(): Promise<EdgesPulse> {
  const e = env();
  if (!e) return { state: "off" };
  try {
    const read=graphReader(e);
    const stateRes = await read("edges_state?select=built_head,built_at&id=is.true");
    if (isMissing(stateRes)) return { state: "missing" };
    if (!stateRes.ok) return { state: "unavailable" };
    const stateRows = (await stateRes.json()) as Array<{ built_head: string; built_at: string }>;
    // A state row with an empty head is the RPC's serialization bootstrap, not a build.
    if (!stateRows[0]?.built_head) return { state: "empty" };

    const rows = await pagedEdges(read);
    // Evidence was scrubbed at build time, but the console is an egress and older rows may
    // predate the rule — redact() is cheap and one opinion applied twice cannot drift.
    for (const r of rows) r.evidence = ev(r.evidence);
    const freshness=await confirmGraphStamp(e,stateRows[0].built_head,stateRows[0].built_at,read);
    if(freshness!=="current")return {state:freshness};
    return {
      state: "built",
      head: stateRows[0].built_head,
      builtAt: stateRows[0].built_at,
      byNote: groupEdges(rows),
    };
  } catch (err) {
    console.error(`[edges] pulse unavailable — the corpus screen renders without connections: ${String(err)}`);
    return { state: "unavailable" };
  }
}


export type EdgesSummary =
  | { state: "off" }
  | { state: "missing" }
  | { state: "empty" }
  | { state: "unavailable" }
  | {
      state: "built";
      head: string;
      builtAt: string;
      byKind: Record<EdgeRow["kind"], number>;
      total: number;
    };

/** A bounded diagnostic read of graph readiness. Unlike edgesSummary(), this never pages the
 * edge rows: one state read plus one freshness check is enough to say whether the derived
 * relationship store is current without hauling evidence or counting an unbounded graph. */
export async function edgesBuildStatus(): Promise<"off" | "missing" | "empty" | "unavailable" | "current"> {
  const e = env();
  if (!e) return "off";
  try {
    const stateRes = await pg(e, "edges_state?select=built_head,built_at&id=is.true&limit=1");
    if (isMissing(stateRes)) return "missing";
    if (!stateRes.ok) return "unavailable";
    const rows = (await stateRes.json()) as Array<{ built_head: string; built_at: string }>;
    if (!rows[0]?.built_head) return "empty";
    return await confirmGraphStamp(e, rows[0].built_head, rows[0].built_at) === "current" ? "current" : "unavailable";
  } catch {
    return "unavailable";
  }
}
/**
 * The build stamp and the edge counts by kind — the settings screen's read. Same states and the
 * same numbers as edgesPulse (one build stamp, one table), but it fetches only the `kind`
 * column: a status row needs counts, and hauling every evidence string to add five integers
 * would make the settings render pay the corpus screen's price.
 */
export async function edgesSummary(): Promise<EdgesSummary> {
  const e = env();
  if (!e) return { state: "off" };
  try {
    const read=graphReader(e);
    const stateRes = await read("edges_state?select=built_head,built_at&id=is.true");
    if (isMissing(stateRes)) return { state: "missing" };
    if (!stateRes.ok) return { state: "unavailable" };
    const stateRows = (await stateRes.json()) as Array<{ built_head: string; built_at: string }>;
    if (!stateRows[0]?.built_head) return { state: "empty" };

    const byKind: Record<EdgeRow["kind"], number> = { link: 0, tag: 0, coaccess: 0, lexical: 0, correction: 0 };
    let total = 0;
    // Paged like pagedEdges and for the same reason: PostgREST caps a response at its own
    // max-rows, and a count read off one truncated page would understate the graph quietly.
    const PAGE = 1000;
    for (let from = 0; ; ) {
      const res = await read("note_edges?select=kind&order=src.asc,dst.asc,kind.asc", {
        headers: { Range: `${from}-${from + PAGE - 1}`, "Range-Unit": "items" },
      });
      if (!res.ok) return { state: "unavailable" };
      const rows = (await res.json()) as Array<{ kind: EdgeRow["kind"] }>;
      if(!Array.isArray(rows)||rows.length>PAGE||total+rows.length>350_000)return {state:"unavailable"};
      if(rows.length===0)break;
      for (const r of rows) {
        if (r.kind in byKind) byKind[r.kind]++;
        total++;
      }
      from+=rows.length;
    }
    const freshness=await confirmGraphStamp(e,stateRows[0].built_head,stateRows[0].built_at,read);
    if(freshness!=="current")return {state:freshness};
    return { state: "built", head: stateRows[0].built_head, builtAt: stateRows[0].built_at, byKind, total };
  } catch (err) {
    console.error(`[edges] summary unavailable — the settings row renders degraded: ${String(err)}`);
    return { state: "unavailable" };
  }
}
