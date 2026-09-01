import { redact } from "./redact";

const API = "https://api.github.com";

export function repo(): string {
  const r = process.env.BRAIN_REPO;
  if (!r) throw new Error("BRAIN_REPO env var not set");
  return r;
}

export function branch(): string {
  return process.env.BRAIN_BRANCH ?? "main";
}

/**
 * Per-request ceiling on every GitHub call.
 *
 * There was none, and the boot path's first act is a GitHub round trip that sits ABOVE
 * corpus.ts's mirror deadline — so a stalled socket during a GitHub incident hung brain_context
 * for the full 60s function wall while a complete, already-verified corpus sat in the cache one
 * `catch` away. loadCorpus() only falls back on a thrown error, never on a hang; this is what
 * turns the hang into an error. Generous enough for a tarball redirect, far inside the wall.
 */
const REQUEST_TIMEOUT_MS = 15_000;

export async function gh(path: string, init: RequestInit = {}): Promise<Response> {
  const token = process.env.GITHUB_TOKEN;
  if (!token) throw new Error("GITHUB_TOKEN env var not set");
  return fetch(`${API}${path}`, {
    // Callers can still pass their own signal — spread last so an explicit one wins.
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      ...(init.headers ?? {}),
    },
  });
}

export interface BrainFile {
  path: string;
  content: string;
  sha: string;
}

/**
 * Turn a failed GitHub response into an error safe to hand back to a caller.
 *
 * The previous form spliced `await res.text()` straight into the message, and tools.ts
 * returns `e.message` verbatim to the client — an uncontrolled channel from an upstream
 * service into someone else's context. GitHub does not echo the Authorization header today,
 * but "today" is the only thing holding that. Keep the status and GitHub's own one-line
 * `message`, drop everything else, and put the full body in the server log where it is
 * actually useful for debugging.
 */
async function ghError(label: string, res: Response): Promise<Error> {
  let body = "";
  try {
    body = await res.text();
  } catch {
    /* a body we cannot read is not worth failing differently over */
  }
  let detail = "";
  try {
    const parsed = JSON.parse(body) as { message?: unknown };
    if (typeof parsed.message === "string") detail = parsed.message.slice(0, 200);
  } catch {
    /* non-JSON body: report the status alone rather than guessing */
  }
  if (body) console.error(`[github] ${label} ${res.status}: ${body.slice(0, 2000)}`);
  return new Error(`GitHub ${label}: ${res.status}${detail ? ` ${redact(detail)}` : ""}`);
}

export async function getFile(path: string): Promise<BrainFile | null> {
  const res = await gh(`/repos/${repo()}/contents/${path}?ref=${branch()}`);
  if (res.status === 404) return null;
  if (!res.ok) throw await ghError(`getFile ${path}`, res);
  const data = (await res.json()) as { content: string; sha: string; encoding: string };
  if (data.encoding !== "base64") {
    throw new Error(
      `GitHub getFile ${path}: unsupported encoding "${data.encoding}" (file too large to read via Contents API)`
    );
  }
  return {
    path,
    content: Buffer.from(data.content, "base64").toString("utf8"),
    sha: data.sha,
  };
}

async function putOnce(
  path: string,
  content: string,
  message: string,
  sha?: string
): Promise<Response> {
  return gh(`/repos/${repo()}/contents/${path}`, {
    method: "PUT",
    body: JSON.stringify({
      message,
      content: Buffer.from(content, "utf8").toString("base64"),
      branch: branch(),
      ...(sha ? { sha } : {}),
    }),
  });
}

export async function putFile(
  path: string,
  content: string,
  message: string,
  sha?: string,
  // May be async: the index's merge has to re-read the whole corpus to re-derive
  // its content, which a synchronous callback cannot do.
  merge?: (fresh: BrainFile | null) => string | Promise<string>
): Promise<{ commitSha: string; content: string }> {
  let res = await putOnce(path, content, message, sha);
  // What licenses a retry is the MERGE CALLBACK, not the sha.
  //
  // The old guard was `sha !== undefined`, on the reasoning that a sha-less 422
  // means the file already exists and `create` must never overwrite it. That is
  // right for a user-facing create, and wrong for a DERIVED file. The rich index
  // is written with no sha the first time it exists; if two first-time writes
  // race, the loser takes a sha-less 422, skips the re-derive, and the note it
  // was adding is simply absent from the catalogue — a successful write that is
  // permanently unrecallable, which is the exact failure this repo keeps hitting.
  //
  // A caller that passes `merge` is telling us its content is derived and can be
  // rebuilt from whatever is now on the branch. A caller that passes none keeps
  // the old create-safety: no merge, no overwrite.
  const canRebuild = merge !== undefined;
  // Track what actually reached the commit. On the retry path that is merge(fresh), not the
  // caller's argument — and the mirror write-through needs the committed bytes, because a row
  // holding the caller's stale content under the retry's commit SHA would be a mirror lying
  // about provenance, silently, on exactly the writes that raced.
  let committed = content;
  if ((res.status === 409 || res.status === 422) && (sha !== undefined || canRebuild)) {
    const fresh = await getFile(path);
    committed = merge ? await merge(fresh) : content;
    res = await putOnce(path, committed, message, fresh?.sha);
  }
  if (!res.ok) throw await ghError(`putFile ${path}`, res);
  const data = (await res.json()) as { commit: { sha: string } };
  return { commitSha: data.commit.sha, content: committed };
}

