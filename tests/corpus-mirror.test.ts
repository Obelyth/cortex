import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../lib/github", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/github")>()),
  gh: vi.fn(),
}));

import { gh } from "../lib/github";
import { loadCorpus, __setCache } from "../lib/corpus";
import { __setStore, type MirrorSnapshot, type MirrorStore, type NoteRow } from "../lib/mirror";

const mGh = vi.mocked(gh);

const HEAD = "a".repeat(40);

function ghHead() {
  mGh.mockImplementation(async (path: string) => {
    if (path.includes("/commits/")) {
      return { ok: true, json: async () => ({ sha: HEAD }) } as unknown as Response;
    }
    throw new Error(`unexpected gh call in this test: ${path}`);
  });
}

function storeOf(rows: NoteRow[], head: string | null = HEAD): MirrorStore & {
  calls: string[];
  rows: Map<string, NoteRow>;
  removed: string[][];
} {
  let currentHead = head;
  const byPath = new Map(rows.map((r) => [r.path, r]));
  const calls: string[] = [];
  const removed: string[][] = [];
  return {
    calls,
    rows: byPath,
    removed,
    async snapshot() {
      calls.push("snapshot");
      return { head: currentHead, rows: [...byPath.values()] };
    },
    async head() {
      calls.push("head");
      return currentHead;
    },
    async paths() {
      calls.push("paths");
      return [...byPath.keys()];
    },
    async apply(expectedHead, newHead, upserts, removes) {
      calls.push(`apply:${newHead}`);
      removed.push([...removes]);
      if (currentHead !== expectedHead) return false;
      for (const r of upserts) byPath.set(r.path, r);
      for (const q of removes) byPath.delete(q);
      currentHead = newHead;
      return true;
    },
    async access() {
      calls.push("access");
    },
    async scores() {
      calls.push("scores");
      return null;
    },
  };
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv("BRAIN_REPO", "owner/brain");
  vi.stubEnv("GITHUB_TOKEN", "t");
  __setCache(null);
});

