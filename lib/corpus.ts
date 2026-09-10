/**
 * corpus — the whole live brain, fetched in one shot.
 *
 * The old read path ranked a generated one-line summary of each note and opened the single
 * best file. Summaries can omit the very terms needed to retrieve a note, so cortex now ships
 * the selected text and lets the reader read.
 *
 * WHY A TARBALL. It needs a bounded number of requests without one blob request per file.
 *
 * `GET /repos/{o}/{r}/tarball/{ref}` 302s to codeload with a PRE-SIGNED url, so the second
 * hop needs no credentials — which matters because fetch() strips Authorization on a
 * cross-origin redirect. Default redirect handling therefore Just Works.
 *
 * Tar is parsed here rather than with a dependency: 512-byte header, octal size at offset
 * 124, payload padded to 512. That is ~25 lines and keeps the function bundle unchanged.
 */
import zlib from "node:zlib";
import { promisify } from "node:util";
import { gh, repo, branch, compareCommits } from "./github";
import { mirrorStore, syncMirror, fetchFileAt, commitDateOf, type MirrorStore } from "./mirror";
import { scheduleEdgeRebuild } from "./edges";
import { deadlineIn, DeadlineExceeded, mirrorBudgetMs, raceDeadline, type Deadline } from "./deadline";

const gunzip = promisify(zlib.gunzip);

/** Excluded from the reader tier. archive/ holds superseded material;
 *  a reader given both answers from the dead one. tools/ is code, not memory. */
// Must stay identical to brain/tools/brain_ask.py SKIP_PREFIX and SKIP_NAMES. Two definitions
// of "the live corpus" that disagree is the dual-implementation drift this rebuild exists to
// delete; when they diverge, an answer can silently miss a note. Exported for parity checks: the live
// differential in tests/no-brain-leakage.test.ts reads the real python source from the brain
// checkout and runs in the brain-gate; tests/corpus.test.ts pins the shape brain-free.
// ".claude/" is the nested-worktree guard: Claude Code's EnterWorktree checks out at
// .claude/worktrees/<name>/ INSIDE the repo, a full second copy of every file. That can duplicate
// the reader corpus and re-admit retired archive content as current. Cortex reads the committed
// tree where .gitignore already blocks these, so this
// entry is parity with brain_ask.py's filesystem walk, not a live hole here.
export const SKIP_PREFIX = [".git/", ".claude/", "tools/", "archive/", "brain-v2/", ".github/"];
export const SKIP_NAME = ["brain-index.md", "INDEX.md", "README.md"];

export interface Corpus {
  files: Map<string, string>;
  sha: string;
  bytes: number;
  fetchedAt: number;
}

/** Per-warm-instance cache keyed on the commit SHA. A SHA is a content address, so this
 *  cannot serve stale text: a different SHA is simply a different key, never a silent hit. */
let cached: Corpus | null = null;

export function isLive(path: string): boolean {
  // Extension compared case-insensitively: a note saved as `Setup.MD` is a note. The old
  // exact-match test dropped it silently, which is the one bypass on this list reachable by
  // hand. brain_ask.py's live_files() matches this.
  if (!/\.md$/i.test(path)) return false;
  if (SKIP_PREFIX.some((p) => path.startsWith(p))) return false;
  return !SKIP_NAME.includes(path.split("/").pop() ?? "");
}

/** All 512 bytes zero — tar marks end-of-archive with two of these. */
function isZeroBlock(buf: Buffer, off: number): boolean {
  for (let i = off; i < off + 512; i++) if (buf[i] !== 0) return false;
  return true;
}

/**
 * ustar header checksum: every header byte summed with the checksum field read as spaces.
 *
 * This is the structural defence against desync. Without it, any input that makes the reader
 * mis-measure one entry causes it to parse that entry's PAYLOAD as headers — so note text, or
 * anything appended after the archive, silently becomes corpus entries. A header that does not
 * checksum is not a header, and we stop rather than guess.
 */
