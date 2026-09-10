import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

// Imported dynamically because this is also a dependency-free Node CLI module.
const helperPath = "../scripts/onboard-helpers.mjs";
const helpers = await import(helperPath);
const repo = { full_name: "example/brain", private: true, archived: false, default_branch: "notes" };
const deployment = {
  id: "dpl_fresh", projectId: "prj_fresh", target: "production", readyState: "READY",
  url: "fresh-unique.vercel.app", alias: ["actual-production.vercel.app"],
};

describe("onboarding trust boundaries", () => {
  it("names a missing Git commit identity before creating a remote brain", () => {
    const directory = mkdtempSync(join(tmpdir(), "cortex-author-test-"));
    const env = { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_AUTHOR_NAME: "", GIT_AUTHOR_EMAIL: "", GIT_COMMITTER_NAME: "", GIT_COMMITTER_EMAIL: "" };
    try {
      execFileSync("git", ["init", "-q", "-b", "main"], { cwd: directory, env });
      const runGit = (args: string[]) => execFileSync("git", args, { cwd: directory, env, stdio: "pipe" });
      expect(helpers.requireGitCommitIdentity).toBeTypeOf("function");
      expect(() => helpers.requireGitCommitIdentity(runGit)).toThrow(/Configure a Git author name and email/);
      expect(() => helpers.requireGitCommitIdentity(runGit)).toThrow(/No remote brain repository was created/);
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });

  it("accepts an explicitly configured Git identity without changing configuration", () => {
    const directory = mkdtempSync(join(tmpdir(), "cortex-author-test-"));
    const env = { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_AUTHOR_NAME: "Synthetic Operator", GIT_AUTHOR_EMAIL: "operator@example.invalid",
      GIT_COMMITTER_NAME: "Synthetic Operator", GIT_COMMITTER_EMAIL: "operator@example.invalid" };
    try {
      execFileSync("git", ["init", "-q", "-b", "main"], { cwd: directory, env });
      const runGit = (args: string[]) => execFileSync("git", args, { cwd: directory, env, stdio: "pipe" });
      expect(helpers.requireGitCommitIdentity).toBeTypeOf("function");
      expect(() => helpers.requireGitCommitIdentity(runGit)).not.toThrow();
      expect(execFileSync("git", ["config", "--local", "--list"], { cwd: directory, env, encoding: "utf8" })).not.toMatch(/user\.(name|email)/);
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });

  it("uses the verified private repository's default branch, not a main fallback", () => {
    expect(helpers.brainRepository).toBeTypeOf("function");
    expect(helpers.brainRepository(repo, "example/brain")).toEqual({ repo: "example/brain", branch: "notes" });
  });

  it.each([
    { ...repo, private: false }, { ...repo, archived: true },
    { ...repo, default_branch: "" }, { ...repo, full_name: "other/brain" },
    { ...repo, private: undefined },
  ])("rejects an unsafe or unverified repository: %j", (value) => {
    expect(helpers.brainRepository).toBeTypeOf("function");
    expect(() => helpers.brainRepository(value, "example/brain")).toThrow();
  });

  it("uses only an API-returned alias and verifies that alias resolves to this deployment", async () => {
    expect(helpers.resolveProductionOrigin).toBeTypeOf("function");
    const read = vi.fn().mockResolvedValue(deployment);
    await expect(helpers.resolveProductionOrigin("https://fresh-unique.vercel.app", "prj_fresh", read))
      .resolves.toBe("https://actual-production.vercel.app");
    expect(read.mock.calls).toEqual([["fresh-unique.vercel.app"], ["actual-production.vercel.app"]]);
  });

  it.each([
    { ...deployment, projectId: "prj_other" }, { ...deployment, target: "preview" },
    { ...deployment, readyState: "ERROR" }, { ...deployment, url: "different.vercel.app" },
    { ...deployment, alias: [] }, { ...deployment, alias: ["https://evil.test/path"] },
  ])("rejects deployment metadata that cannot establish a production host: %j", async (value) => {
    expect(helpers.resolveProductionOrigin).toBeTypeOf("function");
    await expect(helpers.resolveProductionOrigin("https://fresh-unique.vercel.app", "prj_fresh", vi.fn().mockResolvedValue(value)))
      .rejects.toThrow();
  });

  it("refuses an alias reassigned after the deployment was inspected", async () => {
    expect(helpers.resolveProductionOrigin).toBeTypeOf("function");
    const read = vi.fn().mockResolvedValueOnce(deployment).mockResolvedValueOnce({ ...deployment, id: "dpl_other" });
    await expect(helpers.resolveProductionOrigin("https://fresh-unique.vercel.app", "prj_fresh", read)).rejects.toThrow();
  });

  it("does not send a connector secret if provider verification fails", async () => {
    expect(helpers.checkDeployment).toBeTypeOf("function");
    const fetcher = vi.fn();
    await expect(helpers.checkDeployment({
      deploymentUrl: "https://fresh-unique.vercel.app", projectId: "prj_fresh", secret: "test-secret",
      readDeployment: vi.fn().mockResolvedValue({ ...deployment, projectId: "prj_other" }), fetcher,
    })).rejects.toThrow();
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("checks the tool roster without following a redirect or calling a paid model", async () => {
    expect(helpers.checkDeployment).toBeTypeOf("function");
    const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      jsonrpc: "2.0", id: 1, result: { tools: [{ name: "brain_read" }, { name: "brain_context" }] },
    })));
    await expect(helpers.checkDeployment({
      deploymentUrl: "https://fresh-unique.vercel.app", projectId: "prj_fresh", secret: "test-secret",
      readDeployment: vi.fn().mockResolvedValue(deployment), fetcher,
    })).resolves.toEqual({ origin: "https://actual-production.vercel.app", tools: ["brain_context", "brain_read"] });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, options] = fetcher.mock.calls[0];
    expect(url).toBe("https://actual-production.vercel.app/api/s/test-secret/mcp");
    expect(options.redirect).toBe("error");
    expect(JSON.parse(options.body).method).toBe("tools/list");
  });

  it("supports the update helper's bearer-only installations without exposing tokens in a URL", async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response(
      'event: message\r\ndata: {"jsonrpc":"2.0","id":1,"result":{"tools":[{"name":"brain_read"}]}}\r\n\r\n',
      { headers: { "content-type": "text/event-stream" } },
    ));
    await expect(helpers.checkDeployment({
      deploymentUrl: "https://fresh-unique.vercel.app", projectId: "prj_fresh", token: "test-bearer",
      readDeployment: vi.fn().mockResolvedValue(deployment), fetcher,
    })).resolves.toEqual({ origin: "https://actual-production.vercel.app", tools: ["brain_read"] });
    expect(fetcher.mock.calls[0][0]).toBe("https://actual-production.vercel.app/api/mcp");
    expect(fetcher.mock.calls[0][1].headers.Authorization).toBe("Bearer test-bearer");
    expect(fetcher.mock.calls[0][1].redirect).toBe("error");
  });

  it("scopes provider lookup to team accounts without treating a personal user ID as a team", () => {
    expect(helpers.deploymentLookupPath).toBeTypeOf("function");
    expect(helpers.deploymentLookupPath("fresh-unique.vercel.app", "team_fresh"))
      .toBe("/v13/deployments/fresh-unique.vercel.app?teamId=team_fresh");
    expect(helpers.deploymentLookupPath("fresh-unique.vercel.app", "user_fresh"))
      .toBe("/v13/deployments/fresh-unique.vercel.app");
  });

  it("does not start an interactive setup in a pipe or CI process", () => {
    try {
      execFileSync(process.execPath, ["scripts/onboard.mjs"], { encoding: "utf8", stdio: "pipe" });
      throw new Error("Expected onboarding to refuse non-interactive input");
    } catch (error) {
      expect((error as { status: number }).status).toBe(1);
      expect(String((error as { stderr: unknown }).stderr)).toContain("Nothing was changed");
    }
  });
});
