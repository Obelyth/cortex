import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const script = fileURLToPath(new URL("../scripts/release-header.mjs", import.meta.url));
const sha = "0123456789abcdef0123456789abcdef01234567";

function render(repository: string | undefined, commit: string | undefined) {
  return spawnSync(process.execPath, [script], {
    env: { NODE_ENV: "test", GITHUB_REPOSITORY: repository, CORTEX_RELEASE_COMMIT: commit },
    encoding: "utf8",
  });
}

describe("published release documentation", () => {
  it.each(["Obelyth/cortex", "example-owner/my-cortex"])("pins setup and database links to the packaged commit in %s", (repository) => {
    const result = render(repository, sha);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain(`https://github.com/${repository}/blob/${sha}/README.md`);
    expect(result.stdout).toContain(`https://github.com/${repository}/blob/${sha}/docs/database-bootstrap.md`);
    expect(result.stdout).not.toContain("/blob/main/");
    expect(result.stdout).not.toContain("{{RELEASE_SOURCE}}");
  });

  it.each([
    [undefined, sha],
    ["example-owner/my-cortex", undefined],
    ["example-owner/my-cortex", "main"],
    ["example-owner/my-cortex", `${sha}\n`],
    ["example-owner/repo/extra", sha],
    ["example-owner/repo\n", sha],
    ["example-owner/repo?credential=synthetic", sha],
  ])("refuses incomplete or unsafe release identity", (repository, commit) => {
    const result = render(repository, commit);
    expect(result.status).not.toBe(0);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe("Release documentation requires a valid repository and commit SHA.\n");
  });
});
