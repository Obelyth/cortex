/**
 * mirror — the corpus, served from Postgres instead of a tarball, without ever owning it.
 *
 * GIT STAYS THE AUTHORITY. Every row records the commit its content came from, and the mirror's
 * one promise is that it can always be rebuilt from the repo: backfill IS `syncMirror` against an
 * empty store — there is no separate import path to rot. When the mirror is behind, cortex heals
 * it inline; when the mirror is broken, unreachable, or simply not configured, every caller falls
 * back to the tarball path unchanged. `SUPABASE_URL` unset means yesterday's behaviour, exactly.
 *
 * WHY RAW PostgREST FETCH, not supabase-js. The store needs five operations. The house pattern
 * (lib/reader.ts) is raw fetch with a hard per-request budget and loud failure; a client library
 * would add its own retry, caching and version churn between this repo and the public port for
 * five REST calls. The seam for tests is the `MirrorStore` interface, same as `Reader`.
 */
import { branch, gh, repo } from "./github";
import type { CompareResult } from "./github";
import { storableText } from "./frontmatter";

/** Rows written by the retired Map before its removal. Reads and counts exclude them, while
 * reconciliation deliberately leaves them in customer-owned storage. */
export const LEGACY_NON_NOTE_PATHS = ["tools/atlas-snapshot.json"] as const;
const LEGACY_NON_NOTE_SET = new Set<string>(LEGACY_NON_NOTE_PATHS);

export interface NoteRow {
  path: string;
  content: string;
  commit_sha: string;
  /** When git last changed this file. The patch path sends the head commit's date, which IS
   *  when those files changed; a full sync sends null, because it does not know. The store's
   *  rule (sync_apply, migration 20260905100000) is that CONTENT decides: a row whose content
   *  did not change keeps the date it has whatever the caller sent, a row whose content changed
   *  takes the caller's value, and a null is learned later by dateUndatedNotes. */
  last_commit_at?: string | null;
}

export interface ScoreRow {
  path: string;
  temperature: "hot" | "warm" | "cold";
  score: number;
  reads: number;
}

export interface AccessRow {
  path: string;
  tool: string;
  surface: string;
  mode: string;
}

export interface MirrorSnapshot {
  /** Empty string is the seeded cold-start sentinel; null is retained for pre-seed stores. */
  head: string | null;
  rows: NoteRow[];
}

export interface MirrorStore {
  /** Head and rows observed by one database statement under one MVCC snapshot. */
  snapshot(): Promise<MirrorSnapshot>;
  /** Administrative status only. Corpus assembly must use snapshot(), never this scalar read. */
  head(): Promise<string | null>;
  /** Just the paths. The stale-row computation needs nothing else, and snapshot() ships every
   * note's full content — half a megabyte downloaded and thrown away to derive this list. */
  paths(): Promise<string[]>;
  /**
   * The ONLY write path for rows, and it is atomic: upserts, removes and the head advance apply
   * in one transaction, guarded by a compare-and-swap on the head the caller believed it was
   * moving from. Returns false when another instance won the race — the loser's entire batch is
   * refused, never half-applied.
   *
   * This shape exists because the review proved the granular predecessor (upsert/remove/setHead
   * as independent calls) wrong twice: a stalled write landing after a newer sync left a stale
   * row under a current head forever, and two interleaved reconcilers could compose a state
   * neither intended. Client-side sequencing cannot fix racing transactions; a row lock can.
   */
  apply(expectedHead: string | null, newHead: string, upserts: NoteRow[], removes: string[]): Promise<boolean>;
  /** Fire-and-forget from callers; failures are logged, never surfaced. */
  access(rows: AccessRow[]): Promise<void>;
  /** Every note's temperature. Null when scoring is unavailable — the caller then falls back to
   *  treating everything as hot, which is exactly the pre-temperature behaviour (spec §11). */
  scores(): Promise<ScoreRow[] | null>;
}

