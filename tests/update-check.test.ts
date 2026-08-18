import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  compareVersions,
  parseReleaseTag,
  resetUpdateCache,
  updateStatus,
} from "../lib/update-check";
import pkg from "../package.json";

function mockFetchOnce(status: number, body: unknown) {
  (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
    new Response(JSON.stringify(body), { status })
  );
}

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn());
  resetUpdateCache();
});

describe("compareVersions", () => {
  it("orders numerically, not lexically", () => {
    expect(compareVersions("1.10.0", "1.9.0")).toBeGreaterThan(0);
    expect(compareVersions("2.0.0", "10.0.0")).toBeLessThan(0);
  });

  it("treats missing segments as zero and tolerates a v prefix", () => {
    expect(compareVersions("1.0", "1.0.0")).toBe(0);
    expect(compareVersions("v1.2.3", "1.2.3")).toBe(0);
    expect(compareVersions("1.0.1", "1.0")).toBeGreaterThan(0);
  });
});

describe("parseReleaseTag", () => {
  it("accepts exactly the shape the release runbook cuts", () => {
    expect(parseReleaseTag("v1.2.3")).toBe("1.2.3");
  });

  it("rejects everything else — prereleases, bare versions, non-strings", () => {
    expect(parseReleaseTag("v1.2.3-rc.1")).toBeNull();
    expect(parseReleaseTag("1.2.3")).toBeNull();
    expect(parseReleaseTag("latest")).toBeNull();
    expect(parseReleaseTag(undefined)).toBeNull();
    expect(parseReleaseTag(123)).toBeNull();
  });
});

describe("updateStatus", () => {
  it("reports behind when the published release is newer", async () => {
    mockFetchOnce(200, { tag_name: "v9.9.9" });
    expect(await updateStatus()).toEqual({ running: pkg.version, latest: "9.9.9", behind: true });
  });

  it("is not behind when the release matches the running version", async () => {
    mockFetchOnce(200, { tag_name: `v${pkg.version}` });
    expect((await updateStatus()).behind).toBe(false);
  });

  it("is not behind when the running version is ahead of the release", async () => {
    mockFetchOnce(200, { tag_name: "v0.0.1" });
    const s = await updateStatus();
    expect(s.latest).toBe("0.0.1");
    expect(s.behind).toBe(false);
  });

  it("answers absence, never a guess, on HTTP failure", async () => {
    mockFetchOnce(500, { message: "boom" });
    expect(await updateStatus()).toEqual({ running: pkg.version, latest: null, behind: false });
  });

  it("answers absence when fetch itself throws", async () => {
    (global.fetch as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error("offline"));
    expect((await updateStatus()).latest).toBeNull();
  });

  it("answers absence on a tag it cannot vouch for", async () => {
    mockFetchOnce(200, { tag_name: "v2.0.0-beta.1" });
    expect((await updateStatus()).latest).toBeNull();
  });

  it("never sends credentials — the brain PAT is scoped to the brain repo only", async () => {
    vi.stubEnv("GITHUB_TOKEN", "test-pat");
    mockFetchOnce(200, { tag_name: "v9.9.9" });
    await updateStatus();
    const [, init] = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(JSON.stringify(init.headers)).not.toContain("test-pat");
    expect((init.headers as Record<string, string>).Authorization).toBeUndefined();
  });

  it("probes once per TTL, not once per render", async () => {
    mockFetchOnce(200, { tag_name: "v9.9.9" });
    await updateStatus();
    const again = await updateStatus();
    expect(global.fetch).toHaveBeenCalledTimes(1);
    expect(again.behind).toBe(true);
  });

  it("caches a failed probe too, instead of hammering a down endpoint", async () => {
    mockFetchOnce(503, {});
    await updateStatus();
    await updateStatus();
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });
});
