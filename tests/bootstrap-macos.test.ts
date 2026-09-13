import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, it } from "vitest";

const bootstrap = resolve("scripts/bootstrap-macos.sh");

type Options = {
  installed?: string;
  available?: string;
  answer?: string;
  installFails?: boolean;
  npmMissing?: boolean;
  npmBroken?: boolean;
  npmRuntimeMismatch?: boolean;
  unrelatedNpm?: boolean;
};

// Exercise the complete launcher in bash. Only external tools are replaced:
// Homebrew installs into this temporary fixture, providers cannot sign in,
// and npm records the runtime used instead of installing or onboarding.
function runBootstrap(options: Options = {}) {
  const scratch = mkdtempSync(join(tmpdir(), "cortex-macos-bootstrap-"));
  const existingBin = join(scratch, "existing", "bin");
  const formula = join(scratch, "node@22");
  const formulaBin = join(formula, "bin");
  const unrelatedBin = join(scratch, "unrelated", "bin");
  const log = join(scratch, "calls");
  const installState = join(scratch, "installed");
  const shellEnvironment = join(scratch, "shell-environment");
  for (const directory of [existingBin, formulaBin, unrelatedBin]) mkdirSync(directory, { recursive: true });
  writeFileSync(join(scratch, "package.json"), '{ "name": "cortex" }\n');
  writeFileSync(log, "");

  function executable(path: string, contents: string) {
    writeFileSync(path, contents, { mode: 0o755 });
  }

  function runtime(bin: string, version: string, needsInstall = false) {
    // Run the launcher's actual JavaScript version predicate with the fixture's
    // version, so the test does not duplicate the production comparison.
    executable(join(bin, "node"), `#!${process.execPath}
const fs = require("node:fs");
if (${needsInstall} && !fs.existsSync(${JSON.stringify(installState)})) process.exit(127);
Object.defineProperty(process.versions, "node", { value: ${JSON.stringify(version)} });
Object.defineProperty(process, "execPath", { value: ${JSON.stringify(join(bin, "node"))} });
const [flag, expression] = process.argv.slice(2);
process.argv = [process.execPath, ...process.argv.slice(4)];
if (flag === "-v" || flag === "--version") console.log("v" + process.versions.node);
else if (flag === "-p") console.log(eval(expression));
else if (flag === "-e") eval(expression);
else process.exit(98);
`);
    if (options.npmMissing) return;
    executable(join(bin, "npm"), `#!/bin/bash
printf 'npm %s node=%s %s\\n' "$0" "$(node -v)" "$*" >> "$FIXTURE_LOG"
${options.npmBroken ? "exit 1" : `if [[ "$*" == "version --json" ]]; then
  printf '%s\\n' '{"node":"${options.npmRuntimeMismatch ? "20.20.0" : version}","npm":"10.9.3"}'
fi`}
`);
  }

  runtime(existingBin, options.installed ?? "22.23.2");
  runtime(formulaBin, options.available ?? "22.23.2", true);
  executable(join(unrelatedBin, "npm"), `#!/bin/bash
printf 'unrelated npm %s\\n' "$*" >> "$FIXTURE_LOG"
exit 97
`);
  // Functions take precedence over any tools in standard Homebrew locations.
  // Every unexpected brew action or provider mutation fails without executing.
  writeFileSync(shellEnvironment, `
uname() { printf 'Darwin\\n'; }
brew() {
  printf 'brew %s\\n' "$*" >> "$FIXTURE_LOG"
  case "$*" in
    'install node@22')
      [[ "$FIXTURE_INSTALL_FAILS" == 0 ]] || return 1
      printf 'installed\\n' > "$FIXTURE_INSTALL_STATE"
      ;;
    '--prefix node@22') printf '%s\\n' "$FIXTURE_FORMULA" ;;
    *) return 96 ;;
  esac
}
gh() {
  printf 'gh %s\\n' "$*" >> "$FIXTURE_LOG"
  case "$*" in
    'auth status') return 0 ;;
    'api user --jq .login') printf 'fixture-user\\n' ;;
    *) return 95 ;;
  esac
}
vercel() {
  printf 'vercel %s\\n' "$*" >> "$FIXTURE_LOG"
  [[ "$*" == whoami ]] || return 94
  printf 'fixture-user\\n'
}
curl() { printf 'unexpected curl\\n' >> "$FIXTURE_LOG"; return 93; }
git() { printf 'unexpected git\\n' >> "$FIXTURE_LOG"; return 92; }
`);

  try {
    const result = spawnSync("/bin/bash", [bootstrap], {
      cwd: scratch,
      input: options.answer ?? "y\n",
      encoding: "utf8",
      timeout: 10_000,
      env: {
        NODE_ENV: "test",
        PATH: `${options.unrelatedNpm ? `${unrelatedBin}:` : ""}${existingBin}:${unrelatedBin}:/usr/bin:/bin`,
        BASH_ENV: shellEnvironment,
        FIXTURE_LOG: log,
        FIXTURE_FORMULA: formula,
        FIXTURE_INSTALL_STATE: installState,
        FIXTURE_INSTALL_FAILS: options.installFails ? "1" : "0",
      },
    });
    expect(result.error).toBeUndefined();
    return {
      status: result.status,
      output: result.stdout + result.stderr,
      calls: readFileSync(log, "utf8").trim().split("\n").filter(Boolean),
      installed: existsSync(installState),
      existingNpm: join(existingBin, "npm"),
      formulaNpm: join(formulaBin, "npm"),
    };
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

it.each(["22.18.0", "22.18.1", "22.23.2"])("hands off with supported Node %s and its npm without installing", installed => {
  const result = runBootstrap({ installed });
  expect(result.status, result.output).toBe(0);
  expect(result.calls.filter(call => call.startsWith("brew "))).toEqual([]);
  expect(result.calls).toContain(`npm ${result.existingNpm} node=v${installed} ci --ignore-scripts`);
  expect(result.calls.at(-1)).toBe(`npm ${result.existingNpm} node=v${installed} run onboard`);
});

it.each(["20.20.0", "22.17.9", "24.0.0", "22.18.0-rc.1"])("replaces unsupported Node %s only for this run using Homebrew node@22", installed => {
  const result = runBootstrap({ installed });
  expect(result.status, result.output).toBe(0);
  expect(result.installed).toBe(true);
  expect(result.calls.filter(call => call.startsWith("brew "))).toEqual(["brew install node@22", "brew --prefix node@22"]);
  expect(result.calls).toContain(`npm ${result.formulaNpm} node=v22.23.2 ci --ignore-scripts`);
  expect(result.calls.at(-1)).toBe(`npm ${result.formulaNpm} node=v22.23.2 run onboard`);
});

it.each(["n\n", "N\n", ""])("stops before installation or authentication when Node installation is declined (%j)", answer => {
  const result = runBootstrap({ installed: "20.20.0", answer });
  expect(result.status, result.output).toBe(1);
  expect(result.calls).toEqual([]);
  expect(result.installed).toBe(false);
});

it("stops before authentication when Homebrew installation fails", () => {
  const result = runBootstrap({ installed: "20.20.0", installFails: true });
  expect(result.status, result.output).toBe(1);
  expect(result.calls).toEqual(["brew install node@22"]);
});

it.each(["22.17.9", "24.0.0"])("fails closed when the installed formula still provides unsupported Node %s", available => {
  const result = runBootstrap({ installed: "20.20.0", available });
  expect(result.status, result.output).toBe(1);
  expect(result.calls).toEqual(["brew install node@22", "brew --prefix node@22"]);
});

it("uses the npm beside the selected Node even when another npm is earlier on PATH", () => {
  const result = runBootstrap({ unrelatedNpm: true });
  expect(result.status, result.output).toBe(0);
  expect(result.calls).toContain(`npm ${result.existingNpm} node=v22.23.2 ci --ignore-scripts`);
  expect(result.calls.some(call => call.startsWith("unrelated npm"))).toBe(false);
});

it.each([{ npmMissing: true }, { npmBroken: true }, { npmRuntimeMismatch: true }])("stops before authentication when the selected Node has no matching usable npm (%j)", options => {
  const result = runBootstrap(options);
  expect(result.status, result.output).toBe(1);
  expect(result.calls.some(call => /^(gh |vercel )/.test(call))).toBe(false);
  expect(result.calls.some(call => call.endsWith("ci --ignore-scripts"))).toBe(false);
});
