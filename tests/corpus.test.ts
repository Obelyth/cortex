import { describe, expect, it, beforeEach } from "vitest";
import zlib from "node:zlib";
import { untar, isLive, loadCorpus, __setCache } from "../lib/corpus";
import { normalise, verifyQuote, checkCitation, MIN_QUOTE } from "../lib/verify";
import { rank, narrow, tokenize } from "../lib/narrow";

/** Write the ustar header checksum. untar rejects headers that fail it — that check is what
 *  stops a mis-measured entry's payload being parsed as headers. Real writers always emit it. */
function seal(h: Buffer): Buffer {
  h.write(" ".repeat(8), 148, 8, "ascii");
  let sum = 0;
  for (let i = 0; i < 512; i++) sum += h[i];
  h.write(sum.toString(8).padStart(6, "0") + "\0 ", 148, 8, "ascii");
  return h;
}

/** Build a real gzipped tar the way GitHub does: everything under <repo>-<sha>/. */
function makeTarball(files: Record<string, string>): Buffer {
  const blocks: Buffer[] = [];
  for (const [name, body] of Object.entries(files)) {
    const header = Buffer.alloc(512);
    header.write(`brain-abc123/${name}`, 0, 100, "utf8");
    header.write(Buffer.byteLength(body).toString(8).padStart(11, "0") + "\0", 124, 12, "ascii");
    header.write("0", 156, 1, "ascii");
    blocks.push(seal(header));
    const data = Buffer.from(body, "utf8");
    const pad = Buffer.alloc(Math.ceil(data.length / 512) * 512 - data.length);
    blocks.push(data, pad);
  }
  blocks.push(Buffer.alloc(1024)); // end-of-archive
  return zlib.gzipSync(Buffer.concat(blocks));
}

describe("untar", () => {
  it("reads a GitHub-shaped tarball and strips the wrapper directory", () => {
    const tar = zlib.gunzipSync(makeTarball({ "profile.md": "# me", "notes/a.md": "alpha" }));
    expect(untar(tar)).toEqual([
      ["profile.md", "# me"],
      ["notes/a.md", "alpha"],
    ]);
  });

  it("survives a file whose size is not a multiple of 512", () => {
    const body = "x".repeat(513);
    const tar = zlib.gunzipSync(makeTarball({ "notes/big.md": body, "notes/after.md": "still here" }));
    const got = new Map(untar(tar));
    expect(got.get("notes/big.md")).toHaveLength(513);
    expect(got.get("notes/after.md")).toBe("still here"); // offset arithmetic stayed aligned
  });

  it("returns nothing for an empty archive rather than throwing", () => {
    expect(untar(Buffer.alloc(1024))).toEqual([]);
  });

  it("reads paths stored in the ustar prefix field", () => {
    // Regression: any path over 100 chars is split across a `prefix` field at offset 345.
    // Reading only `name` dropped every long-path entry silently — live notes among them,
    // which the reader would then have answered "not in brain" for.
    const deep = "backup-2025-01/part1-writeup-sample-collection-evolution-with-a-long-name.md";
    const header = Buffer.alloc(512);
    header.write(deep.split("/").pop()!, 0, 100, "utf8");            // name field
    header.write("0".padStart(11, "0") + "\0", 124, 12, "ascii");    // size 0
    header.write("0", 156, 1, "ascii");                              // regular file
    header.write(`brain-abc123/archive/${deep.split("/")[0]}`, 345, 155, "utf8"); // prefix
    const tar = Buffer.concat([seal(header), Buffer.alloc(1024)]);
    const got = untar(tar);
    expect(got).toHaveLength(1);
    expect(got[0][0]).toBe(`archive/backup-2025-01/${deep.split("/").pop()}`);
  });
});

describe("corpus/reference ranker parity", () => {
  it("excludes exactly the prefixes the reference ranker excludes", () => {
    // Two definitions of "the live corpus" that disagree is the dual-implementation drift
    // this rebuild exists to delete. The reference ranker's SKIP_PREFIX must match this list;
    // when they diverge, the two see different corpora.
    const py = [".git/", ".claude/", "tools/", "archive/", "brain-v2/", ".github/"];
    for (const prefix of py) expect(isLive(`${prefix}whatever.md`)).toBe(false);
    for (const name of ["brain-index.md", "INDEX.md", "README.md"]) {
      expect(isLive(`notes/${name}`)).toBe(false);
      expect(isLive(name)).toBe(false);
    }
  });
});

