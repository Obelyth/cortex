import { beforeEach, describe, expect, it, vi } from "vitest";
import { getFile, putFile, listTree, compareCommits } from "../lib/github";
import { isLive, isSidecar } from "../lib/corpus";

const b64 = (s: string) => Buffer.from(s, "utf8").toString("base64");

function mockFetchOnce(status: number, body: unknown) {
  (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
    new Response(JSON.stringify(body), { status })
  );
}

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn());
  vi.stubEnv("GITHUB_TOKEN", "test-pat");
  vi.stubEnv("BRAIN_REPO", "ShootJackal/brain");
  vi.stubEnv("BRAIN_BRANCH", "main");
});

describe("getFile", () => {
  it("decodes base64 content and returns sha", async () => {
    mockFetchOnce(200, { content: b64("hello"), sha: "abc123", encoding: "base64" });
    const f = await getFile("profile.md");
    expect(f).toEqual({ path: "profile.md", content: "hello", sha: "abc123" });
    const [url, init] = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toBe(
      "https://api.github.com/repos/ShootJackal/brain/contents/profile.md?ref=main"
    );
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer test-pat");
  });

  it("returns null on 404", async () => {
    mockFetchOnce(404, { message: "Not Found" });
    expect(await getFile("nope.md")).toBeNull();
  });

  it("throws on other errors", async () => {
    mockFetchOnce(500, { message: "boom" });
    await expect(getFile("x.md")).rejects.toThrow(/getFile x.md: 500/);
  });

  it("throws loudly on non-base64 encoding instead of silently returning an empty file (blob >1MB)", async () => {
    mockFetchOnce(200, { content: "", sha: "big123", encoding: "none" });
    await expect(getFile("archive/huge.md")).rejects.toThrow(/unsupported encoding "none"/);
  });
});