afterEach(() => {
  __setStore(undefined);
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

async function archiveResponse(text: string): Promise<Response> {
  const { gzipSync } = await import("node:zlib");
  const { tarOf } = await import("./helpers/tar");
  const buf = gzipSync(tarOf({ "brain-abc/notes/archive-fallback.md": text }));
  return { ok: true, arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) } as unknown as Response;
}

describe("loadCorpus via the mirror", () => {
  it("serves from a current mirror without touching the tarball", async () => {
    ghHead();
    const store = storeOf([
      { path: "notes/a.md", content: "A", commit_sha: HEAD },
      { path: "tools/atlas-snapshot.json", content: "{}", commit_sha: HEAD },
    ]);
    __setStore(store);
    const c = await loadCorpus(true);
    expect(c.files.get("notes/a.md")).toBe("A");
    expect([...c.files.keys()]).toEqual(["notes/a.md"]);
    // A pre-retirement mirror row is ignored rather than retained in a second client-visible map.
    expect(Object.hasOwn(c, "sidecar")).toBe(false);
    expect(c.bytes).toBe(1);
    expect(c.sha).toBe(HEAD);
    expect(store.calls).toEqual(["snapshot"]);
    // Exactly one gh call — the head resolution. No tarball, no contents.
    expect(mGh).toHaveBeenCalledTimes(1);
  });

  it("never combines generation B rows with generation A's head", async () => {
    ghHead();
    const A = HEAD;
    const B = "b".repeat(40);
    const atomicA: MirrorSnapshot = {
      head: A,
      rows: [{ path: "notes/a.md", content: "generation A", commit_sha: A }],
    };
    let currentHead = A;
    let currentRows = atomicA.rows;
    __setStore({
      async snapshot() {
        const captured = { head: currentHead, rows: currentRows };
        currentHead = B;
        currentRows = [{ path: "notes/a.md", content: "generation B", commit_sha: B }];
        return captured;
      },
      async head() { return currentHead; },
      async paths() { return currentRows.map((row) => row.path); },
      async apply() { return true; },
      async access() {},
      async scores() { return null; },
    });

    const corpus = await loadCorpus(true);
    expect(corpus.sha).toBe(A);
    expect(corpus.files.get("notes/a.md")).toBe("generation A");
  });

  it("heals the seeded empty-string head using that exact CAS value", async () => {
    ghHead();
    const store = storeOf([], "");
    __setStore(store);
    const { gzipSync } = await import("node:zlib");
    const { tarOf } = await import("./helpers/tar");
    mGh.mockImplementation(async (path: string) => {
      if (path.includes("/commits/")) return { ok: true, json: async () => ({ sha: HEAD }) } as unknown as Response;
      if (path.includes("/tarball/")) {
        const buf = gzipSync(tarOf({ "brain-abc/notes/a.md": "seed healed" }));
        return { ok: true, arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) } as unknown as Response;
      }
      throw new Error(`unexpected gh call: ${path}`);
    });

    const corpus = await loadCorpus(true);
    expect(corpus.files.get("notes/a.md")).toBe("seed healed");
    expect(store.calls).toEqual(["snapshot", "paths", `apply:${HEAD}`, "snapshot"]);
  });

  it("reads the winner atomically after a lost CAS and uses the winner snapshot's own head", async () => {
    const OLD = "b".repeat(40);
    const WINNER = "c".repeat(40);
    ghHead();
    let phase: "old" | "winner" = "old";
    const oldRow = { path: "notes/a.md", content: "old", commit_sha: OLD };
    // Unchanged content can legitimately retain OLD as its row-level content revision even when
    // the coherent snapshot itself is WINNER.
    const winnerRow = { path: "notes/a.md", content: "winner", commit_sha: OLD };
    __setStore({
      async snapshot() {
        return phase === "old"
          ? { head: OLD, rows: [oldRow] }
          : { head: WINNER, rows: [winnerRow] };
      },
      async head() { return phase === "old" ? OLD : WINNER; },
      async paths() { return ["notes/a.md"]; },
      async apply() {
        phase = "winner";
        return false;
      },
      async access() {},
      async scores() { return null; },
    });
    vi.stubGlobal("fetch", vi.fn(async (url: RequestInfo | URL) => {
      if (String(url).includes("/compare/")) {
        return { ok: true, json: async () => ({ status: "ahead", files: [] }) } as unknown as Response;
      }
      throw new Error(`unexpected fetch: ${String(url)}`);
    }));

    const corpus = await loadCorpus(true);
    expect(corpus.sha).toBe(WINNER);
    expect(corpus.files.get("notes/a.md")).toBe("winner");
  });

  it("filters legacy excluded rows at serve time without deleting customer storage", async () => {
    ghHead();
    const excluded = { path: "archive/old.md", content: "retired", commit_sha: HEAD };
    const store = storeOf([
      { path: "notes/live.md", content: "live", commit_sha: HEAD },
      excluded,
    ]);
    __setStore(store);

    const corpus = await loadCorpus(true);
    expect([...corpus.files.keys()]).toEqual(["notes/live.md"]);
    expect(store.rows.get(excluded.path)).toEqual(excluded);
    expect(store.calls).toEqual(["snapshot"]);
  });

  it("full-syncs a behind mirror and removes rows the live policy excludes, without ever serving them", async () => {
    const OLD = "b".repeat(40);
    const excluded = { path: "archive/old.md", content: "retired", commit_sha: OLD };
    const store = storeOf([
      { path: "notes/live.md", content: "old live", commit_sha: OLD },
      excluded,
    ], OLD);
    __setStore(store);
    const { gzipSync } = await import("node:zlib");
    const { tarOf } = await import("./helpers/tar");
    mGh.mockImplementation(async (path: string) => {
      if (path.includes("/commits/")) return { ok: true, json: async () => ({ sha: HEAD }) } as unknown as Response;
      if (path.includes("/tarball/")) {
        const buf = gzipSync(tarOf({
          "brain-abc/notes/live.md": "new live",
          "brain-abc/archive/old.md": "retired",
        }));
        return { ok: true, arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) } as unknown as Response;
      }
      throw new Error(`unexpected gh call: ${path}`);
    });
    vi.stubGlobal("fetch", vi.fn(async (url: RequestInfo | URL) => {
      if (String(url).includes("/compare/")) {
        return { ok: true, json: async () => ({ status: "behind", files: [] }) } as unknown as Response;
      }
      throw new Error(`unexpected fetch: ${String(url)}`);
    }));

    const corpus = await loadCorpus(true);
    expect([...corpus.files.entries()]).toEqual([["notes/live.md", "new live"]]);
    // Named in the removal, not left behind: a row outside the live policy is a stale row. Git
    // re-imports it on the next full sync if the policy ever readmits it, and until then it would
    // only ride along in every corpus_snapshot() payload for nothing to read.
    expect(store.removed).toEqual([[excluded.path]]);
    expect(store.rows.has(excluded.path)).toBe(false);
  });

  it("falls back to the tarball when the mirror throws, and still serves", async () => {
    const store = storeOf([]);
    store.snapshot = async () => {
      throw new Error("postgrest down");
    };
    __setStore(store);
    // gh serves head + a real-enough tarball via the actual code path.
    const { gzipSync } = await import("node:zlib");
    const tarOf = (await import("./helpers/tar")).tarOf;
    mGh.mockImplementation(async (path: string) => {
      if (path.includes("/commits/")) return { ok: true, json: async () => ({ sha: HEAD }) } as unknown as Response;
      if (path.includes("/tarball/")) {
        const buf = gzipSync(tarOf({ "brain-abc/notes/a.md": "from-tarball" }));
        return { ok: true, arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) } as unknown as Response;
      }
      throw new Error(`unexpected: ${path}`);
    });
    const c = await loadCorpus(true);
    expect(c.files.get("notes/a.md")).toBe("from-tarball");
  });

  it("with no store configured, never emits mirror traffic at all", async () => {
    __setStore(null);
    const { gzipSync } = await import("node:zlib");
    const tarOf = (await import("./helpers/tar")).tarOf;
    mGh.mockImplementation(async (path: string) => {
      if (path.includes("/commits/")) return { ok: true, json: async () => ({ sha: HEAD }) } as unknown as Response;
      if (path.includes("/tarball/")) {
        const buf = gzipSync(tarOf({ "brain-abc/notes/a.md": "plain" }));
        return { ok: true, arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) } as unknown as Response;
      }
      throw new Error(`unexpected: ${path}`);
    });
    const c = await loadCorpus(true);
    expect(c.files.get("notes/a.md")).toBe("plain");
  });

  it("refuses to serve an empty mirror — that failure falls through to the tarball", async () => {
    __setStore(storeOf([]));
    const { gzipSync } = await import("node:zlib");
    const tarOf = (await import("./helpers/tar")).tarOf;
    mGh.mockImplementation(async (path: string) => {
      if (path.includes("/commits/")) return { ok: true, json: async () => ({ sha: HEAD }) } as unknown as Response;
      if (path.includes("/tarball/")) {
        const buf = gzipSync(tarOf({ "brain-abc/notes/real.md": "still here" }));
        return { ok: true, arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) } as unknown as Response;
      }
      throw new Error(`unexpected: ${path}`);
    });
    const c = await loadCorpus(true);
    expect(c.files.get("notes/real.md")).toBe("still here");
  });
});