describe("isLive", () => {
  it("keeps notes, projects, profile and logs", () => {
    for (const p of ["profile.md", "projects/sample.md", "notes/x.md", "log/2026-07-28.md"]) {
      expect(isLive(p)).toBe(true);
    }
  });

  it("excludes archive, tooling and generated catalogues", () => {
    // archive can be a large share of the bytes and holds superseded claims; a reader given
    // both can answer from the dead one. The generated indexes are the thing this rebuild deletes.
    for (const p of ["archive/backup-2025-01/x.md", "tools/recall.py", "notes/brain-index.md", "INDEX.md", "README.md"]) {
      expect(isLive(p)).toBe(false);
    }
  });

  it("ignores non-markdown", () => {
    expect(isLive("tools/data.json")).toBe(false);
  });
});

describe("loadCorpus", () => {
  beforeEach(() => __setCache(null));

  it("fetches, unpacks, filters and caches on the commit sha", async () => {
    process.env.BRAIN_REPO = "example-owner/brain";
    process.env.GITHUB_TOKEN = "t";
    const tarball = makeTarball({
      "tools/atlas-snapshot.json": "{\"capturedAt\":\"retired\"}",
      "profile.md": "operator",
      "projects/sample.md": "the oven is cold",
      "archive/old.md": "superseded",
      "notes/brain-index.md": "generated",
    });
    let calls = 0;
    const orig = globalThis.fetch;
    globalThis.fetch = (async (url: string) => {
      calls++;
      if (String(url).includes("/commits/")) {
        return new Response(JSON.stringify({ sha: "deadbeef" }), { status: 200 });
      }
      return new Response(new Uint8Array(tarball), { status: 200 });
    }) as typeof fetch;

    try {
      const c = await loadCorpus();
      expect(c.sha).toBe("deadbeef");
      expect([...c.files.keys()].sort()).toEqual(["profile.md", "projects/sample.md"]);
      expect(Object.hasOwn(c, "sidecar")).toBe(false);
      expect(calls).toBe(2); // head + tarball. The old path cost ~128 per write.

      // A second call at the same sha must not refetch the tarball.
      const before = calls;
      const again = await loadCorpus();
      expect(again).toBe(c);
      expect(calls - before).toBe(1); // only the cheap head check
    } finally {
      globalThis.fetch = orig;
    }
  });

  it("refuses to serve an empty corpus instead of answering from half a brain", async () => {
    process.env.BRAIN_REPO = "example-owner/brain";
    process.env.GITHUB_TOKEN = "t";
    const orig = globalThis.fetch;
    globalThis.fetch = (async (url: string) =>
      String(url).includes("/commits/")
        ? new Response(JSON.stringify({ sha: "s" }), { status: 200 })
        : new Response(new Uint8Array(makeTarball({ "archive/only.md": "x" })), { status: 200 })) as typeof fetch;
    try {
      await expect(loadCorpus()).rejects.toThrow(/no live notes/);
    } finally {
      globalThis.fetch = orig;
    }
  });
});

describe("verify", () => {
  const files = new Map([["projects/sample.md", "**The oven is cold** (checked 2025-02-17)."]]);

  it("verifies an exact quote", () => {
    expect(checkCitation(files, "abc123def456", "projects/sample.md", "checked 2025-02-17").verified).toBe(true);
  });

  it("verifies through markdown wrappers", () => {
    expect(verifyQuote("**The oven is cold**", "The oven is cold").verified).toBe(true);
  });

  it("rejects a fabricated quote", () => {
    const c = checkCitation(files, "abc", "projects/sample.md", "The sample oven is lit and fully working");
    expect(c.verified).toBe(false);
    expect(c.reason).toMatch(/NOT FOUND/);
  });

  it("rejects a quote made only of markdown wrappers", () => {
    // Regression: checking length on the RAW string let this clear the guard, normalise to
    // "", and match every file — proof of nothing reported as proof.
    expect(verifyQuote("anything at all", "**__**``>>##**__**").verified).toBe(false);
  });

  it("rejects a citation to a file outside the corpus", () => {
    expect(checkCitation(files, "abc", "notes/nope.md", "some sufficiently long quote").verified).toBe(false);
  });

  it("does not lowercase — case is part of an identifier", () => {
    // Case is part of an identifier; treating these as equal would hide a rename.
    expect(normalise("Weekly Totals")).not.toBe(normalise("Weekly totals"));
    expect(verifyQuote("the tab is named Weekly Totals today", "named Weekly totals today").verified).toBe(false);
  });

  it("pins the proof to a commit", () => {
    expect(checkCitation(files, "abcdef1234567890", "projects/sample.md", "checked 2025-02-17").commit)
      .toBe("abcdef123456");
  });
});

