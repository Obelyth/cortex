import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../lib/github", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/github")>()),
  gh: vi.fn(),
}));

import { gh } from "../lib/github";
import { loadCorpus, __setCache } from "../lib/corpus";
import { __setStore, type MirrorStore, type NoteRow } from "../lib/mirror";

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

function storeOf(rows: NoteRow[], head: string | null = HEAD): MirrorStore & { calls: string[] } {
  let currentHead = head;
  const byPath = new Map(rows.map((r) => [r.path, r]));
  const calls: string[] = [];
  return {
    calls,
    async head() {
      calls.push("head");
      return currentHead;
    },
    async all() {
      calls.push("all");
      return [...byPath.values()];
    },
    async apply(expectedHead, newHead, upserts, removes) {
      calls.push(`apply:${newHead}`);
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
});

describe("loadCorpus via the mirror", () => {
  it("serves from a current mirror without touching the tarball", async () => {
    ghHead();
    __setStore(
      storeOf([
        { path: "notes/a.md", content: "A", commit_sha: HEAD },
        { path: "tools/atlas-snapshot.json", content: "{}", commit_sha: HEAD },
      ])
    );
    const c = await loadCorpus(true);
    expect(c.files.get("notes/a.md")).toBe("A");
    // The sidecar rides the mirror but stays out of the corpus, same as the tarball path.
    expect(c.files.has("tools/atlas-snapshot.json")).toBe(false);
    expect(c.sidecar.get("tools/atlas-snapshot.json")).toBe("{}");
    expect(c.bytes).toBe(1);
    expect(c.sha).toBe(HEAD);
    // Exactly one gh call — the head resolution. No tarball, no contents.
    expect(mGh).toHaveBeenCalledTimes(1);
  });

  it("falls back to the tarball when the mirror throws, and still serves", async () => {
    const store = storeOf([]);
    store.all = async () => {
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
  });
});