function checksumOk(buf: Buffer, off: number): boolean {
  const field = buf.toString("ascii", off + 148, off + 156).replace(/\0[\s\S]*$/, "").trim();
  const stored = parseInt(field, 8);
  if (!Number.isFinite(stored)) return false;
  let unsigned = 0;
  let signed = 0;
  for (let i = 0; i < 512; i++) {
    const b = i >= 148 && i < 156 ? 0x20 : buf[off + i];
    unsigned += b;
    signed += b > 127 ? b - 256 : b;
  }
  return stored === unsigned || stored === signed;
}

/** Size field: octal, or base-256 when the high bit of the first byte is set (files ≥ 8 GB). */
function readSize(buf: Buffer, off: number): number {
  if (buf[off + 124] & 0x80) {
    let n = 0;
    for (let i = off + 125; i < off + 136; i++) n = n * 256 + buf[i];
    return n;
  }
  const field = buf.toString("ascii", off + 124, off + 136).replace(/\0[\s\S]*$/, "").trim();
  if (!field) return 0;
  if (!/^[0-7]+$/.test(field)) throw new Error(`corrupt tar: size field is not octal (${JSON.stringify(field)})`);
  return parseInt(field, 8);
}

/**
 * Minimal tar reader. Returns entries as [path, contents].
 *
 * `keep` decides which paths are materialised. Passing it matters: without a filter every
 * entry — including binaries under tools/ that are discarded a line later — is UTF-8 decoded
 * into a JS string first.
 *
 * Everything here fails LOUD. Both real bugs this reader has had were silent drops: notes
 * vanished from the corpus and the brain answered "not in brain" for things the operator had written
 * down. For a memory system that is the worst possible failure, so a note this reader cannot
 * represent is an exception, never a `continue`.
 */
export function untar(buf: Buffer, keep: (path: string) => boolean = () => true): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  let off = 0;
  let zeros = 0;
  // Set by a preceding pax 'x' or GNU 'L' header, consumed by the entry that follows.
  let pendingName: string | null = null;

  while (off + 512 <= buf.length) {
    if (isZeroBlock(buf, off)) {
      // Two consecutive zero blocks end the archive. Reading past them ingests whatever was
      // appended afterwards as if it were repo content.
      if (++zeros === 2) break;
      off += 512;
      continue;
    }
    zeros = 0;
    if (!checksumOk(buf, off)) throw new Error(`corrupt tar: bad header checksum at byte ${off}`);

    const rawName = buf.toString("utf8", off, off + 100).replace(/\0[\s\S]*$/, "");
    // ustar splits any path over 100 chars across a `prefix` field at offset 345. Reading only
    // `name` silently dropped 49 of this repo's entries — the reader saw a bare basename, found
    // no "/" to strip the wrapper dir from, and discarded the file. Seven live notes vanished.
    const prefix = buf.toString("utf8", off + 345, off + 500).replace(/\0[\s\S]*$/, "");
    const size = readSize(buf, off);
    const type = String.fromCharCode(buf[off + 156]);
    off += 512;

    if (!Number.isFinite(size) || size < 0) {
      // A negative octal size sends `off` backwards onto the same header forever — a
      // synchronous hang that pins the function until the platform kills it.
      throw new Error(`corrupt tar: entry "${rawName}" declares size ${size}`);
    }
    if (off + size > buf.length) {
      // toString() clamps out-of-range ends and returns a SHORT string, so a truncated
      // archive would serve a truncated note as though it were complete.
      throw new Error(`corrupt tar: entry "${rawName}" declares ${size} bytes, ${buf.length - off} remain`);
    }

    const payloadEnd = off + size;
    const advance = () => (off = payloadEnd + ((512 - (size % 512)) % 512));

    // pax extended header ('x'/'g'), and GNU long name ('L'). git emits pax whenever a path
    // will not split into name(100)+prefix(155) at a "/" — notably ANY basename over 100
    // bytes. The data entry that follows is then named "<oid>.data", which has no "/", so the
    // wrapper-strip produced "" and the note was thrown away. Same silent-drop class as the
    // prefix bug, still latent here only because the longest basename in the brain is 47.
    if (type === "x" || type === "g" || type === "L") {
      const payload = buf.toString("utf8", off, payloadEnd);
      if (type === "L") {
        pendingName = payload.replace(/\0[\s\S]*$/, "");
      } else if (type === "x") {
        // Records are "<len> <key>=<value>\n". Only 'x' (per-file) may rename the next entry.
        // 'g' is GLOBAL — git writes one `pax_global_header` carrying a comment — so honouring
        // a path record there would rename every remaining entry in the archive.
        const m = payload.match(/\d+ path=([^\n]*)\n/);
        if (m) pendingName = m[1];
      }
      advance();
      continue;
    }

    const full = pendingName ?? (prefix ? `${prefix}/${rawName}` : rawName);
    pendingName = null;
    // GitHub wraps everything in a top-level <repo>-<sha>/ directory; strip it.
    const rel = full.split("/").slice(1).join("/");

    if (type === "0" || type === "\0" || type === " ") {
      if (!rel) {
        throw new Error(`corrupt tar: entry "${full}" has no path below the archive root`);
      }
      if (keep(rel)) out.push([rel, buf.toString("utf8", off, payloadEnd)]);
    } else if ((type === "1" || type === "2") && keep(rel)) {
      // A symlinked or hardlinked NOTE carries no payload here, and dropping it would make a
      // real note invisible with no signal — exactly the failure this reader keeps having.
      throw new Error(`corpus contains a link, not a file: "${rel}". Replace it with a regular file.`);
    }
    advance();
  }
  return out;
}