/** Per-request ceiling. Same policy as the reader backends: one call, one budget, loud failure. */
/** Every mirror request's ceiling — one PostgREST or GitHub round trip. Exported so callers that
 *  schedule mirror work inside their own deadline (app/api/ops/sweep) reserve the real number. */
export const REQUEST_TIMEOUT_MS = 10_000;

/** The archive path refuses more than 64 MiB after decompression. The mirror's scalar JSON
 * response gets the same transport ceiling, so switching backends cannot raise the memory cap. */
const MAX_SNAPSHOT_TRANSPORT_BYTES = 64 * 1024 * 1024;

/** Above this many changed+removed paths, per-file patching costs more requests than one tarball
 *  — and a diff that big usually means history rewrote anyway. */
const PATCH_LIMIT = 25;

/** Test seam. `undefined` means "derive from env as normal"; anything else — including null —
 *  is served as-is. The same pattern as corpus.ts's __setCache. */
let overriddenStore: MirrorStore | null | undefined;

export function __setStore(s: MirrorStore | null | undefined): void {
  overriddenStore = s;
}

/**
 * The real store, from env. Null when unconfigured — and null is a mode, not an error: the
 * public product deploys with zero env and must behave exactly as it did before this file
 * existed.
 */
export function mirrorStore(): MirrorStore | null {
  if (overriddenStore !== undefined) return overriddenStore;
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return null;
  return pgrstStore(url.replace(/\/$/, ""), key);
}

