import { afterEach, describe, expect, it } from "vitest";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { delimiter, join, relative } from "node:path";

const require = createRequire(import.meta.url);
const terminalSafety = require("../scripts/safe-terminal.cjs") as {
  safeLogValue: (value: unknown) => string;
  safeJsonLogRecord?: (value: unknown) => string;
};
const { safeLogValue } = terminalSafety;
const { resolveTrustedExecutable } = require("../scripts/command-path.cjs") as {
  resolveTrustedExecutable: (name: string, searchPath?: string) => string;
};
const { readRepositoryJson } = require("../scripts/benchmark-support.cjs") as {
  readRepositoryJson: (repositoryRoot: string, requestedPath: string, maxBytes?: number) => unknown;
};
const scratch: string[] = [];

function tempDirectory(label: string): string {
  const directory = mkdtempSync(join(process.cwd(), `.script-safety-${label}-`));
  scratch.push(directory);
  return directory;
}

function executable(path: string): void {
  writeFileSync(path, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
}

afterEach(() => {
  for (const directory of scratch.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("trusted CLI resolution", () => {
  it("returns the canonical target of an exact executable symlink in a trusted PATH", () => {
    const root = tempDirectory("trusted");
    const targetDirectory = join(root, "target");
    const bin = join(root, "bin");
    mkdirSync(targetDirectory);
    mkdirSync(bin);
    const target = join(targetDirectory, "git-real");
    executable(target);
    symlinkSync(target, join(bin, "git"));

    expect(resolveTrustedExecutable("git", bin)).toBe(target);
  });

  it("rejects relative PATH entries and missing or unsupported command names", () => {
    expect(() => resolveTrustedExecutable("git", "relative-bin")).toThrow(/absolute PATH/);
    expect(() => resolveTrustedExecutable("gh", tempDirectory("missing"))).toThrow(/not found/);
    expect(() => resolveTrustedExecutable("", tempDirectory("empty"))).toThrow(/supported/);
  });

  it("rejects a symlinked PATH directory whose original container is writable by others", () => {
    const root = tempDirectory("container");
    const trusted = join(root, "trusted");
    const unsafe = join(root, "unsafe");
    mkdirSync(trusted);
    mkdirSync(unsafe);
    executable(join(trusted, "git"));
    symlinkSync(trusted, join(unsafe, "bin"));
    chmodSync(unsafe, 0o777);

    expect(() => resolveTrustedExecutable("git", join(unsafe, "bin"))).toThrow(/trusted PATH/);
  });

  it("fails closed when an unsafe candidate appears before a trusted one", () => {
    const root = tempDirectory("order");
    const unsafe = join(root, "unsafe");
    const trusted = join(root, "trusted");
    mkdirSync(unsafe);
    mkdirSync(trusted);
    executable(join(unsafe, "git"));
    executable(join(trusted, "git"));
    chmodSync(unsafe, 0o777);

    expect(() => resolveTrustedExecutable("git", `${unsafe}${delimiter}${trusted}`)).toThrow(/trusted PATH/);
  });

  it("rejects a symlink whose canonical executable target is writable through an unsafe directory", () => {
    const root = tempDirectory("target");
    const bin = join(root, "bin");
    const unsafe = join(root, "unsafe-target");
    mkdirSync(bin);
    mkdirSync(unsafe);
    executable(join(unsafe, "git-real"));
    symlinkSync(join(unsafe, "git-real"), join(bin, "git"));
    chmodSync(unsafe, 0o777);

    expect(() => resolveTrustedExecutable("git", bin)).toThrow(/trusted PATH/);
  });
});

describe("benchmark baseline boundary", () => {
  it("reads a regular repository-local JSON file", () => {
    const root = tempDirectory("baseline");
    const path = join(root, "baseline.json");
    writeFileSync(path, '[{"size":200}]');

    expect(readRepositoryJson(root, "baseline.json")).toEqual([{ size: 200 }]);
  });

  it("rejects traversal and symlink escape outside the repository", () => {
    const container = tempDirectory("escape");
    const root = join(container, "repo");
    mkdirSync(root);
    const outside = join(container, "outside.json");
    writeFileSync(outside, "[]");
    symlinkSync(outside, join(root, "linked.json"));

    expect(() => readRepositoryJson(root, relative(root, outside))).toThrow(/repository-local/);
    expect(() => readRepositoryJson(root, "linked.json")).toThrow(/regular JSON/);
  });

  it("rejects non-JSON names, directories, invalid JSON, and files over the byte cap", () => {
    const root = tempDirectory("invalid");
    mkdirSync(join(root, "directory.json"));
    writeFileSync(join(root, "baseline.txt"), "[]");
    writeFileSync(join(root, "invalid.json"), "not json");
    writeFileSync(join(root, "large.json"), " ".repeat(33));
    expect(() => readRepositoryJson(root, "baseline.txt")).toThrow(/regular JSON/);
    expect(() => readRepositoryJson(root, "directory.json")).toThrow(/regular JSON/);
    expect(() => readRepositoryJson(root, "invalid.json")).toThrow(/valid JSON/);
    expect(() => readRepositoryJson(root, "large.json", 32)).toThrow(/byte limit/);
  });
});

describe("terminal log fields", () => {
  it("renders CR, LF, and ANSI controls visibly without changing ordinary text", () => {
    expect(safeLogValue("alpha\r\nbeta\u001b[31mred\u001b[0m")).toBe("alpha\\r\\nbetared");
    expect(safeLogValue("ordinary/path.md")).toBe("ordinary/path.md");
  });
  it("serializes the complete eval record onto one inert line without dropping hostile provenance", () => {
    expect(typeof terminalSafety.safeJsonLogRecord).toBe("function");
    const summary = {
      corpusCommit: "deadbeef\r\nFORGED\u001b[31m",
      usable: { ok: 4, of: 7 },
      notScored: {
        staleDetail: [{
          expected: "notes/a.md\nnext",
          reason: "\u001b]0;title\u0007stale\u007f\u0085\u009b31m\u2028line\u2029paragraph",
        }],
      },
    };

    const record = terminalSafety.safeJsonLogRecord!(summary);

    expect(record).not.toMatch(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/);
    expect(JSON.parse(record)).toEqual(summary);
  });
});
