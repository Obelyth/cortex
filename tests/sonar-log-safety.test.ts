import { afterEach, describe, expect, it, vi } from "vitest";
import { __setCache, loadCorpus } from "../lib/corpus";
import { compareCommits, getFile } from "../lib/github";
import { syncMirror, type MirrorStore, type SyncDeps } from "../lib/mirror";

const forged = `attacker-controlled\r\n[admin] accepted \u001b[31mghp_${"a".repeat(30)}`;

function captured(spy: ReturnType<typeof vi.spyOn>): string {
  return spy.mock.calls.flat().map(String).join(" ");
}

function storeThatLosesRace(): MirrorStore {
  return {
    snapshot: vi.fn(async () => ({ head: null, rows: [] })),
    head: vi.fn(async () => null),
    paths: vi.fn(async () => []),
    apply: vi.fn(async () => false),
    access: vi.fn(async () => undefined),
    scores: vi.fn(async () => null),
  };
}

function storeThatApplies(): MirrorStore {
  return { ...storeThatLosesRace(), apply: vi.fn(async () => true) };
}

function syncDeps(): SyncDeps {
  return {
    compare: vi.fn(async () => ({ changed: [], removed: [], complete: true, ahead: true })),
    commitDate: vi.fn(async () => null),
    fetchAt: vi.fn(async () => null),
    fullLoad: vi.fn(async () => new Map([["notes/a.md", "safe note"]])),
  };
}

afterEach(() => {
  __setCache(null);
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("operational logs reject forged fields", () => {
  it("does not copy a failed GitHub response body or path into the server log", async () => {
    const stderr = vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.stubEnv("GITHUB_TOKEN", "test-token");
    vi.stubEnv("BRAIN_REPO", "example-owner/brain");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ message: forged }), { status: 500 }))
    );

    await expect(getFile(`notes/${forged}.md`)).rejects.toThrow(/500/);

    const log = captured(stderr);
    expect(log).toContain("[github]");
    expect(log).not.toContain("attacker-controlled");
    expect(log).not.toMatch(/[\r\n\u001b]/);
    expect(log).not.toContain("ghp_");
  });

  it("falls back from a rejected GitHub compare without logging its consumed message", async () => {
    const stderr = vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.stubEnv("GITHUB_TOKEN", "test-token");
    vi.stubEnv("BRAIN_REPO", "example-owner/brain");
    vi.stubEnv("BRAIN_BRANCH", "main");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ message: forged }), { status: 500 }))
    );

    await syncMirror(storeThatApplies(), "old-head", "new-head", {
      ...syncDeps(),
      compare: compareCommits,
    });

    const log = captured(stderr);
    expect(log).toContain("[github] compare failed with HTTP 500");
    expect(log).toContain("[mirror] patch sync failed, falling back to full");
    expect(log).not.toContain("attacker-controlled");
    expect(log).not.toMatch(/[\r\n\u001b]/);
    expect(log).not.toContain("ghp_");
  });

  it("reports cached-corpus fallback without copying the cached ref or thrown error", async () => {
    const stderr = vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.stubEnv("GITHUB_TOKEN", "test-token");
    vi.stubEnv("BRAIN_REPO", "example-owner/brain");
    vi.stubEnv("SUPABASE_URL", "");
    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "");
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error(forged); }));
    const cached = {
      files: new Map([["notes/a.md", "safe note"]]),
      sha: `cached-${forged}`,
      bytes: 9,
      fetchedAt: 0,
    };
    __setCache(cached);

    await expect(loadCorpus()).resolves.toBe(cached);

    const log = captured(stderr);
    expect(log).toContain("head resolution failed");
    expect(log).toContain("serving cache");
    expect(log).not.toContain("attacker-controlled");
    expect(log).not.toMatch(/[\r\n\u001b]/);
    expect(log).not.toContain("ghp_");
  });

  it("reports a lost patch race without copying the requested commit", async () => {
    const stderr = vi.spyOn(console, "error").mockImplementation(() => undefined);

    await syncMirror(storeThatLosesRace(), "old-head", `aa\r\n\u001b[31m${forged}`, syncDeps());

    const log = captured(stderr);
    expect(log).toContain("patch");
    expect(log).toContain("lost the sync race");
    expect(log).not.toMatch(/[\r\n\u001b]/);
  });

  it("reports a lost full-sync race without copying the requested commit", async () => {
    const stderr = vi.spyOn(console, "error").mockImplementation(() => undefined);

    await syncMirror(storeThatLosesRace(), null, `aa\r\n\u001b[31m${forged}`, syncDeps());

    const log = captured(stderr);
    expect(log).toContain("full sync");
    expect(log).toContain("lost the sync race");
    expect(log).not.toMatch(/[\r\n\u001b]/);
  });
});