describe("loadCorpus heals a behind mirror through the real wiring", () => {
  // Pinned after a mutation survived the full suite: swapping compareCommits' base and head in
  // buildFromMirror was invisible, because every earlier case either matched heads or threw
  // before sync. This drives the head-differs path through the REAL compareCommits and
  // fetchFileAt over a mocked transport, and pins the argument order in the URL itself.
  it("compares mirrorHead...head, fetches at the pinned ref, applies atomically", async () => {
    const OLD = "b".repeat(40);
    const store = storeOf([{ path: "notes/a.md", content: "old", commit_sha: OLD }], OLD);
    __setStore(store);
    const urls: string[] = [];
    // headSha (corpus.ts) and fetchFileAt (mirror.ts) reach gh ACROSS module boundaries, so the
    // export mock catches them.
    mGh.mockImplementation(async (path: string) => {
      urls.push(path);
      if (path.includes("/commits/")) return { ok: true, json: async () => ({ sha: HEAD }) } as unknown as Response;
      if (path.includes("/contents/")) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ content: Buffer.from("new content").toString("base64"), encoding: "base64" }),
        } as unknown as Response;
      }
      throw new Error(`unexpected gh: ${path}`);
    });
    // compareCommits and fetchFileAt call gh MODULE-INTERNALLY — the export mock cannot
    // intercept those, which is exactly why this test exists: it exercises the real wiring.
    // Their traffic is answered at the fetch layer instead.
    vi.stubGlobal("fetch", vi.fn(async (url: RequestInfo | URL) => {
      const u = String(url);
      urls.push(u);
      if (u.includes("/compare/")) {
        return {
          ok: true,
          json: async () => ({ status: "ahead", files: [{ filename: "notes/a.md", status: "modified" }] }),
        } as unknown as Response;
      }
      throw new Error(`unexpected fetch: ${u}`);
    }));
    const c = await loadCorpus(true);
    expect(c.files.get("notes/a.md")).toBe("new content");
    const compareUrl = urls.find((u) => u.includes("/compare/"))!;
    expect(compareUrl).toContain(`/compare/${OLD}...${HEAD}`);
    const contentsUrl = urls.find((u) => u.includes("/contents/"))!;
    expect(contentsUrl).toContain(`ref=${HEAD}`);
    expect(store.calls).toContain(`apply:${HEAD}`);
    expect(store.calls.filter((call) => call === "snapshot")).toHaveLength(2);
  });
});