describe("putFile", () => {
  it("creates without sha, updates with sha, returns commit sha", async () => {
    mockFetchOnce(201, { commit: { sha: "c1" } });
    expect(await putFile("notes/a.md", "body", "msg")).toEqual({ commitSha: "c1", content: "body" });
    const body = JSON.parse(
      (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0][1].body as string
    );
    expect(body).toMatchObject({ message: "msg", content: b64("body"), branch: "main" });
    expect(body.sha).toBeUndefined();
  });

  it("retries once with fresh sha on 409 conflict, replaying original content when no merge is given", async () => {
    mockFetchOnce(409, { message: "conflict" });               // first PUT
    mockFetchOnce(200, { content: b64("old"), sha: "fresh", encoding: "base64" }); // getFile refetch
    mockFetchOnce(200, { commit: { sha: "c2" } });             // retry PUT
    expect(await putFile("notes/a.md", "body", "msg", "stale")).toEqual({ commitSha: "c2", content: "body" });
    const retryBody = JSON.parse(
      (global.fetch as ReturnType<typeof vi.fn>).mock.calls[2][1].body as string
    );
    expect(retryBody.sha).toBe("fresh");
    expect(retryBody.content).toBe(b64("body"));
  });

  it("fails loudly if retry also fails", async () => {
    mockFetchOnce(409, { message: "conflict" });
    mockFetchOnce(200, { content: b64("old"), sha: "fresh", encoding: "base64" });
    mockFetchOnce(422, { message: "still bad" });
    await expect(putFile("notes/a.md", "b", "m", "stale")).rejects.toThrow(/putFile notes\/a.md: 422/);
  });

  // Both review bots found this independently. The rich index is written with NO
  // sha the first time it exists; if two first-time writes race, the loser took a
  // sha-less 422, skipped the re-derive, and the note it was adding was simply
  // absent from the catalogue — a successful write, permanently unrecallable.
  it("DOES retry a sha-less 422 when a merge callback can rebuild the content", async () => {
    mockFetchOnce(422, { message: "already exists" });               // lost the create race
    mockFetchOnce(200, { content: b64("winner"), sha: "s1", encoding: "base64" }); // getFile
    mockFetchOnce(200, { commit: { sha: "c9" } });                    // retry PUT
    const merge = vi.fn((fresh) => `${fresh?.content ?? ""}+mine`);
    const res = await putFile("notes/idx.md", "mine", "m", undefined, merge);
    expect(res.commitSha).toBe("c9");
    // It must rebuild FROM what actually won, not replay its own stale snapshot.
    expect(merge).toHaveBeenCalledWith(expect.objectContaining({ content: "winner" }));
    const retryBody = JSON.parse(
      (global.fetch as ReturnType<typeof vi.fn>).mock.calls[2][1].body as string
    );
    expect(Buffer.from(retryBody.content, "base64").toString("utf8")).toBe("winner+mine");
    expect(retryBody.sha).toBe("s1");
  });

  it("does NOT retry a sha-less 422 with no merge callback (create must never overwrite)", async () => {
    mockFetchOnce(422, { message: "already exists" });
    await expect(putFile("notes/a.md", "body", "msg")).rejects.toThrow(/422/);
    expect((global.fetch as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(1);
  });

  it("on 409 with sha + merge callback, retries with merge(fresh) and passes the refetched file to merge", async () => {
    mockFetchOnce(409, { message: "conflict" });                    // first PUT
    mockFetchOnce(200, { content: b64("concurrent"), sha: "fresh", encoding: "base64" }); // getFile refetch
    mockFetchOnce(200, { commit: { sha: "c3" } });                  // retry PUT
    const merge = vi.fn((fresh) => `${fresh?.content}+mine`);
    expect(await putFile("notes/a.md", "mine", "msg", "stale", merge)).toEqual({
      commitSha: "c3",
      // The committed bytes, not the argument: on a retry the mirror write-through must
      // receive what merge(fresh) produced, or it mirrors stale content under a fresh SHA.
      content: "concurrent+mine",
    });
    expect(merge).toHaveBeenCalledWith({ path: "notes/a.md", content: "concurrent", sha: "fresh" });
    const retryBody = JSON.parse(
      (global.fetch as ReturnType<typeof vi.fn>).mock.calls[2][1].body as string
    );
    expect(retryBody.content).toBe(b64("concurrent+mine"));
    expect(retryBody.sha).toBe("fresh");
  });

  it("on 409 with sha and no merge callback, replays the original content (replace semantics)", async () => {
    mockFetchOnce(409, { message: "conflict" });
    mockFetchOnce(200, { content: b64("concurrent"), sha: "fresh", encoding: "base64" });
    mockFetchOnce(200, { commit: { sha: "c4" } });
    await putFile("notes/a.md", "mine", "msg", "stale");
    const retryBody = JSON.parse(
      (global.fetch as ReturnType<typeof vi.fn>).mock.calls[2][1].body as string
    );
    expect(retryBody.content).toBe(b64("mine"));
  });
});

describe("listTree", () => {
  it("returns only .md blob paths", async () => {
    mockFetchOnce(200, {
      tree: [
        { path: "profile.md", type: "blob" },
        { path: "projects", type: "tree" },
        { path: "projects/harbor.md", type: "blob" },
        { path: "log/.gitkeep", type: "blob" },
      ],
    });
    expect(await listTree()).toEqual(["profile.md", "projects/harbor.md"]);
  });
});

describe("compareCommits", () => {
  it("returns changed and removed paths for an ordinary diff", async () => {
    mockFetchOnce(200, {
      status: "ahead",
      files: [
        { filename: "notes/a.md", status: "modified" },
        { filename: "notes/new.md", status: "added" },
        { filename: "notes/gone.md", status: "removed" },
        { filename: "notes/moved.md", status: "renamed", previous_filename: "notes/old-name.md" },
      ],
    });
    const d = await compareCommits("aaa", "bbb");
    expect(d).toEqual({
      changed: ["notes/a.md", "notes/new.md", "notes/moved.md"],
      removed: ["notes/gone.md", "notes/old-name.md"],
      complete: true,
      ahead: true,
    });
    const [url] = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toContain("/compare/aaa...bbb");
  });

  // The compare API silently caps its file list at 300. A reconciler that trusted a capped list
  // would sync part of a big diff and record the head as fully absorbed — silent loss, again.
  it("reports an over-large diff as incomplete instead of pretending", async () => {
    mockFetchOnce(200, {
      status: "ahead",
      files: Array.from({ length: 300 }, (_, i) => ({ filename: `notes/n${i}.md`, status: "modified" })),
    });
    const d = await compareCommits("aaa", "bbb");
    expect(d.complete).toBe(false);
  });

  // Divergent histories (force-push over the brain) 404 — the caller must full-sync, not patch.
  it("throws on a compare the API refuses", async () => {
    mockFetchOnce(404, { message: "Not Found" });
    await expect(compareCommits("aaa", "bbb")).rejects.toThrow(/compare/);
  });

  // The keep predicate is passed in rather than baked in, so the ONE definition of "the live
  // corpus" stays in corpus.ts — a second definition here is exactly the dual-implementation
  // drift this repo exists to delete.
  it("filters through the caller's keep predicate", async () => {
    mockFetchOnce(200, {
      status: "ahead",
      files: [
        { filename: "tools/atlas-snapshot.json", status: "modified" },
        { filename: ".github/workflows/x.yml", status: "modified" },
        { filename: "notes/real.md", status: "removed" },
      ],
    });
    const d = await compareCommits("aaa", "bbb", (p) => isLive(p) || isSidecar(p));
    expect(d.changed).toEqual(["tools/atlas-snapshot.json"]);
    expect(d.removed).toEqual(["notes/real.md"]);
  });

  /**
   * Verified against the live API: a force-push shows up as status "behind" (empty file list) or
   * "diverged" (a MERGE-BASE diff that omits what the rewrite dropped) — both HTTP 200. `ahead`
   * is the reconciler's licence to patch; anything else means rebuild.
   */
  it.each(["behind", "diverged", "identical"])('reports ahead=false for status "%s"', async (status) => {
    mockFetchOnce(200, { status, files: [] });
    const d = await compareCommits("aaa", "bbb");
    expect(d.ahead).toBe(false);
    expect(d.complete).toBe(true);
  });
});
