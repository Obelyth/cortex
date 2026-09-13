import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const source = fileURLToPath(new URL("..", import.meta.url));
const scratch: string[] = [];
afterEach(() => { for (const directory of scratch.splice(0)) rmSync(directory, { recursive: true, force: true }); });

type Call = { command: string; args: string[]; cwd: string };
type Scenario = {
  os?: string; node?: string; npmNode?: string; npmVersion?: string; vercel?: string;
  missing?: string; broken?: string; ghAuthenticated?: boolean; vercelAuthenticated?: boolean;
  fail?: string; failureStatus?: number;
};

// The launcher and bootstrap run unchanged. Only command boundaries that can
// install packages, contact a provider, or depend on the host are replaced.
function runSetup(scenario: Scenario = {}, input = "y\ny\ny\n", direct = false) {
  const base = mkdtempSync(join(tmpdir(), "cortex-linux-test-"));
  scratch.push(base);
  const archive = join(base, "Extracted Cortex with spaces");
  const bin = join(base, "tools");
  const away = join(base, "Different working directory");
  const log = join(base, "calls.jsonl");
  mkdirSync(join(archive, "scripts"), { recursive: true });
  mkdirSync(bin);
  mkdirSync(away);
  for (const file of ["Cortex Setup.sh", "scripts/bootstrap-linux.sh"]) {
    if (existsSync(join(source, file))) copyFileSync(join(source, file), join(archive, file));
  }
  writeFileSync(join(archive, "package.json"), '{"name":"cortex"}');
  writeFileSync(join(archive, "package-lock.json"), '{}');
  writeFileSync(join(archive, "scripts/onboard.mjs"), '// The npm boundary is stubbed.');
  symlinkSync("/usr/bin/dirname", join(bin, "dirname"));
  const stub = `#!${process.execPath}
const fs = require('node:fs');
const { basename } = require('node:path');
const { spawnSync } = require('node:child_process');
const command = basename(process.argv[1]);
const args = process.argv.slice(2);
const settings = JSON.parse(process.env.LINUX_TEST_SCENARIO);
fs.appendFileSync(process.env.LINUX_TEST_LOG, JSON.stringify({ command, args, cwd: process.cwd() }) + '\\n');
const key = command + ' ' + args.join(' ');
if (settings.fail === key) process.exit(settings.failureStatus ?? 37);
if (settings.broken === command) process.exit(23);
if (command === 'uname' && args.join(' ') === '-s') console.log(settings.os ?? 'Linux');
else if (command === 'node' && ['--version', '-v'].includes(args[0])) console.log(settings.node ?? 'v22.18.0');
else if (command === 'node' && args[0] === '-e') {
  const result = spawnSync(${JSON.stringify(process.execPath)}, args, { stdio: 'inherit' });
  process.exit(result.status ?? 1);
}
else if (command === 'npm' && args.join(' ') === '--version') console.log(settings.npmVersion ?? '10.9.3');
else if (command === 'npm' && args.join(' ') === 'version --json') console.log(JSON.stringify({
  npm: settings.npmVersion ?? '10.9.3', node: settings.npmNode ?? (settings.node ?? 'v22.18.0').replace(/^v/, '')
}));
else if (command === 'git' && args.join(' ') === '--version') console.log('git version 2.50.0');
else if (command === 'gh' && args.join(' ') === '--version') console.log('gh version 2.70.0');
else if (command === 'vercel' && args.join(' ') === '--version') console.error('Vercel CLI ' + (settings.vercel ?? '50.5.1'));
else if (command === 'vercel' && args.join(' ') === 'api --help') console.log('Usage: vercel api <endpoint>');
else if (command === 'gh' && args.join(' ') === 'auth status') {
  process.exit(settings.ghAuthenticated === false && !fs.existsSync(process.env.LINUX_TEST_LOG + '.gh') ? 1 : 0);
}
else if (command === 'vercel' && args.join(' ') === 'whoami') {
  process.exit(settings.vercelAuthenticated === false && !fs.existsSync(process.env.LINUX_TEST_LOG + '.vercel') ? 1 : 0);
}
else if (command === 'gh' && args.join(' ') === 'auth login --hostname github.com --git-protocol https --web') {
  fs.writeFileSync(process.env.LINUX_TEST_LOG + '.gh', 'authenticated');
}
else if (command === 'vercel' && args.join(' ') === 'login') {
  fs.writeFileSync(process.env.LINUX_TEST_LOG + '.vercel', 'authenticated');
}
else if (command === 'npm' && ['ci --ignore-scripts', 'run onboard'].includes(args.join(' '))) {}
else { console.error('Unexpected external command: ' + key); process.exit(98); }
`;
  for (const command of ["uname", "node", "npm", "git", "gh", "vercel", "sudo", "curl", "apt", "dnf", "pacman", "brew"]) {
    if (scenario.missing === command) continue;
    writeFileSync(join(bin, command), stub, { mode: 0o755 });
  }
  const entry = join(archive, direct ? "scripts/bootstrap-linux.sh" : "Cortex Setup.sh");
  // Execute the launcher itself once it exists, checking the shipped mode too.
  const result = spawnSync(existsSync(entry) ? entry : "/bin/bash", existsSync(entry) ? [] : [entry], {
    cwd: away, input, encoding: "utf8", timeout: 5_000,
    env: { NODE_ENV: "test", PATH: bin, HOME: base, LINUX_TEST_SCENARIO: JSON.stringify(scenario), LINUX_TEST_LOG: log },
  });
  const calls: Call[] = existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line)) : [];
  return { ...result, output: result.stdout + result.stderr, calls, archive };
}

