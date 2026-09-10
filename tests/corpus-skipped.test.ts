import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import zlib from "node:zlib";

/**
 * listSkipped() — archive/ as a listing, for the explorer (approved console design): paths and sizes
 * and nothing else, so "the brain does not know" and "the brain filed it away" can be told
 * apart on the screen. Read-only and display-only by construction: it never returns text, so
 * nothing downstream can hand a skipped note to narrow() or the reader.
 */
const calls: string[] = [];
let tarball: Buffer | null = null;
let headOk = true;

vi.mock("../lib/github", () => ({
  getFile: vi.fn(),
  putFile: vi.fn(),
  listTree: vi.fn(),
  gh: vi.fn(async (path: string) => {
    calls.push(path);
    if (path.includes("/commits/")) {
      return headOk ? new Response(JSON.stringify({ sha: "deadbeefcafe0000" }), { status: 200 }) : new Response(null, { status: 502 });
    }
    if (path.includes("/tarball/")) {
      return tarball ? new Response(new Uint8Array(tarball), { status: 200 }) : new Response(null, { status: 502 });
    }
    throw new Error(`unexpected gh call ${path}`);
  }),
  repo: () => "owner/brain",
  branch: () => "main",
}));

import { __setSkipped, isSkippedNote, listSkipped, SKIPPED_NOTES_PREFIX, SKIP_PREFIX } from "../lib/corpus";

function seal(h: Buffer): Buffer {
  h.write(" ".repeat(8), 148, 8, "ascii");
  let sum = 0;
  for (let i = 0; i < 512; i++) sum += h[i];
  h.write(sum.toString(8).padStart(6, "0") + "\0 ", 148, 8, "ascii");
  return h;
}

/** A real gzipped tar the way GitHub ships one: everything under <repo>-<sha>/. */
function makeTarball(files: Record<string, string>): Buffer {
  const blocks: Buffer[] = [];
  for (const [name, body] of Object.entries(files)) {
    const header = Buffer.alloc(512);
    header.write(`brain-abc123/${name}`, 0, 100, "utf8");
    header.write(Buffer.byteLength(body).toString(8).padStart(11, "0") + "\0", 124, 12, "ascii");
    header.write("0", 156, 1, "ascii");
    blocks.push(seal(header));
    const data = Buffer.from(body, "utf8");
    blocks.push(data, Buffer.alloc(Math.ceil(data.length / 512) * 512 - data.length));
  }
  blocks.push(Buffer.alloc(1024));
  return zlib.gzipSync(Buffer.concat(blocks));
}

beforeEach(() => {
  calls.length = 0;
  headOk = true;
  __setSkipped(null);
  tarball = makeTarball({
    "profile.md": "# me",
    "notes/example-1.md": "alpha",
    "archive/example-old-2.md": "old · two",
    "archive/example-old-1.md": "old one",
    "archive/deeper/example-old-3.md": "x".repeat(600),
    "archive/not-a-note.txt": "ignored",
    "tools/example.py": "print()",
  });
});
afterEach(() => __setSkipped(null));

describe("isSkippedNote", () => {
  it("is exactly the archive/ notes — the one skipped prefix that holds writing rather than code", () => {
    expect(SKIPPED_NOTES_PREFIX).toBe("archive/");
    expect(SKIP_PREFIX).toContain(SKIPPED_NOTES_PREFIX);
    expect(isSkippedNote("archive/example-old-1.md")).toBe(true);
    expect(isSkippedNote("archive/deeper/example-old-3.MD")).toBe(true);
    expect(isSkippedNote("archive/not-a-note.txt")).toBe(false);
    expect(isSkippedNote("notes/example-1.md")).toBe(false);
    expect(isSkippedNote("tools/example.md")).toBe(false);
  });
});

describe("listSkipped", () => {
  it("lists archive/ notes only, by path, with real byte sizes and no text", async () => {
    const s = await listSkipped();
    expect(s?.sha).toBe("deadbeefcafe0000");
    expect(s?.files).toEqual([
      { path: "archive/deeper/example-old-3.md", bytes: 600 },
      { path: "archive/example-old-1.md", bytes: 7 },
      { path: "archive/example-old-2.md", bytes: Buffer.byteLength("old · two", "utf8") },
    ]);
    for (const f of s!.files) expect(Object.keys(f).sort()).toEqual(["bytes", "path"]);
  });

  it("fetches the tarball once per head — a second call at the same sha is served from the cache", async () => {
    await listSkipped();
    await listSkipped();
    expect(calls.filter((c) => c.includes("/tarball/"))).toHaveLength(1);
    expect(calls.filter((c) => c.includes("/commits/"))).toHaveLength(2);
  });

  it("returns null when the listing cannot be made and nothing was ever listed — never an empty archive/", async () => {
    tarball = null;
    expect(await listSkipped()).toBeNull();
    headOk = false;
    expect(await listSkipped()).toBeNull();
  });

  it("keeps the last good listing when the next fetch fails", async () => {
    const first = await listSkipped();
    tarball = null;
    __setSkipped({ sha: "0000000000000000", files: first!.files });
    expect(await listSkipped()).toEqual({ sha: "0000000000000000", files: first!.files });
    headOk = false;
    expect(await listSkipped()).toEqual({ sha: "0000000000000000", files: first!.files });
  });
});