export async function listTree(): Promise<string[]> {
  const res = await gh(`/repos/${repo()}/git/trees/${branch()}?recursive=1`);
  if (!res.ok) throw await ghError("listTree", res);
  const data = (await res.json()) as {
    tree: Array<{ path: string; type: string }>;
    truncated?: boolean;
  };
  // A truncated tree comes back 200 with a PARTIAL file list, which is
  // indistinguishable from a smaller repo — and the index rebuilds off this.
  // Silently indexing half the brain is worse than failing the call.
  if (data.truncated) {
    throw new Error(
      "GitHub listTree: response truncated — refusing to report a partial tree"
    );
  }
  return data.tree
    .filter((t) => t.type === "blob" && t.path.endsWith(".md"))
    .map((t) => t.path);
}

export interface CommitInfo {
  sha: string;
  message: string;
  date: string;
}

/** Recent commits on the brain — the ingest feed. Every write is a commit, so this IS the
 *  write history, with no telemetry layer needed to show it. */
export async function listCommits(limit = 20): Promise<CommitInfo[]> {
  const res = await gh(`/repos/${repo()}/commits?sha=${branch()}&per_page=${limit}`);
  if (!res.ok) throw await ghError("listCommits", res);
  const data = (await res.json()) as Array<{
    sha: string;
    commit: { message: string; author?: { date?: string }; committer?: { date?: string } };
  }>;
  return data.map((c) => ({
    sha: c.sha.slice(0, 8),
    message: redact(c.commit.message.split("\n")[0]).slice(0, 90),
    date: c.commit.author?.date ?? c.commit.committer?.date ?? "",
  }));
}

export interface CompareResult {
  /** Paths whose content at `head` differs from `base` — added, modified, or the new name of a
   *  rename. Fetch these and upsert. */
  changed: string[];
  /** Paths that no longer exist at `head`, including a rename's old name. Delete these. */
  removed: string[];
  /** False when the diff was too large for the compare API's file list, which silently caps at
   *  300 entries. A reconciler that trusted a capped list would absorb part of a diff and record
   *  the head as fully synced — the caller must full-sync instead. */
  complete: boolean;
  /**
   * True only when `head` is a DESCENDANT of `base` (compare status "ahead") — the one shape a
   * patch may be built from. Verified against the live API: "diverged" returns 200 with a
   * MERGE-BASE diff that omits everything the rewritten commit dropped, and "behind" — a plain
   * reset-and-force-push — returns 200 with an EMPTY file list. A patch built from either
   * records the new head having changed nothing, and the phantom rows persist forever, because a
   * dropped path can never appear in any future diff. The 404 defence is nearly theoretical:
   * orphaned commits stay SHA-resolvable on GitHub more or less indefinitely.
   */
  ahead: boolean;
}

/**
 * What changed between two commits, as the mirror needs it: fetch-these, delete-these, and an
 * honest flag for "this list cannot be trusted to be everything".
 *
 * `keep` filters both lists. It is a parameter rather than an import from corpus.ts for two
 * reasons: corpus.ts already imports this module, and — more importantly — the definition of
 * "the live corpus" must have exactly one home. A second copy here is the dual-implementation
 * drift this repo exists to delete.
 *
 * A 404 from the compare API usually means divergent histories — a force-push over the brain —
 * and the caller's answer is a full sync, never a patch.
 */
export async function compareCommits(
  base: string,
  head: string,
  keep: (path: string) => boolean = () => true
): Promise<CompareResult> {
  const res = await gh(`/repos/${repo()}/compare/${base}...${head}`);
  if (!res.ok) throw await ghError("compare", res);
  const data = (await res.json()) as {
    status?: string;
    files?: Array<{ filename: string; status: string; previous_filename?: string }>;
  };
  const files = data.files ?? [];
  const ahead = data.status === "ahead";

  const changed: string[] = [];
  const removed: string[] = [];
  for (const f of files) {
    if (f.status === "removed") {
      if (keep(f.filename)) removed.push(f.filename);
      continue;
    }
    if (keep(f.filename)) changed.push(f.filename);
    // A rename is a delete wearing a new name. The compare API reports it as one entry; the
    // mirror must see both halves or the old row survives as a ghost note.
    if (f.status === "renamed" && f.previous_filename && keep(f.previous_filename)) {
      removed.push(f.previous_filename);
    }
  }
  // The API caps `files` at 300 with no explicit truncation flag; at the cap, assume the worst.
  return { changed, removed, complete: files.length < 300, ahead };
}
