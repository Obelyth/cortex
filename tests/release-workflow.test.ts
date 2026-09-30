import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// A published release must come from exactly one place: release.yml, which checks the
// tag against the reviewed release text, re-runs CI at the tag, waits for the `release`
// environment approval, then publishes the reviewed header with the attested source
// archive. Any other workflow that reacts to a v* tag can publish first (for example a
// generated-notes release), and release.yml's `gh release create --verify-tag` then
// fails on the existing release.

const dir = ".github/workflows";
const workflows = readdirSync(dir)
  .filter((name) => /\.ya?ml$/.test(name))
  .map((name) => ({ name, text: readFileSync(join(dir, name), "utf8") }));

// The top-level `on:` value and block, up to the next top-level key, without comments.
function triggers(text: string): string {
  const match = text.match(/^on:([^\n]*)\n((?:[ \t#][^\n]*\n|\n)*)/m);
  return match ? `${match[1]}\n${match[2]}`.replace(/#[^\n]*/g, "") : "";
}

// The job blocks under the top-level `jobs:` key, in file order, keyed by job id.
function jobs(text: string): [string, string][] {
  const body = text.split(/^jobs:[ \t]*\n/m)[1] ?? "";
  const blocks: [string, string][] = [];
  for (const line of body.split("\n")) {
    if (/^\S/.test(line)) break;
    const id = line.match(/^  ([A-Za-z0-9_-]+):\s*$/);
    if (id) blocks.push([id[1], ""]);
    else if (blocks.length) blocks[blocks.length - 1][1] += `${line}\n`;
  }
  return blocks;
}

// Bash `[[ $branch == $pattern ]]` matching, which is how CI Auto-Fix applies skip_branches.
function globMatches(pattern: string, value: string): boolean {
  const source = pattern.replace(/[.+^${}()|\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".");
  return new RegExp(`^${source}$`).test(value);
}

// True when a tag push can start the workflow: a tags filter, a `create` event, or a
// `push` event that is not limited to branches (a bare `push`, `on: push`,
// `on: [pull_request, push]`, or a push filtered only by paths).
function reactsToTags(text: string): boolean {
  const on = triggers(text);
  if (/\btags(?:-ignore)?\s*:/.test(on) || /(^|[\s[,{])create\b/.test(on)) return true;
  if (!/(^|[\s[,{])push\b/.test(on)) return false;
  const push = on.match(/(^|[\s[,{])push\s*:?[ \t]*(\{[^\n]*|\n(?:[ \t]{4,}[^\n]*\n|\n)*)?/);
  return !/\bbranches(?:-ignore)?\s*:/.test(push?.[2] ?? "");
}

describe("release publication", () => {
  it("recognizes every trigger form that runs on a tag push", () => {
    const wf = (on: string) => `name: sample\n${on}\njobs:\n  a:\n    runs-on: ubuntu-latest\n`;
    const tagged = [
      "on:\n  push:\n    tags: ['v*']\n",
      "on:\n  push:\n    tags-ignore: ['x*']\n",
      "on:\n  push:\n",
      "on: push\n",
      "on: [pull_request, push]\n",
      "on:\n  push: {tags: ['v*']}\n",
      "on:\n  create:\n",
      "on:\n  push:\n    paths: ['src/**']\n",
      "on:\n  push:\n    branches: [main]\n    tags: ['v*']\n",
    ];
    const untagged = [
      "on:\n  push:\n    branches: [main]\n",
      "on:\n  push:\n    branches-ignore: [wip]\n",
      "on:\n  push: {branches: [main]}\n",
      "on:\n  pull_request:\n    types: [opened, closed]\n",
      "on:\n  # push:\n  #   tags: ['v*']\n  pull_request:\n",
      "on:\n  release:\n    types: [created]\n",
    ];
    for (const on of tagged) expect(reactsToTags(wf(on)), on).toBe(true);
    for (const on of untagged) expect(reactsToTags(wf(on)), on).toBe(false);
  });

  it("only release.yml runs on tag pushes", () => {
    const onTags = workflows.filter(({ text }) => reactsToTags(text)).map(({ name }) => name);
    expect(onTags).toEqual(["release.yml"]);
  });

  it("only release.yml creates a GitHub release", () => {
    const publishers = workflows
      .filter(({ text }) => /gh release create|action-gh-release|repos\/[^\s]*\/releases/.test(text))
      .map(({ name }) => name);
    expect(publishers).toEqual(["release.yml"]);
  });

  it("release.yml checks the tag before CI, and publishes only after CI and the release environment", () => {
    const text = readFileSync(join(dir, "release.yml"), "utf8");
    const byId = Object.fromEntries(jobs(text));
    expect(Object.keys(byId)).toEqual(["preflight", "verify", "release"]);
    const { preflight, verify, release } = byId;

    // A tag that is off the default branch or does not match the reviewed release text fails
    // in a read-only job, before the suite runs and before anyone is asked to approve.
    expect(preflight).not.toMatch(/^\s+needs:/m);
    expect(preflight).not.toMatch(/^\s+environment:/m);
    expect(preflight).toMatch(/^    permissions:\n      contents: read\n(?! {6}\S)/m);
    expect(preflight).toMatch(/^\s+fetch-depth: 0$/m);
    expect(preflight).toContain('git merge-base --is-ancestor HEAD "refs/remotes/origin/$DEFAULT_BRANCH"');
    expect(preflight).toContain('test "v$(jq -r .version package.json)" = "$GITHUB_REF_NAME"');
    expect(preflight).toContain('grep -qxF "## What changed in ${GITHUB_REF_NAME}" .github/RELEASE_HEADER.md');
    expect(preflight).toContain('test -f "docs/releases/${GITHUB_REF_NAME}.md"');

    expect(verify).toMatch(/^\s+needs: preflight$/m);
    expect(verify).toMatch(/^\s+uses: \.\/\.github\/workflows\/ci\.yml$/m);

    expect(release).toMatch(/^\s+needs: \[preflight, verify\]$/m);
    expect(release).toMatch(/^\s+environment:\n\s+name: release$/m);
    expect(release).toMatch(/gh release create "\$\{GITHUB_REF_NAME\}" \\\n\s+--verify-tag/);
    expect(release).toMatch(/--notes-file /);
    expect(text).not.toMatch(/--generate-notes/);

    // The gate is the needs chain. An `if: always()` / `!cancelled()` on a job, or a
    // `continue-on-error` on a job or step, would let a failed preflight or CI run reach the
    // approval step and publish.
    for (const [id, block] of Object.entries(byId)) {
      expect(block, `${id} has an if:`).not.toMatch(/^\s+(?:-\s+)?if:/m);
      expect(block, `${id} has continue-on-error`).not.toMatch(/^\s+(?:-\s+)?continue-on-error:/m);
    }
  });

  it("CI Auto-Fix ignores failed release runs at version tags", () => {
    // A failed tag-push run reports the tag as its head branch. The fixer must not treat
    // it as a branch to diagnose and fix. Local change to the installed caller.
    const caller = workflows.find(({ name }) => name === "ci-autofix.yml");
    expect(caller, "CI Auto-Fix caller present").toBeDefined();
    expect(caller!.text).toMatch(/^\s+workflows: \[[^\]\n]*"release"[^\]\n]*\]$/m);
    const skip = caller!.text.match(/^\s+skip_branches: "([^"\n]*)"$/m)?.[1].split(",") ?? [];
    // The fixer's own defaults stay in the list.
    for (const kept of ["context", "save/red-*", "gh-readonly-queue/*", "claude/ci-autofix/*"]) {
      expect(skip).toContain(kept);
    }
    expect(skip).toContain("v[0-9]*");
    const { version } = JSON.parse(readFileSync("package.json", "utf8"));
    for (const tag of [`v${version}`, "v2.0.0", "v10.0.0-rc.1"]) {
      expect(skip.some((pattern) => globMatches(pattern, tag)), tag).toBe(true);
    }
    for (const branch of ["main", "dev", "fix/v2-notes", "feature/x"]) {
      expect(skip.some((pattern) => globMatches(pattern, branch)), branch).toBe(false);
    }
  });

  it("PR Hygiene does not receive tag events", () => {
    const caller = workflows.find(({ name }) => name === "pr-hygiene.yml");
    expect(caller, "PR Hygiene caller present").toBeDefined();
    expect(reactsToTags(caller!.text)).toBe(false);
  });

  it("release text matches package.json", () => {
    const { version } = JSON.parse(readFileSync("package.json", "utf8"));
    expect(readFileSync(".github/RELEASE_HEADER.md", "utf8")).toContain(`## What changed in v${version}\n`);
    expect(existsSync(`docs/releases/v${version}.md`)).toBe(true);
  });
});