const interactions = (calls: Call[]) => calls.filter(({ command, args }) =>
  command === "npm" && ["ci", "run"].includes(args[0]) ||
  command === "gh" && args[0] !== "--version" ||
  command === "vercel" && !["--version", "api"].includes(args[0]) ||
  ["sudo", "curl", "apt", "dnf", "pacman", "brew"].includes(command),
).map(({ command, args }) => `${command} ${args.join(" ")}`);

describe("Linux hosted-setup entry point", () => {
  it("runs the existing wizard from its extracted archive even when launched elsewhere", () => {
    const result = runSetup();
    expect(result.error).toBeUndefined();
    expect(result.status, result.output).toBe(0);
    expect(interactions(result.calls)).toEqual(["npm ci --ignore-scripts", "gh auth status", "vercel whoami", "npm run onboard"]);
    expect(result.calls.filter(call => call.command === "npm").every(call => call.cwd === result.archive)).toBe(true);
  });

  it("resolves the source archive when the bootstrap script is invoked directly", () => {
    const result = runSetup({}, "y\ny\ny\n", true);
    expect(result.status, result.output).toBe(0);
    expect(result.calls.find(call => call.command === "npm" && call.args[0] === "run")?.cwd).toBe(result.archive);
  });

  it.each(["Darwin", "FreeBSD"])("refuses %s before running tools or provider checks", os => {
    const result = runSetup({ os });
    expect(result.status).not.toBe(0);
    expect(result.output).toContain("Linux");
    expect(result.output).toContain("README");
    expect(result.calls.map(call => call.command)).toEqual(["uname"]);
  });

  it.each(["v20.19.0", "v22.17.9", "v23.0.0", "v24.0.0", "v22.18.0-rc.1", "broken"])("rejects unsupported Node %s before installing or signing in", node => {
    const result = runSetup({ node });
    expect(result.status).not.toBe(0);
    expect(result.output).toContain("22.18.0");
    expect(result.output).toContain("README");
    expect(interactions(result.calls)).toEqual([]);
  });

  it.each(["v22.18.0", "v22.23.2"])("accepts supported Node %s with matching npm", node => {
    const result = runSetup({ node });
    expect(result.status, result.output).toBe(0);
    expect(interactions(result.calls).at(-1)).toBe("npm run onboard");
  });

  it.each(["node", "npm", "git", "gh", "vercel"])("reports missing %s with manual prerequisites and no side effects", missing => {
    const result = runSetup({ missing });
    expect(result.status).not.toBe(0);
    expect(result.output.toLowerCase()).toContain(missing);
    expect(result.output).toContain("https://github.com/Obelyth/cortex/blob/main/README.md");
    expect(interactions(result.calls)).toEqual([]);
  });

  it.each(["npm", "git", "gh", "vercel"])("rejects an unusable %s command before installing or signing in", broken => {
    const result = runSetup({ broken });
    expect(result.status).not.toBe(0);
    expect(result.output.toLowerCase()).toContain(broken);
    expect(interactions(result.calls)).toEqual([]);
  });

  it.each([{ npmNode: "20.19.0" }, { npmNode: "22.17.0" }, { npmVersion: "invalid" }])("rejects npm whose runtime or version is unusable: %j", scenario => {
    const result = runSetup(scenario);
    expect(result.status).not.toBe(0);
    expect(result.output).toContain("npm");
    expect(interactions(result.calls)).toEqual([]);
  });

  it.each(["49.9.9", "50.5.0", "50.5.1-canary", "invalid"])("rejects insufficient Vercel CLI %s before installing or signing in", vercel => {
    const result = runSetup({ vercel });
    expect(result.status).not.toBe(0);
    expect(result.output).toContain("50.5.1");
    expect(interactions(result.calls)).toEqual([]);
  });

  it("refuses Vercel without the api command before any install or sign-in", () => {
    const result = runSetup({ fail: "vercel api --help" });
    expect(result.status).not.toBe(0);
    expect(result.output).toContain("Vercel");
    expect(interactions(result.calls)).toEqual([]);
  });

  it.each(["", "n\n", "\n", "maybe\n"])("requires affirmative dependency-install consent (%j)", input => {
    const result = runSetup({}, input);
    expect(result.status).not.toBe(0);
    expect(interactions(result.calls)).toEqual([]);
    expect(result.output).toMatch(/stopped|declined|cancel/i);
  });

  it.each(["y\n", "y\nn\n"])("does not check provider accounts without consent (%j)", input => {
    const result = runSetup({}, input);
    expect(result.status).not.toBe(0);
    expect(interactions(result.calls)).toEqual(["npm ci --ignore-scripts"]);
  });

  it.each(["y\ny\n", "y\ny\nn\n"])("does not start the wizard without consent (%j)", input => {
    const result = runSetup({}, input);
    expect(result.status).not.toBe(0);
    expect(interactions(result.calls)).toEqual(["npm ci --ignore-scripts", "gh auth status", "vercel whoami"]);
  });

  it.each(["y\ny\n", "y\ny\nn\n"])("does not open GitHub login without consent (%j)", input => {
    const result = runSetup({ ghAuthenticated: false }, input);
    expect(result.status).not.toBe(0);
    expect(interactions(result.calls)).toEqual(["npm ci --ignore-scripts", "gh auth status"]);
  });

  it.each(["y\ny\n", "y\ny\nn\n"])("does not open Vercel login without consent (%j)", input => {
    const result = runSetup({ vercelAuthenticated: false }, input);
    expect(result.status).not.toBe(0);
    expect(interactions(result.calls)).toEqual(["npm ci --ignore-scripts", "gh auth status", "vercel whoami"]);
  });

  it("uses confirmed browser logins and then the same onboarding wizard", () => {
    const result = runSetup({ ghAuthenticated: false, vercelAuthenticated: false }, "yes\nyes\nyes\nyes\nyes\n");
    expect(result.status, result.output).toBe(0);
    expect(interactions(result.calls)).toEqual([
      "npm ci --ignore-scripts", "gh auth status", "gh auth login --hostname github.com --git-protocol https --web", "gh auth status",
      "vercel whoami", "vercel login", "vercel whoami", "npm run onboard",
    ]);
  });

  it.each([
    { fail: "npm ci --ignore-scripts", failureStatus: 37 },
    { fail: "gh auth login --hostname github.com --git-protocol https --web", failureStatus: 38, ghAuthenticated: false },
    { fail: "vercel login", failureStatus: 39, vercelAuthenticated: false },
    { fail: "npm run onboard", failureStatus: 40 },
  ])("preserves failing command status and stops after $fail", scenario => {
    const result = runSetup(scenario, "y\ny\ny\ny\ny\n");
    expect(result.status, result.output).toBe(scenario.failureStatus);
    expect(interactions(result.calls).at(-1)).toBe(scenario.fail);
    expect(result.output).toMatch(/stopped|failed|did not finish/i);
  });
});