describe("narrow", () => {
  const files = new Map([
    ["projects/sample.md", "the sample oven is cold and the thermometer reads 18C"],
    ["projects/hotel.md", "hotel supabase import queue written to a dropped table"],
    ["notes/laptop.md", "the laptop swaps when the browser and the editor are both open"],
  ]);

  it("ranks by full text, not by filename", () => {
    expect(rank(files, "why is the deploy returning 404")[0].path).toBe("projects/sample.md");
  });

  it("drops zero-signal files rather than padding the shortlist", () => {
    // Counting zero-score entries as "retrieved" makes recall@k mean "the file exists".
    const r = rank(files, "supabase queue");
    expect(r.every((x) => x.score > 0)).toBe(true);
    expect(r.map((x) => x.path)).toContain("projects/hotel.md");
    expect(r.map((x) => x.path)).not.toContain("notes/laptop.md");
  });

  it("is deterministic across calls", () => {
    expect(rank(files, "sample deploy")).toEqual(rank(files, "sample deploy"));
  });

  it("falls back to the whole corpus when nothing matches", () => {
    expect(narrow(files, "zzzz qqqq").sort()).toEqual([...files.keys()].sort());
  });

  it("caps the pack at k", () => {
    expect(narrow(files, "the", 2).length).toBeLessThanOrEqual(2);
  });

  it("tokenizes away punctuation but keeps single chars", () => {
    // Single chars are kept on purpose. Dropping them made "is R installed" unanswerable —
    // `r` was the only distinguishing term. Noise is handled by IDF instead: `a` occurs in
    // every note so it scores ~0, while a rare `r` scores high.
    expect(tokenize("Sample's deploy.yml -- a 404!")).toEqual(["sample", "s", "deploy", "yml", "a", "404"]);
  });

  it("folds names that are mostly punctuation into spellable tokens", () => {
    // Stripping non-alphanumerics turned C# into "c" and .NET into "net", so these questions
    // ranked on a bare letter. Folded on both sides, so question and document still meet.
    expect(tokenize("C# and C++ and .NET")).toEqual(["csharp", "and", "cplusplus", "and", "dotnet"]);
  });
});

describe("a symlinked retired map snapshot is ignored", () => {
  function linkEntry(name: string): Buffer {
    const header = Buffer.alloc(512);
    header.write(name, 0, 100, "utf8");
    header.write("0".repeat(11) + "\0", 124, 12, "ascii");
    header.write("2", 156, 1, "ascii"); // symlink
    return seal(header);
  }
  function fileEntry(name: string, body: string): Buffer {
    const header = Buffer.alloc(512);
    header.write(name, 0, 100, "utf8");
    header.write(Buffer.byteLength(body).toString(8).padStart(11, "0") + "\0", 124, 12, "ascii");
    header.write("0", 156, 1, "ascii");
    const data = Buffer.from(body, "utf8");
    const pad = Buffer.alloc(Math.ceil(data.length / 512) * 512 - data.length);
    return Buffer.concat([seal(header), data, pad]);
  }

  it("skips the link and still serves the notes", () => {
    const buf = Buffer.concat([
      fileEntry("repo-x/notes/a.md", "# a\n\nBody.\n"),
      linkEntry("repo-x/tools/atlas-snapshot.json"),
      Buffer.alloc(1024),
    ]);
    // The retired snapshot is outside the live-note predicate, so it is never materialised.
    const out = untar(buf, isLive);
    expect(out.map(([p]) => p)).toEqual(["notes/a.md"]);
  });

  it("still throws for a symlinked note — that protection is untouched", () => {
    const buf = Buffer.concat([linkEntry("repo-x/notes/evil.md"), Buffer.alloc(1024)]);
    expect(() => untar(buf, isLive)).toThrow(/link, not a file/);
  });
});