function pgrstStore(base: string, key: string): MirrorStore {
  async function call(path: string, init: RequestInit = {}): Promise<Response> {
    const res = await fetch(`${base}/rest/v1/${path}`, {
      ...init,
      headers: {
        apikey: key,
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
        ...(init.headers ?? {}),
      },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!res.ok) {
      // Body dropped from the error on purpose: tools.ts hands e.message to the caller, and a
      // PostgREST error body is an uncontrolled upstream channel. Status is enough to act on.
      throw new Error(`mirror: ${init.method ?? "GET"} ${path.split("?")[0]} ${res.status}`);
    }
    return res;
  }

  async function boundedJson(res: Response, label: string): Promise<unknown> {
    const declared = res.headers.get("content-length");
    if (declared !== null) {
      const bytes = Number(declared);
      if (Number.isFinite(bytes) && bytes > MAX_SNAPSHOT_TRANSPORT_BYTES) {
        throw new Error(`mirror: ${label} response too large`);
      }
    }

    const chunks: Uint8Array[] = [];
    let bytes = 0;
    if (res.body) {
      const reader = res.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        bytes += value.byteLength;
        if (bytes > MAX_SNAPSHOT_TRANSPORT_BYTES) {
          await reader.cancel().catch(() => undefined);
          throw new Error(`mirror: ${label} response too large`);
        }
        chunks.push(value);
      }
    } else {
      const value = new Uint8Array(await res.arrayBuffer());
      bytes = value.byteLength;
      if (bytes > MAX_SNAPSHOT_TRANSPORT_BYTES) throw new Error(`mirror: ${label} response too large`);
      chunks.push(value);
    }

    try {
      return JSON.parse(Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)), bytes).toString("utf8"));
    } catch {
      throw new Error(`mirror: ${label} returned malformed JSON`);
    }
  }

  function snapshot(value: unknown): MirrorSnapshot {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error("mirror: snapshot envelope must be an object");
    }
    const envelope = value as Record<string, unknown>;
    if (!Object.hasOwn(envelope, "head") || !Array.isArray(envelope.rows)) {
      throw new Error("mirror: snapshot envelope is missing head or rows");
    }
    const head = envelope.head;
    if (head !== null && typeof head !== "string") throw new Error("mirror: snapshot head has the wrong type");
    if (typeof head === "string" && head !== "" && !/^[0-9a-f]{40}$/i.test(head)) {
      throw new Error("mirror: snapshot head is not a commit SHA");
    }
    if ((head === null || head === "") && envelope.rows.length !== 0) {
      throw new Error("mirror: snapshot has rows without an initialized head");
    }

    const rows: NoteRow[] = [];
    const paths = new Set<string>();
    for (const value of envelope.rows) {
      if (!value || typeof value !== "object" || Array.isArray(value)) {
        throw new Error("mirror: snapshot row must be an object");
      }
      const row = value as Record<string, unknown>;
      if (typeof row.path !== "string" || row.path.length === 0 ||
          typeof row.content !== "string" || typeof row.commit_sha !== "string") {
        throw new Error("mirror: snapshot row has the wrong type");
      }
      if (paths.has(row.path)) throw new Error(`mirror: snapshot contains duplicate path ${row.path}`);
      paths.add(row.path);
      rows.push({ path: row.path, content: row.content, commit_sha: row.commit_sha });
    }
    return { head, rows };
  }

  /** PostgREST may cap every response below the requested range. Advance from the last returned
   * path and stop only on an empty page; a short page is not evidence that the list is complete. */
  async function paged<T extends { path: string }>(query: string): Promise<T[]> {
    const out: T[] = [];
    const seen = new Set<string>();
    const PAGE = 1000;
    let cursor: string | null = null;
    for (;;) {
      const filter = cursor === null ? "" : `&path=gt.${encodeFilter(cursor)}`;
      const res = await call(`${query}${filter}`, {
        headers: { Range: `0-${PAGE - 1}`, "Range-Unit": "items" },
      });
      const value = await res.json() as unknown;
      if (!Array.isArray(value)) throw new Error("mirror: paged response was not an array");
      const rows = value as T[];
      if (rows.length === 0) return out;
      for (const row of rows) {
        if (!row || typeof row !== "object" || typeof row.path !== "string") {
          throw new Error("mirror: paged row has no path");
        }
        // Postgres collation order is not JavaScript UTF-16 order. The database owns ordering;
        // identity is the portable progress check and also catches duplicates across pages.
        if (seen.has(row.path)) throw new Error("mirror: pagination made no progress");
        seen.add(row.path);
        cursor = row.path;
      }
      out.push(...rows);
    }
  }

  function encodeFilter(value: string): string {
    return encodeURIComponent(value).replace(/[!'()*]/g, (char) =>
      `%${char.charCodeAt(0).toString(16).toUpperCase()}`
    );
  }

  return {
    async snapshot() {
      const res = await call("rpc/corpus_snapshot", { method: "POST", body: "{}" });
      return snapshot(await boundedJson(res, "snapshot"));
    },

    async head() {
      const res = await call("sync_state?select=head_sha&id=is.true");
      const rows = (await res.json()) as Array<{ head_sha: string }>;
      return rows[0]?.head_sha ?? null;
    },

    async paths() {
      return (await paged<{ path: string }>("notes?select=path&order=path.asc")).map((r) => r.path);
    },

    async apply(expectedHead, newHead, upserts, removes) {
      // One POST, one transaction, one winner. The whole corpus at today's size is ~500 KB of
      // JSON — nowhere near a request-body limit worth engineering around.
      const res = await call("rpc/sync_apply", {
        method: "POST",
        body: JSON.stringify({
          expected_head: expectedHead,
          new_head: newHead,
          upserts,
          removes,
        }),
      });
      return (await res.json()) === true;
    },

    async access(rows) {
      if (rows.length === 0) return;
      await call("note_access", {
        method: "POST",
        headers: { Prefer: "return=minimal" },
        body: JSON.stringify(rows),
      });
    },

    async scores() {
      try {
        return await paged<ScoreRow>("note_scores?select=path,temperature,score,reads&order=path.asc");
      } catch (e) {
        // Never fatal: a router that cannot score is a router that renders everything, which is
        // how it behaved before this phase and is strictly safer than hiding rows by accident.
        console.error(`[mirror] scores unavailable, treating every note as hot: ${String(e)}`);
        return null;
      }
    },
  };
}