/** Resolve the branch head. One cheap call, and it is what the cache is keyed on. */
async function headSha(deadline?: Deadline): Promise<string> {
  const res = await gh(`/repos/${repo()}/commits/${branch()}`, { deadline });
  if (!res.ok) throw new Error(`cannot resolve ${branch()}: HTTP ${res.status}`);
  return ((await res.json()) as { sha: string }).sha;
}

/** In-flight builds, keyed by sha. Two cold requests used to fetch, gunzip and build the
 *  whole corpus twice over — two copies live at peak — and hand their callers different
 *  objects for the same commit. Sharing the promise makes the second a free await. */
const inFlight = new Map<string, Promise<Corpus>>();

/** 64 MB of decompressed tar. The brain is 325 KB; this is a zip-bomb ceiling, not a budget. */
const MAX_TAR_BYTES = 64 * 1024 * 1024;

/**
 * Every kept file at `sha`, from one tarball. Exported for the mirror's full-sync/backfill,
 * which must load exactly the file set the corpus is built from — one loader, one definition of
 * what rides the mirror, no second implementation to drift.
 */
export async function loadFilesAt(sha: string, deadline?: Deadline): Promise<Map<string, string>> {
  const res = await gh(`/repos/${repo()}/tarball/${sha}`, { deadline });
  if (!res.ok) throw new Error(`tarball fetch failed: HTTP ${res.status}`);
  const gz = Buffer.from(await res.arrayBuffer());
  const tar = await gunzip(gz, { maxOutputLength: MAX_TAR_BYTES });
  // Retired visualization assets and every other non-note entry are never decoded or retained.
  return new Map(untar(tar, isLive));
}

/** Assemble a Corpus from a flat file set, whichever loader produced it. */
function assemble(all: Map<string, string>, sha: string): Corpus {
  const files = new Map<string, string>();
  let bytes = 0;
  for (const [path, text] of all) {
    // A mirror can still hold pre-retirement non-note rows. Ignore them without mutating the
    // customer's store; only live notes enter the corpus or its byte count.
    if (!isLive(path)) continue;
    files.set(path, text);
    bytes += Buffer.byteLength(text, "utf8");
  }
  if (files.size === 0) throw new Error("corpus contained no live notes — refusing to serve");
  return { files, sha, bytes, fetchedAt: Date.now() };
}

async function build(sha: string, deadline?: Deadline): Promise<Corpus> {
  return assemble(await loadFilesAt(sha, deadline), sha);
}

/**
 * The corpus served from the Postgres mirror, healed first when it is behind.
 *
 * The mirror never gets to be wrong quietly: sync runs before serving, rows are partitioned by
 * the same isLive predicate the tarball path uses, and an empty result throws — which the caller
 * treats as "use the tarball", never as "the brain is empty". The keep predicate is bound HERE,
 * so the one definition of "the live corpus" stays in this file.
 */
