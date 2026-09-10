import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { expect, it } from "vitest";

it("CI installs dependencies without executing package lifecycle code", () => {
  const workflow = readFileSync(".github/workflows/ci.yml", "utf8");
  const installs = [...workflow.matchAll(/^\s+- run: npm (ci(?: [a-z-]+)*)\s*$/gm)];
  expect(installs.length).toBeGreaterThan(0);
  for (const [, command] of installs) {
    const scratch = mkdtempSync(join(tmpdir(), "cortex-ci-install-"));
    try {
      const pkg = { name: "synthetic-install-canary", version: "1.0.0", scripts: { postinstall: "node canary.cjs" } };
      writeFileSync(join(scratch, "package.json"), JSON.stringify(pkg));
      writeFileSync(join(scratch, "package-lock.json"), JSON.stringify({
        name: pkg.name, version: pkg.version, lockfileVersion: 3, requires: true,
        packages: { "": { name: pkg.name, version: pkg.version, hasInstallScript: true } },
      }));
      writeFileSync(join(scratch, "canary.cjs"), 'require("node:fs").writeFileSync("lifecycle-ran", "unexpected");');
      const installed = spawnSync("npm", [...command.split(" "), "--offline", "--no-audit", "--no-fund"], {
        cwd: scratch, encoding: "utf8",
        env: { PATH: process.env.PATH, HOME: scratch, NODE_ENV: "test", npm_config_cache: join(scratch, "cache") },
        timeout: 15_000,
      });
      expect(installed.status, installed.stderr).toBe(0);
      expect(existsSync(join(scratch, "lifecycle-ran")), `Unsafe workflow install: npm ${command}`).toBe(false);
    } finally { rmSync(scratch, { recursive: true, force: true }); }
  }
});