/** Injected loaders, so the reconciler is testable without GitHub. Defaults are the real ones. */
export interface SyncDeps {
  /** The diff between two commits, already filtered to mirrored paths. The keep predicate is
   *  bound by corpus.ts, so the one definition of "the live corpus" keeps its one home — and so
   *  this module never imports corpus, which would be a cycle. */
  compare(base: string, head: string): Promise<CompareResult>;
  /** The commit's own timestamp, for write-recency scoring. Null when unknown — never guessed. */
  commitDate(sha: string): Promise<string | null>;
  /** One file's content at an exact ref, or null when it does not exist there. */
  fetchAt(path: string, ref: string): Promise<string | null>;
  /** Every kept file at `sha`, from the tarball — the full-sync and backfill loader. */
  fullLoad(sha: string): Promise<Map<string, string>>;
}

/**
 * Bring the mirror to `sha`. Patch when the head is strictly ahead and the diff is small and
 * trustworthy; full-sync when the mirror is empty (THE BACKFILL), the history rewrote
 * (behind/diverged), the diff is capped or oversized, or the compare refuses.
 *
 * Every mutation goes through ONE `apply`: the CAS refuses the whole batch if another instance
 * advanced the head first, and the transaction means a crash leaves either the old complete
 * state or the new complete state — never a head the rows do not reflect.
 */
