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
import { gh, repo } from "./github";
import type { CompareResult } from "./github";

export interface NoteRow {
  path: string;
  content: string;
  commit_sha: string;
  /** When git last changed this file. Known on the patch path (the head commit's date IS when
   *  those files changed); null on a full sync, which carries no per-file dates — sync_apply
   *  coalesces so a rebuild never erases dates the patch path already learned. */
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

export interface MirrorStore {
  /** The head the mirror believes it reflects, or null for a store never synced. */
  head(): Promise<string | null>;
  all(): Promise<NoteRow[]>;
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
const REQUEST_TIMEOUT_MS = 10_000;

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

  return {
    async head() {
      const res = await call("sync_state?select=head_sha&id=is.true");
      const rows = (await res.json()) as Array<{ head_sha: string }>;
      return rows[0]?.head_sha ?? null;
    },

    async all() {
      // Paged, because PostgREST caps a response at its own max-rows regardless of what we ask.
      // Trusting a single response would silently serve a partial brain the day the corpus
      // outgrows the cap — the exact silent-loss failure this system forbids.
      const out: NoteRow[] = [];
      const PAGE = 1000;
      for (let from = 0; ; from += PAGE) {
        const res = await call("notes?select=path,content,commit_sha&order=path.asc", {
          headers: { Range: `${from}-${from + PAGE - 1}`, "Range-Unit": "items" },
        });
        const rows = (await res.json()) as NoteRow[];
        out.push(...rows);
        if (rows.length < PAGE) return out;
      }
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
        const res = await call("note_scores?select=path,temperature,score,reads");
        return (await res.json()) as ScoreRow[];
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
        for (const p of diff.changed) {
          const content = await deps.fetchAt(p, sha);
          // Changed-then-deleted between compare and fetch: absence at `sha` is a fact, treat it
          // as the removal it is rather than crashing the sync.
          if (content === null) gone.push(p);
          else rows.push({ path: p, content, commit_sha: sha, last_commit_at: at });
        }
        if (!(await store.apply(mirrorHead, sha, rows, gone))) {
          // Another instance moved the head first. Its state is the truth now; ours would have
          // been a rollback. Losing this race is a non-event, not an error.
          console.error(`[mirror] patch to ${sha.slice(0, 8)} lost the sync race — serving the winner's state`);
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
  for (const [path, content] of files) rows.push({ path, content, commit_sha: sha });
  if (rows.length === 0) throw new Error("mirror: full sync produced no files — refusing to empty the mirror");
  const current = new Set(files.keys());
  const stale = (await store.all()).map((r) => r.path).filter((p) => !current.has(p));
  if (!(await store.apply(mirrorHead, sha, rows, stale))) {
    console.error(`[mirror] full sync to ${sha.slice(0, 8)} lost the sync race — serving the winner's state`);
  }
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