async function buildFromMirror(store: MirrorStore, sha: string, deadline: Deadline): Promise<Corpus> {
  const initial = await store.snapshot();
  const before = initial.head;
  if (before === sha) {
    return assemble(new Map(initial.rows.map((row) => [row.path, row.content])), sha);
  }

  await syncMirror(store, before, sha, {
    compare: (base, head) => compareCommits(base, head, isLive),
    fetchAt: fetchFileAt,
    commitDate: commitDateOf,
    fullLoad: (at) => loadFilesAt(at, deadline),
  });
  const after = await store.snapshot();
  if (!after.head) throw new Error("mirror: snapshot remained uninitialized after reconciliation");
  const head = after.head;
  const corpus = assemble(new Map(after.rows.map((row) => [row.path, row.content])), head);
  return corpus;
}

/** What a caller may hand loadCorpus besides `force`. */
export interface LoadCorpusOptions {
  /**
   * The request's deadline, when the load rides inside a tool call. Every stage below — the
   * head lookup, the mirror race, the tarball — spends from it instead of from its own fixed
   * ceiling, so the stages compose under the function wall. Absent (scripts, tests, the console's
   * own renders) a fresh request-sized deadline stands in, which is the old behaviour exactly.
   */
  deadline?: Deadline;
}

/**
 * The live corpus at the current branch head.
 *
 * Never returns partially-read state: a failed fetch throws and the caller reports it,
 * rather than answering from half a brain — the failure mode the old index path had.
 */
export async function loadCorpus(force = false, opts: LoadCorpusOptions = {}): Promise<Corpus> {
  const deadline = opts.deadline ?? deadlineIn();
  let sha: string;
  try {
    sha = await headSha(deadline);
  } catch (e) {
    // GitHub 5xx and secondary rate limits are routine. Throwing here meant a complete,
    // already-verified corpus sat in memory while the brain reported failure. Serving it is
    // not "half a brain" — it is whole, just possibly one commit behind, and every answer
    // already carries the commit it was proven against, so the staleness stays visible.
    if (!force && cached) {
      console.error(`[corpus] head resolution failed, serving cache @${cached.sha}: ${String(e)}`);
      scheduleEdgeRebuild(cached.files, cached.sha);
      return cached;
    }
    throw e;
  }
  if (!force && cached?.sha === sha) {
    scheduleEdgeRebuild(cached.files, cached.sha);
    return cached;
  }

  // A second caller joins the first build and inherits ITS deadline. Two concurrent tool calls
  // start within milliseconds of each other, so the difference is noise; the alternative — a
  // second full fetch per caller — is the duplication this map exists to prevent.
  const existing = inFlight.get(sha);
  if (existing) return existing;

  const p = buildVia(sha, deadline)
    .then((c) => {
      cached = c;
      scheduleEdgeRebuild(c.files, c.sha);
      return c;
    })
    .finally(() => inFlight.delete(sha));
  inFlight.set(sha, p);
  return p;
}

/**
 * Total time the mirror path may spend before the tarball takes over. Per-request timeouts are
 * not enough: a sync in the patch branch makes up to 2 store calls plus a compare plus 25 pinned
 * Contents fetches, and a mirror that is slow-but-alive could stack those toward the function's
 * own kill without this ceiling — making a degraded mirror WORSE than a dead one, since a dead
 * one throws immediately and the tarball serves. The race's loser keeps running in the
 * background; if it eventually completes its apply, the CAS decides as usual.
 */
export const MIRROR_DEADLINE_MS = 20_000;

/**
 * What the mirror race leaves for the tarball that serves when it loses: one GitHub round trip,
 * github.ts's REQUEST_TIMEOUT_MS. A literal rather than the import because half the test suite
 * mocks ./github wholesale; tests/deadline.test.ts pins the two equal. Without the reserve a
 * mirror that spent the whole remaining budget would hand the fallback nothing, and "mirror slow"
 * would become "no corpus at all".
 */
export const TARBALL_RESERVE_MS = 15_000;

