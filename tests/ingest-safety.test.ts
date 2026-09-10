import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

let scratch: string;
let notes: string;
let calls: string;
beforeEach(() => {
  scratch = mkdtempSync(join(process.cwd(), ".cortex-ingest-test-"));
  notes = join(scratch, "notes with spaces");
  calls = join(scratch, "gh-calls.json");
  mkdirSync(notes);
  writeFileSync(join(notes, 'Note with "quotes".md'), "A synthetic note.\n");
  // GitHub is the external boundary. Nothing in this suite can invoke its real CLI.
  writeFileSync(join(scratch, "gh"), `#!${process.execPath}\nconst fs=require('node:fs');if(process.env.INGEST_TEST_FAIL){process.stderr.write('private\\nFORGED\\u001b[31mred\\u001b[0m');process.exit(7)}fs.writeFileSync(process.env.INGEST_TEST_CALLS,JSON.stringify({args:process.argv.slice(2),input:fs.readFileSync(0,'utf8')}));`, { mode: 0o700 });
});
afterEach(() => rmSync(scratch, { recursive: true, force: true }));

function ingest(repo: string, commit = true, viaEnvironment = false, extraEnv: Partial<NodeJS.ProcessEnv> = {}) {
  return spawnSync(process.execPath, [resolve("scripts/ingest.mjs"), "--from", notes,
    ...(viaEnvironment ? [] : ["--repo", repo]), ...(commit ? ["--commit"] : [])], {
    encoding: "utf8", env: { ...process.env, PATH: `${scratch}:${process.env.PATH}`, BRAIN_REPO: repo, INGEST_TEST_CALLS: calls, ...extraEnv },
  });
}

describe("ingest repository boundary", () => {
  it.each(["example/brain; true #", "https://github.com/example/brain", "-option/brain", "example/brain/extra", "example"])(
    "refuses invalid repository names before running GitHub: %s", (repo) => {
      const result = ingest(repo);
      expect(result.status).toBe(1);
      expect(existsSync(calls)).toBe(false);
    },
  );
  it("applies the same repository validation to the environment in dry-run mode", () => {
    expect(ingest("example/brain; true #", false, true).status).toBe(1);
    expect(existsSync(calls)).toBe(false);
  });
  it("passes one literal API argument and a JSON stdin body for an approved repository", () => {
    expect(ingest("example/brain").status).toBe(0);
    const call = JSON.parse(readFileSync(calls, "utf8"));
    expect(call.args).toEqual(["api", "-X", "PUT", "repos/example/brain/contents/notes/note-with-quotes.md", "--input", "-"]);
    const payload = JSON.parse(call.input);
    expect(payload.message).toBe("brain: ingest notes/note-with-quotes.md");
    expect(Buffer.from(payload.content, "base64").toString("utf8")).toContain('from Note with "quotes".md.');
  });
  it("keeps preview read-only for a valid repository", () => {
    expect(ingest("example/brain", false).status).toBe(0);
    expect(existsSync(calls)).toBe(false);
  });
  it("renders newline and ANSI controls in source filenames without forging terminal lines", () => {
    writeFileSync(join(notes, "bad\nFORGED\u001b[31m.md"), "synthetic\n");
    const result = ingest("example/brain", false);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("bad\\nFORGED.md");
    expect(result.stdout).not.toContain("bad\nFORGED");
    expect(result.stdout).not.toContain("\u001b");
  });
  it("renders forged GitHub stderr as one inert display field", () => {
    const result = ingest("example/brain", true, false, { INGEST_TEST_FAIL: "1" });

    expect(result.status).toBe(1);
    expect(result.stdout).toContain("private\\nFORGEDred");
    expect(result.stdout).not.toContain("private\nFORGED");
    expect(result.stdout).not.toContain("\u001b");
  });
});