describe("loadCorpus rejects unsafe PostgREST snapshots before caching", () => {
  function usePostgrest(response: () => Response | Promise<Response>) {
    __setStore(undefined);
    vi.stubEnv("SUPABASE_URL", "https://mirror.example");
    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "service-secret");
    vi.stubGlobal("fetch", vi.fn(async () => response()));
  }

  function pinArchive(text = "trusted archive") {
    mGh.mockImplementation(async (path: string) => {
      if (path.includes("/commits/")) return { ok: true, json: async () => ({ sha: HEAD }) } as unknown as Response;
      if (path.includes("/tarball/")) return archiveResponse(text);
      throw new Error(`unexpected gh call: ${path}`);
    });
  }

  it.each([
    ["missing RPC", () => new Response("not found", { status: 404 })],
    ["malformed JSON", () => new Response("{", { status: 200 })],
    ["invalid head", () => new Response(JSON.stringify({ head: "bad", rows: [] }), { status: 200 })],
    ["wrong row type", () => new Response(JSON.stringify({ head: HEAD, rows: [{ path: "notes/a.md", content: 3, commit_sha: HEAD }] }), { status: 200 })],
    ["duplicate path", () => new Response(JSON.stringify({ head: HEAD, rows: [
      { path: "notes/a.md", content: "A", commit_sha: HEAD },
      { path: "notes/a.md", content: "B", commit_sha: HEAD },
    ] }), { status: 200 })],
    ["oversize transport", () => new Response("{}", {
      status: 200,
      headers: { "Content-Length": String(64 * 1024 * 1024 + 1) },
    })],
  ])("falls back to the pinned archive for %s and caches only that valid corpus", async (_label, response) => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    pinArchive();
    usePostgrest(response);

    const corpus = await loadCorpus(true);
    expect(corpus.sha).toBe(HEAD);
    expect(corpus.files.get("notes/archive-fallback.md")).toBe("trusted archive");

    mGh.mockRejectedValueOnce(new Error("head unavailable"));
    const cached = await loadCorpus();
    expect(cached).toBe(corpus);
    expect(cached.files.get("notes/archive-fallback.md")).toBe("trusted archive");
    expect(errors).toHaveBeenCalled();
  });

  it("raises when both an invalid snapshot and its pinned archive fail", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    mGh.mockImplementation(async (path: string) => {
      if (path.includes("/commits/")) return { ok: true, json: async () => ({ sha: HEAD }) } as unknown as Response;
      return { ok: false, status: 503 } as Response;
    });
    usePostgrest(() => new Response(JSON.stringify({ head: "bad", rows: [] }), { status: 200 }));

    await expect(loadCorpus(true)).rejects.toThrow(/tarball fetch failed: HTTP 503/);
  });
});