/**
 * Mirror when configured and healthy, tarball otherwise — and "otherwise" is the ordinary path,
 * not an emergency: with no SUPABASE_URL this function IS yesterday's build(), byte for byte of
 * behaviour. A mirror failure is logged and absorbed, because a memory server that goes dark
 * when its cache layer hiccups has its priorities backwards.
 *
 * The race's ceiling is the mirror's own cap or what the request has left after the tarball's
 * reserve, whichever is smaller; a request too far gone to give the mirror a real turn skips it
 * and lets the tarball spend what remains. Either way the fallback stays inside the budget.
 */
async function buildVia(sha: string, deadline: Deadline): Promise<Corpus> {
  const store = mirrorStore();
  if (store) {
    const budget = mirrorBudgetMs(MIRROR_DEADLINE_MS, deadline.remaining(), TARBALL_RESERVE_MS);
    if (budget === 0) {
      console.error(`[mirror] skipped: ${deadline.remaining()}ms left in the request — serving tarball`);
    } else {
      try {
        return await raceDeadline(
          buildFromMirror(store, sha, deadline),
          budget,
          () => new DeadlineExceeded("mirror", budget, true, `mirror: exceeded ${budget}ms total budget`)
        );
      } catch (e) {
        console.error(`[mirror] serving tarball instead: ${String(e)}`);
      }
    }
  }
  return build(sha, deadline);
}

/** Test seam and a way to force a cold path in production if the cache is ever suspect. */
export function __setCache(c: Corpus | null): void {
  cached = c;
}

/* ── What the reader never sees ─────────────────────────────────────────────────────────── */

/** One file outside the reader tier: its path and its size, and nothing else. */
export interface SkippedFile {
  path: string;
  bytes: number;
}

export interface Skipped {
  sha: string;
  files: SkippedFile[];
}

/** The one skipped prefix that holds notes rather than code: archive/ (tools/ is code, the
 *  dot-directories are plumbing). This is the set listSkipped() describes. */
export const SKIPPED_NOTES_PREFIX = "archive/";

export function isSkippedNote(path: string): boolean {
  return /\.md$/i.test(path) && path.startsWith(SKIPPED_NOTES_PREFIX);
}

let skippedCache: Skipped | null = null;

/** Test seam, same contract as __setCache. */
export function __setSkipped(s: Skipped | null): void {
  skippedCache = s;
}

/**
 * archive/ as a listing — paths and sizes — for the console's explorer (approved console design):
 * "the brain does not know" and "the brain filed it away" are different answers, and the
 * operator should be able to see which one they got.
 *
 * READ-ONLY AND DISPLAY-ONLY, BY CONSTRUCTION. This never returns text, so nothing that
 * consumes it can hand a skipped note to narrow(), buildPrompt() or the reader: the type has no
 * body to pack. It is a second, separate loader beside loadCorpus() rather than a flag on it,
 * because "the live corpus" must keep exactly one definition (isLive) and this is not part of it.
 * The mirror never holds archive/ either, so the tarball is the only source; a listing that
 * cannot be made returns null and the explorer says so, rather than an empty archive/ that would
 * read as "nothing was ever filed away".
 */
export async function listSkipped(): Promise<Skipped | null> {
  let sha: string;
  try {
    sha = await headSha();
  } catch (e) {
    if (skippedCache) return skippedCache;
    console.error(`[corpus] archive/ not listed — head resolution failed: ${String(e)}`);
    return null;
  }
  if (skippedCache?.sha === sha) return skippedCache;
  try {
    const res = await gh(`/repos/${repo()}/tarball/${sha}`);
    if (!res.ok) throw new Error(`tarball fetch failed: HTTP ${res.status}`);
    const tar = await gunzip(Buffer.from(await res.arrayBuffer()), { maxOutputLength: MAX_TAR_BYTES });
    const files = untar(tar, isSkippedNote)
      .map(([path, text]) => ({ path, bytes: Buffer.byteLength(text, "utf8") }))
      .sort((a, b) => a.path.localeCompare(b.path));
    skippedCache = { sha, files };
    return skippedCache;
  } catch (e) {
    console.error(`[corpus] archive/ not listed this render — the reader tier is unaffected: ${String(e)}`);
    return skippedCache;
  }
}
