import { afterEach, describe, expect, it, vi } from "vitest";
import {
  __setStore,
  dateUndatedNotes,
  mirrorStore,
  syncMirror,
  type MirrorStore,
  type NoteDater,
  type NoteRow,
  type SyncDeps,
} from "../lib/mirror";
import type { CompareResult } from "../lib/github";

/**
 * In-memory store with the SAME CAS semantics the sync_apply function enforces in Postgres:
 * apply refuses the whole batch unless expectedHead matches, and mutates atomically. Tests that
 * exercised a softer fake would pass against a contract production does not offer.
 */
function fakeStore(seed: NoteRow[] = [], head: string | null = null) {
  const rows = new Map(seed.map((r) => [r.path, r]));
  let currentHead = head;
  const applies: Array<{ expectedHead: string | null; newHead: string; upserts: string[]; removes: string[]; rows?: NoteRow[] }> = [];
  const store: MirrorStore = {
    async snapshot() {
      return { head: currentHead, rows: [...rows.values()] };
    },
    async head() {
      return currentHead;
    },
    async paths() {
      return [...rows.keys()];
    },
    async apply(expectedHead, newHead, upserts, removes) {
      applies.push({ expectedHead, newHead, upserts: upserts.map((r) => r.path), removes, rows: upserts });
      if (currentHead !== expectedHead) return false; // the CAS
      for (const r of upserts) rows.set(r.path, r);
      for (const p of removes) rows.delete(p);
      currentHead = newHead;
      return true;
    },
    async access() {},
    async scores() { return null; },
  };
  return { store, rows, applies, head: () => currentHead };
}

