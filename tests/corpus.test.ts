import { describe, expect, it, beforeEach } from "vitest";
import zlib from "node:zlib";
import { untar, isLive, isSidecar, loadCorpus, __setCache } from "../lib/corpus";
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
    // Reading only `name` dropped 49 entries of the real repo silently — 7 of them live
    // notes, which the reader would then have answered "not in brain" for.
    const deep = "memory-2026-07/dir1--project-project-with-an-extremely-long-archived-name.md";
    const header = Buffer.alloc(512);
    header.write(deep.split("/").pop()!, 0, 100, "utf8");            // name field
    header.write("0".padStart(11, "0") + "\0", 124, 12, "ascii");    // size 0
    header.write("0", 156, 1, "ascii");                              // regular file
    header.write(`brain-abc123/archive/${deep.split("/")[0]}`, 345, 155, "utf8"); // prefix
    const tar = Buffer.concat([seal(header), Buffer.alloc(1024)]);
    const got = untar(tar);
    expect(got).toHaveLength(1);
    expect(got[0][0]).toBe(`archive/memory-2026-07/${deep.split("/").pop()}`);
  });
});

describe("corpus/brain_ask parity", () => {
  it("excludes exactly the prefixes brain_ask.py excludes", () => {
    // Two definitions of "the live corpus" that disagree is the dual-implementation drift
    // this rebuild exists to delete. brain_ask.py SKIP_PREFIX must match this list; when
    // they diverged, cortex saw 70 files and brain_ask saw 77.
    const py = [".git/", "tools/", "archive/", "brain-v2/", ".github/"];
    for (const prefix of py) expect(isLive(`${prefix}whatever.md`)).toBe(false);
    for (const name of ["brain-index.md", "INDEX.md", "README.md"]) {
      expect(isLive(`notes/${name}`)).toBe(false);
      expect(isLive(name)).toBe(false);
    }
  });
});

describe("isLive", () => {
  it("keeps notes, projects, profile and logs", () => {
    for (const p of ["profile.md", "projects/aurora.md", "notes/x.md", "log/2026-07-28.md"]) {
      expect(isLive(p)).toBe(true);
    }
  });

  it("excludes archive, tooling and generated catalogues", () => {
    // archive is 45% of bytes and holds superseded claims; a reader given both can answer
    // from the dead one. The generated indexes are the thing this rebuild deletes.
    for (const p of ["archive/memory-2026-07/x.md", "tools/recall.py", "notes/brain-index.md", "INDEX.md", "README.md"]) {
      expect(isLive(p)).toBe(false);
    }
  });

  it("ignores non-markdown", () => {
    expect(isLive("tools/eval/labels.json")).toBe(false);
  });
});

describe("loadCorpus", () => {
  beforeEach(() => __setCache(null));

  it("fetches, unpacks, filters and caches on the commit sha", async () => {
    process.env.BRAIN_REPO = "acme/brain";
    process.env.GITHUB_TOKEN = "t";
    const tarball = makeTarball({
      "profile.md": "operator",
      "projects/aurora.md": "production is dark",
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
      expect([...c.files.keys()].sort()).toEqual(["profile.md", "projects/aurora.md"]);
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
    process.env.BRAIN_REPO = "acme/brain";
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
  const files = new Map([["projects/aurora.md", "**The rollout is still offline** (re-checked 2030-01-15)."]]);

  it("verifies an exact quote", () => {
    expect(checkCitation(files, "abc123def456", "projects/aurora.md", "re-checked 2030-01-15").verified).toBe(true);
  });

  it("verifies through markdown wrappers", () => {
    expect(verifyQuote("**The rollout is still offline**", "The rollout is still offline").verified).toBe(true);
  });

  it("rejects a fabricated quote", () => {
    const c = checkCitation(files, "abc", "projects/aurora.md", "Aurora shipped and is fully live");
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
    // `By Zone` vs `By zone` is the live the ops dashboard's bug; treating them as equal would hide it.
    expect(normalise("By Zone")).not.toBe(normalise("By zone"));
    expect(verifyQuote("the tab is named By Zone today", "named By zone today").verified).toBe(false);
  });

  it("pins the proof to a commit", () => {
    expect(checkCitation(files, "abcdef1234567890", "projects/aurora.md", "re-checked 2030-01-15").commit)
      .toBe("abcdef123456");
  });
});

describe("narrow", () => {
  const files = new Map([
    ["projects/aurora.md", "aurora production is dark and the vercel deploy returns 404"],
    ["projects/beacon.md", "beacon supabase assets backlog written to a dead database"],
    ["notes/mac.md", "the mac swaps when chrome and claude are both open"],
  ]);

  it("ranks by full text, not by filename", () => {
    expect(rank(files, "why is the deploy returning 404")[0].path).toBe("projects/aurora.md");
  });

  it("drops zero-signal files rather than padding the shortlist", () => {
    // Counting zero-score entries as "retrieved" makes recall@k mean "the file exists".
    const r = rank(files, "supabase plates");
    expect(r.every((x) => x.score > 0)).toBe(true);
    expect(r.map((x) => x.path)).toContain("projects/beacon.md");
    expect(r.map((x) => x.path)).not.toContain("notes/mac.md");
  });

  it("is deterministic across calls", () => {
    expect(rank(files, "aurora deploy")).toEqual(rank(files, "aurora deploy"));
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
    expect(tokenize("Aurora's deploy.yml -- a 404!")).toEqual(["aurora", "s", "deploy", "yml", "a", "404"]);
  });

  it("folds names that are mostly punctuation into spellable tokens", () => {
    // Stripping non-alphanumerics turned C# into "c" and .NET into "net", so these questions
    // ranked on a bare letter. Folded on both sides, so question and document still meet.
    expect(tokenize("C# and C++ and .NET")).toEqual(["csharp", "and", "cplusplus", "and", "dotnet"]);
  });
});

describe("isSidecar — the atlas snapshot rides the tarball but is not the corpus", () => {
  it("matches the one known sidecar and nothing else", () => {
    expect(isSidecar("tools/atlas-snapshot.json")).toBe(true);
    expect(isSidecar("notes/a.md")).toBe(false);
    expect(isSidecar("tools/other.json")).toBe(false);
  });

  it("is an exact-path test, so the traversal bypasses isLive has cannot reach it", () => {
    // isLive("./tools/foo.md") is a known bypass; the sidecar list must not inherit it.
    for (const p of [
      "./tools/atlas-snapshot.json",
      "notes/../tools/atlas-snapshot.json",
      "TOOLS/atlas-snapshot.json",
      "tools//atlas-snapshot.json",
    ]) {
      expect(isSidecar(p), p).toBe(false);
    }
  });

  it("is excluded from the corpus the reader is handed", () => {
    // Belt and braces: the sidecar path must also fail isLive, so neither route admits it.
    expect(isLive("tools/atlas-snapshot.json")).toBe(false);
  });
});

describe("a symlinked sidecar degrades instead of killing the brain", () => {
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
    // The sidecar's contract is "absence is a non-event"; a link at its path must not be fatal.
    const out = untar(buf, (p) => isLive(p) || isSidecar(p));
    expect(out.map(([p]) => p)).toEqual(["notes/a.md"]);
  });

  it("still throws for a symlinked note — that protection is untouched", () => {
    const buf = Buffer.concat([linkEntry("repo-x/notes/evil.md"), Buffer.alloc(1024)]);
    expect(() => untar(buf, isLive)).toThrow(/link, not a file/);
  });
});
