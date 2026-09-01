import { describe, expect, it, vi } from "vitest";
import { syncMirror, type MirrorStore, type NoteRow, type SyncDeps } from "../lib/mirror";
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
    async head() {
      return currentHead;
    },
    async all() {
      return [...rows.values()];
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
    const { store, rows, applies, head } = fakeStore();
    const d = deps({
      fullLoad: vi.fn(async () => new Map([["notes/a.md", "A"], ["tools/atlas-snapshot.json", "{}"]])),
    });
    await syncMirror(store, null, "sha2", d);
    expect(rows.get("notes/a.md")).toEqual({
      path: "notes/a.md",
      content: "A",
      commit_sha: "sha2",
      last_commit_at: "2026-08-06T12:00:00Z",
    });
    expect(head()).toBe("sha2");
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

  // A full sync now carries the head commit's date, same bound the patch path uses.
  //
  // was: it sent nothing, and note_scores coalesces a null last_commit_at to mirrored_at — which
  // sync_apply sets to now() on every upsert. So a force-push (or any commit touching more than
  // PATCH_LIMIT files) reset the AUTHORSHIP age of every full-synced row to today, re-warming
  // notes that had gone cold and pushing them back out of propose_deletions' 180-day window.
  // The migration that added the column exists specifically to stop the mirror resetting note
  // age; leaving the full-sync path out of it reopened that hole through a different column.
  it("stamps the head commit's date on a full sync", async () => {
    const { store, applies } = fakeStore([], null);
    await syncMirror(store, null, "sha2", deps());
    expect(applies[0].rows?.[0]?.last_commit_at).toBe("2026-08-06T12:00:00Z");
  });

  // Still never GUESSED. sync_apply coalesces server-side, so null preserves whatever date the
  // patch path already learned rather than blanking it.
  it("sends null on a full sync when the commit date is unavailable", async () => {
    const { store, applies } = fakeStore([], null);
    await syncMirror(store, null, "sha2", deps({
      commitDate: vi.fn(async () => { throw new Error("api down"); }),
    }));
    expect(applies[0].rows?.[0]?.last_commit_at).toBeNull();
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