export async function syncMirror(
  store: MirrorStore,
  mirrorHead: string | null,
  sha: string,
  deps: SyncDeps
): Promise<void> {
  if (mirrorHead === sha) return;

  if (mirrorHead) {
    try {
      const diff = await deps.compare(mirrorHead, sha);
      // `ahead` is load-bearing: "diverged" returns a merge-base diff that omits everything the
      // rewrite dropped, and "behind" (a plain reset-and-force-push) returns an EMPTY diff.
      // A patch built from either stamps the new head having changed nothing, and the phantom
      // rows persist forever, because a dropped path can never appear in a future diff. The
      // answer to rewritten history is a rebuild.
      if (diff.ahead && diff.complete && diff.changed.length + diff.removed.length <= PATCH_LIMIT) {
        const gone = [...diff.removed];
        const rows: NoteRow[] = [];
        // These files changed at or before `sha`, and the head commit's date is the tightest
        // bound available without a per-file history walk. A failed lookup is null, not now():
        // stamping a guessed date would make a stale note look freshly written.
        const at = await deps.commitDate(sha).catch(() => null);
        // CONCURRENT, not serial. These fetches have no dependency on each other, and this loop
        // sits on the boot path every client connect pays: at the PATCH_LIMIT of 25 files and a
        // ~150-200ms round trip to api.github.com that was 3.7-5.0s of pure serialised latency
        // added to a call already racing a 20s deadline. PATCH_LIMIT caps the fan-out, so the
        // whole set can go at once.
        const fetched = await Promise.all(
          diff.changed.map(async (p) => [p, await deps.fetchAt(p, sha)] as const)
        );
        for (const [p, content] of fetched) {
          // Changed-then-deleted between compare and fetch: absence at `sha` is a fact, treat it
          // as the removal it is rather than crashing the sync.
          if (content === null) gone.push(p);
          // storableText because Postgres cannot hold a NUL byte: ONE poisoned note would 400
          // the whole sync_apply batch — and since that note rides in every later diff, the
          // mirror freezes at the last clean commit until a human notices. Ingress now scrubs writes
          // (lib/brain.ts), but git HISTORY the guard predates must still be syncable. The
          // mirror row diverges from git by exactly the byte the store cannot represent.
          else rows.push({ path: p, content: storableText(content), commit_sha: sha, last_commit_at: at });
        }
        if (!(await store.apply(mirrorHead, sha, rows, gone))) {
          // Another instance moved the head first. Its state is the truth now; ours would have
          // been a rollback. Losing this race is a non-event, not an error.
          console.error(`[mirror] patch to ${sha.slice(0, 8)} lost the sync race — serving the winner's state`);
          return;
        }
        return;
      }
    } catch (e) {
      console.error(`[mirror] patch sync failed, falling back to full: ${String(e)}`);
    }
  }

  // Full sync — also the backfill, by design: reconcile-from-empty is the only import path, so
  // it cannot rot separately from the code that runs every day.
  const files = await deps.fullLoad(sha);
  const rows: NoteRow[] = [];
  // NO DATE ON A FULL SYNC. This used to stamp every row with the head commit's date, and the
  // store's coalesce let that non-null value overwrite every date the patch path had learned —
  // so a rebuild, a force-push or a >PATCH_LIMIT commit re-warmed the whole corpus. The version before that sent nothing
  // and the store coalesced NULL to mirrored_at, which reset age the same way through a
  // different column. Both guessed. Now the caller says exactly what it knows about each row:
  // nothing. sync_apply keeps the existing date for a row whose content did not change and sets
  // NULL for a row that did, and dateUndatedNotes — the clock's second job — learns the true
  // date from git within a tick.
  // Same storableText guard as the patch path, same reason: a full sync carries every note, so
  // one unstorable byte anywhere in the corpus would otherwise refuse the whole rebuild.
  for (const [path, content] of files) rows.push({ path, content: storableText(content), commit_sha: sha, last_commit_at: null });
  if (rows.length === 0) throw new Error("mirror: full sync produced no files — refusing to empty the mirror");
  const current = new Set(files.keys());
  // Every row the fresh tree does not carry is stale — including rows for paths the live policy
  // has since excluded. Git is the source of truth and a full sync re-imports anything the policy
  // readmits, so removing them loses nothing; keeping them would grow every corpus_snapshot()
  // payload against its 64 MiB ceiling for as long as the mirror lives, for rows nothing serves.
  // The one exception is the explicit legacy allowlist above.
  const stale = (await store.paths()).filter((p) => !current.has(p) && !LEGACY_NON_NOTE_SET.has(p));
  if (!(await store.apply(mirrorHead, sha, rows, stale))) {
    console.error(`[mirror] full sync to ${sha.slice(0, 8)} lost the sync race — serving the winner's state`);
    return;
  }
}

/**
 * THE DATER — the clock's second job (app/api/ops/sweep). A full sync inserts every new path with
 * last_commit_at NULL and sync_apply nulls the date of any row a full sync changed, because the
 * tarball carries no history. note_scores reads NULL as mirrored_at, which is honest for minutes
 * and a lie for months, so the cron asks git for the newest commit touching each undated path
 * and writes it in — a bounded number per tick so no tick races the function wall.
 *
 * One call per path is the only per-file history GitHub offers over REST. That is why this runs
 * on the clock and not on the boot path.
 */
export interface NoteDater {
  /** Paths with no known commit date, oldest-mirrored first, at most `limit`. */
  undated(limit: number): Promise<string[]>;
  /** Record the date. Filtered on NULL server-side, so a row another writer dated first is
   *  left alone rather than overwritten by this slower, coarser source. */
  setCommitDate(path: string, at: string): Promise<void>;
}

