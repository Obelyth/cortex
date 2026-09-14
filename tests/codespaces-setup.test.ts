import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";

function config() {
  const file = ".devcontainer/devcontainer.json";
  expect(existsSync(file), "A bounded development container must be configured").toBe(true);
  return JSON.parse(readFileSync(file, "utf8"));
}

it("keeps container creation limited to an unprivileged Node development workspace", () => {
  const container = config();
  const version = /^node:(\d+)\.(\d+)\.(\d+)-bookworm$/.exec(container.image);
  expect(version, "Use an explicit official Node release").not.toBeNull();
  expect(Number(version![1])).toBe(22);
  expect(Number(version![2])).toBeGreaterThanOrEqual(18);
  expect(container.containerUser).toBe("node");
  expect(container.remoteUser).toBe("node");

  // Additional hooks, mounts, environment imports, provider permissions and
  // privileged features expand the authority of opening this repository.
  const boundedProperties = new Set([
    "name", "image", "containerUser", "remoteUser", "forwardPorts",
    "portsAttributes", "otherPortsAttributes", "postCreateCommand",
  ]);
  expect(Object.keys(container).filter((key) => !boundedProperties.has(key))).toEqual([]);
  expect(container.postCreateCommand).toEqual(["npm", "ci", "--ignore-scripts"]);
});

it("forwards only the development port without publishing or starting an app", () => {
  const container = config();
  expect(container.forwardPorts).toEqual([3000]);
  expect(Object.keys(container.portsAttributes)).toEqual(["3000"]);
  expect(container.portsAttributes["3000"].onAutoForward).toBe("notify");
  expect(container.otherPortsAttributes).toEqual({ onAutoForward: "ignore" });
  expect(container.postStartCommand).toBeUndefined();
  expect(container.postAttachCommand).toBeUndefined();
});

it("installs from the lockfile without running lifecycle scripts or creating runtime configuration", () => {
  const [command, ...args] = config().postCreateCommand;
  const scratch = mkdtempSync(join(tmpdir(), "cortex-codespaces-install-"));
  try {
    const pkg = {
      name: "codespaces-install-canary", version: "1.0.0",
      scripts: Object.fromEntries([
        "preinstall", "install", "postinstall", "prepare", "dev", "start", "onboard",
      ].map((name) => [name, "node canary.cjs"])),
    };
    const lock = JSON.stringify({
      name: pkg.name, version: pkg.version, lockfileVersion: 3, requires: true,
      packages: { "": { name: pkg.name, version: pkg.version, hasInstallScript: true } },
    });
    writeFileSync(join(scratch, "package.json"), JSON.stringify(pkg));
    writeFileSync(join(scratch, "package-lock.json"), lock);
    writeFileSync(join(scratch, "canary.cjs"), 'require("node:fs").writeFileSync("lifecycle-ran", "unexpected");');
    const installed = spawnSync(command, args, {
      cwd: scratch, encoding: "utf8", timeout: 15_000,
      env: {
        PATH: process.env.PATH, HOME: scratch, NODE_ENV: "test",
        npm_config_cache: join(scratch, "cache"), npm_config_offline: "true",
        npm_config_audit: "false", npm_config_fund: "false",
      },
    });
    expect(installed.status, installed.stderr).toBe(0);
    expect(existsSync(join(scratch, "lifecycle-ran"))).toBe(false);
    expect(existsSync(join(scratch, ".env.local"))).toBe(false);
    expect(readFileSync(join(scratch, "package-lock.json"), "utf8")).toBe(lock);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});