afterEach(() => {
  __setStore(undefined);
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

const AHEAD = { complete: true, ahead: true };

function deps(overrides: Partial<SyncDeps> = {}): SyncDeps {
  return {
    compare: vi.fn(async (): Promise<CompareResult> => ({ changed: [], removed: [], ...AHEAD })),
    fetchAt: vi.fn(async () => "content"),
    commitDate: vi.fn(async () => "2026-08-06T12:00:00Z"),
    fullLoad: vi.fn(async () => new Map([["notes/a.md", "A"]])),
    ...overrides,
  };
}

describe("syncMirror — the backfill IS reconcile-from-empty", () => {
  it("full-syncs an empty mirror in one atomic apply", async () => {
    const legacy = { path: "tools/atlas-snapshot.json", content: "{}", commit_sha: "sha1" };
    const { store, rows, applies, head } = fakeStore([legacy], null);
    const d = deps({
      fullLoad: vi.fn(async () => new Map([["notes/a.md", "A"]])),
    });
    await syncMirror(store, null, "sha2", d);
    expect(rows.get("notes/a.md")).toEqual({
      path: "notes/a.md",
      content: "A",
      commit_sha: "sha2",
      last_commit_at: null,
    });
    expect(head()).toBe("sha2");
    expect(rows.get(legacy.path)).toEqual(legacy);
    expect(applies[0].removes).not.toContain(legacy.path);
    expect(d.compare).not.toHaveBeenCalled();
    // ONE apply carrying rows and head together. There is no partial ordering to get wrong,
    // because there are no parts: a crash leaves the old complete state or the new one.
    expect(applies).toHaveLength(1);
    expect(applies[0]).toMatchObject({ expectedHead: null, newHead: "sha2" });
  });

  it("is idempotent — a second run against the same sha does nothing", async () => {
    const { store, applies } = fakeStore([{ path: "notes/a.md", content: "A", commit_sha: "sha2" }], "sha2");
    await syncMirror(store, "sha2", "sha2", deps());
    expect(applies).toHaveLength(0);
  });

  it("removes rows the repo no longer has, in the same apply that adds the new ones", async () => {
    const { store, rows } = fakeStore(
      [
        { path: "notes/keep.md", content: "K", commit_sha: "sha1" },
        { path: "notes/ghost.md", content: "G", commit_sha: "sha1" },
      ],
      "sha1"
    );
    const d = deps({
      compare: vi.fn(async () => { throw new Error("diverged"); }),
      fullLoad: vi.fn(async () => new Map([["notes/keep.md", "K2"]])),
    });
    await syncMirror(store, "sha1", "sha2", d);
    expect(rows.has("notes/ghost.md")).toBe(false);
    expect(rows.get("notes/keep.md")?.content).toBe("K2");
  });

  it("refuses to empty the mirror when the full load produces nothing", async () => {
    const { store, rows, head } = fakeStore([{ path: "notes/a.md", content: "A", commit_sha: "sha1" }], "sha1");
    const d = deps({
      compare: vi.fn(async () => { throw new Error("x"); }),
      fullLoad: vi.fn(async () => new Map()),
    });
    await expect(syncMirror(store, "sha1", "sha2", d)).rejects.toThrow(/refusing/);
    expect(rows.size).toBe(1);
    expect(head()).toBe("sha1");
  });

  it("a lost CAS race leaves the winner's state untouched", async () => {
    const { store, rows, head } = fakeStore([{ path: "notes/w.md", content: "winner", commit_sha: "sha3" }], "sha3");
    // This instance believed the mirror was at sha1; another instance already advanced it.
    const d = deps({ fullLoad: vi.fn(async () => new Map([["notes/l.md", "loser"]])) });
    await syncMirror(store, "sha1", "sha2", d);
    expect(rows.has("notes/l.md")).toBe(false);
    expect(rows.get("notes/w.md")?.content).toBe("winner");
    expect(head()).toBe("sha3");
  });
});

describe("syncMirror — patch mode", () => {
  it("fetches changed files AT THE TARGET SHA and applies atomically", async () => {
    const { store, rows, applies, head } = fakeStore(
      [{ path: "notes/old.md", content: "O", commit_sha: "sha1" }],
      "sha1"
    );
    const fetchAt = vi.fn(async (p: string, ref: string) => `content-of-${p}@${ref}`);
    const d = deps({
      compare: vi.fn(async () => ({ changed: ["notes/new.md"], removed: ["notes/old.md"], ...AHEAD })),
      fetchAt,
    });
    await syncMirror(store, "sha1", "sha2", d);
    expect(fetchAt).toHaveBeenCalledWith("notes/new.md", "sha2");
    expect(rows.get("notes/new.md")?.content).toBe("content-of-notes/new.md@sha2");
    expect(rows.has("notes/old.md")).toBe(false);
    expect(head()).toBe("sha2");
    expect(d.fullLoad).not.toHaveBeenCalled();
    expect(applies).toHaveLength(1);
    expect(applies[0]).toMatchObject({ expectedHead: "sha1", newHead: "sha2", removes: ["notes/old.md"] });
  });

  // Regression pinned after a mutation survived the whole suite: with an EMPTY seed, skipping
  // the null-content removal was invisible. The seeded ghost makes the line load-bearing.
  it("removes a note that vanished between compare and fetch — even one already in the mirror", async () => {
    const { store, rows, head } = fakeStore(
      [{ path: "notes/vanished.md", content: "stale", commit_sha: "sha1" }],
      "sha1"
    );
    const d = deps({
      compare: vi.fn(async () => ({ changed: ["notes/vanished.md"], removed: [], ...AHEAD })),
      fetchAt: vi.fn(async () => null),
    });
    await syncMirror(store, "sha1", "sha2", d);
    expect(rows.has("notes/vanished.md")).toBe(false);
    expect(head()).toBe("sha2");
  });

  it("full-syncs when the compare is incomplete — a capped diff must never be trusted", async () => {
    const { store } = fakeStore([], "sha1");
    const d = deps({
      compare: vi.fn(async () => ({ changed: ["notes/a.md"], removed: [], complete: false, ahead: true })),
    });
    await syncMirror(store, "sha1", "sha2", d);
    expect(d.fullLoad).toHaveBeenCalled();
    expect(d.fetchAt).not.toHaveBeenCalled();
  });

  /**
   * The force-push findings, verified against the live API: "diverged" returns a MERGE-BASE diff
   * that omits everything the rewrite dropped, and "behind" — a plain reset-and-force-push —
   * returns an EMPTY diff. Patching from either stamps the new head having changed nothing and
   * the phantom rows persist forever. Only status "ahead" may patch.
   */
  it.each([
    ["behind: empty diff", { changed: [], removed: [], complete: true, ahead: false }],
    ["diverged: merge-base diff", { changed: ["notes/x.md"], removed: [], complete: true, ahead: false }],
  ])("full-syncs on a rewritten history (%s)", async (_label, diff) => {
    const { store, rows, head } = fakeStore(
      [{ path: "notes/dropped.md", content: "retracted by the rewrite", commit_sha: "sha1" }],
      "sha1"
    );
    const d = deps({
      compare: vi.fn(async () => diff as CompareResult),
      fullLoad: vi.fn(async () => new Map([["notes/kept.md", "K"]])),
    });
    await syncMirror(store, "sha1", "sha2", d);
    expect(d.fullLoad).toHaveBeenCalled();
    // The note the rewrite dropped is GONE, not preserved as a phantom.
    expect(rows.has("notes/dropped.md")).toBe(false);
    expect(rows.get("notes/kept.md")?.content).toBe("K");
    expect(head()).toBe("sha2");
  });

  it("full-syncs when the diff is bigger than per-file fetching is worth", async () => {
    const { store } = fakeStore([], "sha1");
    const d = deps({
      compare: vi.fn(async () => ({
        changed: Array.from({ length: 30 }, (_, i) => `notes/n${i}.md`),
        removed: [],
        ...AHEAD,
      })),
    });
    await syncMirror(store, "sha1", "sha2", d);
    expect(d.fullLoad).toHaveBeenCalled();
  });

  it("full-syncs when compare itself refuses", async () => {
    const { store, head } = fakeStore([], "sha1");
    const d = deps({ compare: vi.fn(async () => { throw new Error("404"); }) });
    await syncMirror(store, "sha1", "sha2", d);
    expect(d.fullLoad).toHaveBeenCalled();
    expect(head()).toBe("sha2");
  });
});

describe("write-recency provenance", () => {
  it("stamps patched rows with the head commit's date", async () => {
    const { store, applies } = fakeStore([], "sha1");
    const d = deps({
      compare: vi.fn(async () => ({ changed: ["notes/a.md"], removed: [], ...AHEAD })),
      commitDate: vi.fn(async () => "2026-08-06T12:00:00Z"),
    });
    await syncMirror(store, "sha1", "sha2", d);
    expect(applies[0].rows?.[0]?.last_commit_at).toBe("2026-08-06T12:00:00Z");
  });

  // A guessed date is worse than none: stamping now() would make a note untouched for a year
  // look freshly written, and write recency is 30% of the temperature score.
  it("leaves the date null when the lookup fails, never now()", async () => {
    const { store, applies } = fakeStore([], "sha1");
    const d = deps({
      compare: vi.fn(async () => ({ changed: ["notes/a.md"], removed: [], ...AHEAD })),
      commitDate: vi.fn(async () => { throw new Error("api down"); }),
    });
    await syncMirror(store, "sha1", "sha2", d);
    expect(applies[0].rows?.[0]?.last_commit_at).toBeNull();
  });

  // A full sync sends NULL for every row, and does not even ask for the head commit's date.
  //
  // was: it stamped every row with the head commit's date, "the same bound the patch path uses".
  // It is not the same bound: the patch path's rows are exactly the files that commit touched,
  // a full sync's rows are the whole corpus, and sync_apply's coalesce let the non-null date win.
  // Every rebuild, force-push or >PATCH_LIMIT commit therefore re-warmed the entire corpus, and
  // nothing ever went cold (measured 2026-09-04: hot 17, warm 139, cold 0 of 156). The version
  // before THAT sent nothing and note_scores coalesced NULL to mirrored_at, resetting age through
  // a different column. The fix is not a third guess: the store's rule is now that content
  // decides (migration 20260905100000), and the dater below learns the true date within a tick.
  it("sends null on a full sync — the store decides by content, the dater learns the rest", async () => {
    const { store, applies } = fakeStore([], null);
    const d = deps();
    await syncMirror(store, null, "sha2", d);
    expect(applies[0].rows?.[0]?.last_commit_at).toBeNull();
    expect(d.commitDate).not.toHaveBeenCalled();
  });
});

describe("dateUndatedNotes — the clock's second job", () => {
  function fakeDater(paths: string[]) {
    const written: Array<[string, string]> = [];
    const dater: NoteDater = {
      undated: vi.fn(async (limit: number) => paths.slice(0, limit)),
      setCommitDate: vi.fn(async (path: string, at: string) => { written.push([path, at]); }),
    };
    return { dater, written };
  }

  it("dates each undated path from git and reports the tally", async () => {
    const { dater, written } = fakeDater(["notes/a.md", "notes/b.md"]);
    const dates: Record<string, string> = { "notes/a.md": "2026-07-01T00:00:00Z", "notes/b.md": "2026-08-15T00:00:00Z" };
    const out = await dateUndatedNotes(dater, async (p) => dates[p], 20);
    expect(out).toEqual({ undated: 2, dated: 2, unknown: [], failed: [] });
    expect(written).toEqual([["notes/a.md", "2026-07-01T00:00:00Z"], ["notes/b.md", "2026-08-15T00:00:00Z"]]);
  });

  it("passes the limit through, so a tick never asks for the whole mirror", async () => {
    const { dater } = fakeDater(["a", "b", "c", "d"]);
    const out = await dateUndatedNotes(dater, async () => "2026-01-01T00:00:00Z", 2);
    expect(dater.undated).toHaveBeenCalledWith(2);
    expect(out.dated).toBe(2);
  });

  // A path git has no history for is reported and left NULL. Writing now() would be the guess
  // this whole column exists to refuse.
  it("leaves a path with no history undated and names it", async () => {
    const { dater, written } = fakeDater(["notes/ghost.md", "notes/real.md"]);
    const out = await dateUndatedNotes(dater, async (p) => (p === "notes/real.md" ? "2026-05-05T00:00:00Z" : null));
    expect(out.unknown).toEqual(["notes/ghost.md"]);
    expect(out.dated).toBe(1);
    expect(written.map(([p]) => p)).toEqual(["notes/real.md"]);
  });

  it("isolates one failing lookup to one path — the batch goes on", async () => {
    const { dater } = fakeDater(["notes/a.md", "notes/b.md", "notes/c.md"]);
    const out = await dateUndatedNotes(dater, async (p) => {
      if (p === "notes/b.md") throw new Error("502");
      return "2026-03-03T00:00:00Z";
    });
    expect(out.failed).toEqual(["notes/b.md"]);
    expect(out.dated).toBe(2);
  });

  it("stops at the deadline and leaves the rest for the next tick", async () => {
    const { dater } = fakeDater(["a", "b", "c"]);
    let calls = 0;
    const out = await dateUndatedNotes(dater, async () => { calls++; return "2026-03-03T00:00:00Z"; }, 20, () => calls >= 1);
    expect(out.dated).toBe(1);
    expect(out.undated).toBe(3);
  });
});

/**
 * Regression: 2026-08-12. A note carrying a literal NUL byte (U+0000) landed in the brain, and
 * every sync_apply from then on 400'd whole — Postgres cannot hold the byte in text, and jsonb
 * refuses its escape outright — so the mirror froze at the last clean commit and the connections
 * graph (whose rebuild trigger rides the mirror path only) froze with it, both silently. The
 * sync seam must strip exactly that byte: history already carrying it has to stay syncable, and
 * every byte the store CAN hold must survive untouched.
 */
describe("syncMirror — bytes the store cannot hold", () => {
  const NUL = String.fromCharCode(0);

  it("strips U+0000 from patched content — one poisoned note must not brick the whole sync", async () => {
    const { store, applies, head } = fakeStore([{ path: "notes/a.md", content: "A", commit_sha: "sha1" }], "sha1");
    const d = deps({
      compare: vi.fn(async () => ({ changed: ["projects/example.md"], removed: [], ...AHEAD })),
      fetchAt: vi.fn(async () => `before${NUL}after`),
    });
    await syncMirror(store, "sha1", "sha2", d);
    expect(applies[0].rows?.[0]?.content).toBe("beforeafter");
    expect(head()).toBe("sha2");
  });

  it("strips U+0000 on the full-sync path too — the backfill must survive a poisoned history", async () => {
    const { store, applies } = fakeStore([], null);
    const d = deps({
      fullLoad: vi.fn(async () => new Map([["projects/example.md", `x${NUL}${NUL}y`]])),
    });
    await syncMirror(store, null, "sha2", d);
    expect(applies[0].rows?.[0]?.content).toBe("xy");
  });

  it("leaves every storable byte alone — newlines, tabs, a CRLF note, the router separator", async () => {
    const text = "line one\n\tline two\r\nsnippet with the router separator: path - desc - tags";
    const { store, applies } = fakeStore([], null);
    const d = deps({ fullLoad: vi.fn(async () => new Map([["notes/a.md", text]])) });
    await syncMirror(store, null, "sha2", d);
    expect(applies[0].rows?.[0]?.content).toBe(text);
  });
});

function configuredStore(fetcher: typeof fetch): MirrorStore {
  vi.stubEnv("SUPABASE_URL", "https://mirror.example");
  vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "service-secret");
  vi.stubGlobal("fetch", fetcher);
  const store = mirrorStore();
  if (!store) throw new Error("test mirror store was not configured");
  return store;
}

describe("PostgREST mirror snapshot contract", () => {
  const HEAD = "a".repeat(40);

  it("reads and validates the scalar corpus_snapshot JSON envelope", async () => {
    const store = configuredStore(vi.fn(async () => new Response(JSON.stringify({
      head: HEAD,
      rows: [{ path: "notes/a.md", content: "exact\r\ntext", commit_sha: "b".repeat(40) }],
    }), { status: 200 })));

    await expect(store.snapshot()).resolves.toEqual({
      head: HEAD,
      rows: [{ path: "notes/a.md", content: "exact\r\ntext", commit_sha: "b".repeat(40) }],
    });
  });

  it.each([
    ["missing head", { rows: [] }],
    ["invalid populated head", { head: "not-a-sha", rows: [{ path: "notes/a.md", content: "A", commit_sha: HEAD }] }],
    ["empty head with populated rows", { head: "", rows: [{ path: "notes/a.md", content: "A", commit_sha: HEAD }] }],
    ["duplicate path", { head: HEAD, rows: [
      { path: "notes/a.md", content: "A", commit_sha: HEAD },
      { path: "notes/a.md", content: "B", commit_sha: HEAD },
    ] }],
    ["wrong row type", { head: HEAD, rows: [{ path: "notes/a.md", content: 4, commit_sha: HEAD }] }],
  ])("rejects %s rather than returning unchecked rows", async (_label, payload) => {
    const store = configuredStore(vi.fn(async () => new Response(JSON.stringify(payload), { status: 200 })));
    await expect(store.snapshot()).rejects.toThrow(/snapshot/i);
  });

  it("accepts the seeded empty-string head only for an empty uninitialized mirror", async () => {
    const store = configuredStore(vi.fn(async () => new Response('{"head":"","rows":[]}', { status: 200 })));
    await expect(store.snapshot()).resolves.toEqual({ head: "", rows: [] });
  });

  it("rejects a declared response body above the transport ceiling", async () => {
    const body = new ReadableStream({
      pull(controller) {
        controller.enqueue(new TextEncoder().encode('{"head":null,"rows":[]}'));
        controller.close();
      },
    });
    const store = configuredStore(vi.fn(async () => new Response(body, {
      status: 200,
      headers: { "Content-Length": String(64 * 1024 * 1024 + 1) },
    })));

    await expect(store.snapshot()).rejects.toThrow(/too large/i);
  });

  it("fails closed when corpus_snapshot RPC is missing", async () => {
    const store = configuredStore(vi.fn(async () => new Response("not found", { status: 404 })));
    await expect(store.snapshot()).rejects.toThrow(/corpus_snapshot 404/);
  });
});

describe("PostgREST administrative keyset pagination", () => {
  const rows = Array.from({ length: 650 }, (_, i) => ({
    path: `notes/${String(i).padStart(4, "0")}.md`,
    temperature: "warm" as const,
    score: i / 1000,
    reads: i,
  }));

  function cappedTransport(failAfter = Number.POSITIVE_INFINITY) {
    const urls: string[] = [];
    let calls = 0;
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      calls++;
      const url = new URL(String(input));
      urls.push(url.toString());
      if (calls > failAfter) return new Response("down", { status: 503 });
      const cursor = url.searchParams.get("path")?.replace(/^gt\./, "") ?? null;
      const page = rows.filter((row) => cursor === null || row.path > cursor).slice(0, 500);
      const projected = url.pathname.endsWith("/notes") ? page.map(({ path }) => ({ path })) : page;
      return new Response(JSON.stringify(projected), { status: 200 });
    });
    return { fetcher: fetcher as typeof fetch, urls };
  }

  it("lists all paths through capped short pages and stops only on the empty page", async () => {
    const { fetcher, urls } = cappedTransport();
    const store = configuredStore(fetcher);
    const paths = await store.paths();
    expect(paths).toEqual(rows.map((row) => row.path));
    expect(new Set(paths).size).toBe(650);
    expect(urls).toHaveLength(3);
  });

  it("lists all scores through capped short pages without duplicates", async () => {
    const { fetcher, urls } = cappedTransport();
    const store = configuredStore(fetcher);
    const scores = await store.scores();
    expect(scores).not.toBeNull();
    expect(scores!.map((row) => row.path)).toEqual(rows.map((row) => row.path));
    expect(new Set(scores!.map((row) => row.path)).size).toBe(650);
    expect(urls).toHaveLength(3);
  });

  it("encodes the last returned path as the next keyset cursor", async () => {
    const tricky = "notes/z tricky,!()'.md";
    let call = 0;
    const urls: URL[] = [];
    const store = configuredStore(vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      urls.push(url);
      call++;
      return new Response(JSON.stringify(call === 1 ? [{ path: tricky }] : []), { status: 200 });
    }));
    await store.paths();
    expect(urls[1].searchParams.get("path")).toBe(`gt.${tricky}`);
  });

  it("accepts database collation order without re-sorting it as JavaScript strings", async () => {
    let call = 0;
    const databaseOrdered = [{ path: "notes/z.md" }, { path: "notes/A.md" }];
    const store = configuredStore(vi.fn(async () => new Response(
      JSON.stringify(call++ === 0 ? databaseOrdered : []),
      { status: 200 }
    )));
    await expect(store.paths()).resolves.toEqual(databaseOrdered.map((row) => row.path));
  });

  it("rejects a repeated cursor instead of looping forever", async () => {
    const store = configuredStore(vi.fn(async () => new Response('[{"path":"notes/a.md"}]', { status: 200 })));
    await expect(store.paths()).rejects.toThrow(/progress/i);
  });

  it("returns no score list when a later page fails instead of a truncated prefix", async () => {
    const { fetcher } = cappedTransport(1);
    const store = configuredStore(fetcher);
    await expect(store.scores()).resolves.toBeNull();
  });
});