/** The real dater, from env; null when the mirror is unconfigured (the public product's mode). */
export function noteDater(): NoteDater | null {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return null;
  const base = url.replace(/\/$/, "");
  const headers = { apikey: key, Authorization: `Bearer ${key}`, "Content-Type": "application/json" };
  return {
    async undated(limit) {
      const res = await fetch(
        `${base}/rest/v1/notes?select=path&last_commit_at=is.null&order=mirrored_at.asc,path.asc&limit=${limit}`,
        { headers, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) }
      );
      if (!res.ok) throw new Error(`mirror: GET notes(undated) ${res.status}`);
      return ((await res.json()) as Array<{ path: string }>).map((r) => r.path);
    },
    async setCommitDate(path, at) {
      const res = await fetch(`${base}/rest/v1/notes?path=eq.${encodeURIComponent(path)}&last_commit_at=is.null`, {
        method: "PATCH",
        headers: { ...headers, Prefer: "return=minimal" },
        body: JSON.stringify({ last_commit_at: at }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (!res.ok) throw new Error(`mirror: PATCH notes ${res.status}`);
    },
  };
}

/** The newest commit touching one path on the brain branch, from the commits API. Null when git
 *  has no history for it — a path the mirror should not have, reported and never guessed. */
export async function lastCommitDateOf(path: string): Promise<string | null> {
  const res = await gh(`/repos/${repo()}/commits?path=${encodeURIComponent(path)}&sha=${branch()}&per_page=1`);
  if (!res.ok) throw new Error(`mirror: commits?path ${res.status}`);
  const data = (await res.json()) as Array<{ commit?: { author?: { date?: string }; committer?: { date?: string } } }>;
  return data[0]?.commit?.author?.date ?? data[0]?.commit?.committer?.date ?? null;
}

export interface DatingResult {
  /** How many undated rows the tick found, before any were dated. */
  undated: number;
  dated: number;
  /** Paths git has no history for. Left NULL and reported; the next full sync removes a path
   *  that is gone from the tree, which is the honest fix and not this job's. */
  unknown: string[];
  failed: string[];
}

/**
 * Date up to `limit` undated rows. Each path is its own try: one GitHub hiccup costs one path one
 * tick, never the batch, and `deadline` lets the caller stop well inside its own wall — a tick
 * that cannot finish its batch leaves the rest for the next one rather than being killed mid-write.
 */
export async function dateUndatedNotes(
  dater: NoteDater,
  lookup: (path: string) => Promise<string | null>,
  limit = 20,
  deadline: () => boolean = () => false
): Promise<DatingResult> {
  const paths = await dater.undated(limit);
  const out: DatingResult = { undated: paths.length, dated: 0, unknown: [], failed: [] };
  for (const path of paths) {
    if (deadline()) break;
    try {
      const at = await lookup(path);
      if (!at) {
        out.unknown.push(path);
        continue;
      }
      await dater.setCommitDate(path, at);
      out.dated++;
    } catch (e) {
      console.error(`[mirror] dating ${path} failed: ${String(e)}`);
      out.failed.push(path);
    }
  }
  return out;
}

/** A commit's author date, for write-recency scoring. Null on any failure — the scorer coalesces
 *  to the mirror timestamp rather than trusting a guess. */
export async function commitDateOf(sha: string): Promise<string | null> {
  const res = await gh(`/repos/${repo()}/commits/${sha}`);
  if (!res.ok) return null;
  const data = (await res.json()) as { commit?: { author?: { date?: string }; committer?: { date?: string } } };
  return data.commit?.author?.date ?? data.commit?.committer?.date ?? null;
}

/** The real fetchAt: Contents API pinned to the ref, so a head that moves mid-sync cannot hand
 *  us content newer than the commit we are about to record. Provenance is the whole point. */
export async function fetchFileAt(path: string, ref: string): Promise<string | null> {
  const res = await gh(`/repos/${repo()}/contents/${path}?ref=${ref}`);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`mirror: contents ${path}@${ref.slice(0, 8)} ${res.status}`);
  const data = (await res.json()) as { content?: string; encoding?: string };
  if (data.encoding !== "base64" || typeof data.content !== "string") {
    throw new Error(`mirror: contents ${path}@${ref.slice(0, 8)} unsupported encoding`);
  }
  return Buffer.from(data.content, "base64").toString("utf8");
}
