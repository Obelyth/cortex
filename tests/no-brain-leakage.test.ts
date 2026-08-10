/**
 * The export gate — nothing in this repo may quote the operator's real brain.
 *
 * WHY THIS EXISTS. Private note content has reached the public Obelyth/cortex twice. Both times
 * the sanitisation pass was a string search for known bad phrases, and both times it walked past
 * the same fact written a different way — once as note content, once as a code comment describing
 * a past leak. Searching for what you already know is leaked cannot find what you don't.
 *
 * So this inverts the check. It does not carry a denylist of private words — a denylist committed
 * to a public repo publishes the very list it protects. Instead it reads the real brain at test
 * time and asserts that **no real note path and no distinctive real line appears anywhere in this
 * repository's source**. Fixtures are unaffected: `notes/a.md` and "alpha" are not in the brain,
 * so they cannot trip it. A real path or a pasted real sentence is caught on the spot, whatever
 * file it lands in and whatever it is dressed up as.
 *
 * THE GUARD MUST NOT LEAK EITHER. A failure names the repo file, the line, and which brain note
 * it came from — never the matching text. This suite's output goes to CI logs, and on the Obelyth
 * side those logs are public; a diagnostic that prints the private line to prove the private line
 * escaped would be the same bug wearing a different hat. The developer has the brain locally and
 * can find the text from the coordinates.
 *
 * Skips cleanly when ../brain is absent, like every other hard-* suite, so CI stays green without
 * the brain checked out. That means it is a DEVELOPER gate, not a CI gate — it fires on the
 * machine doing the porting, which is exactly where a leak is introduced.
 */
import { describe, expect, it } from "vitest";
import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const BRAIN = process.env.BRAIN_DIR ?? join(process.cwd(), "..", "brain");
const REPO = process.cwd();
const present = existsSync(BRAIN);

/** Directories whose contents ship. node_modules and build output are not ours to police. */
const SCAN_DIRS = ["lib", "app", "tests", "scripts", "docs", "ops", "supabase", "brain-template"];
const SCAN_ROOT_FILES = ["README.md", "CONTRIBUTING.md", "SECURITY.md", "ROADMAP.md", ".env.example"];

/** This file necessarily describes the leak it prevents, so it cannot be its own subject. */
const SELF = "tests/no-brain-leakage.test.ts";

/**
 * PRIVATE-ONLY: files that exist in the operator's private deployment and are never ported here.
 *
 * This list is the export boundary written down as code, which is the point. Deciding "does this
 * file ship?" used to happen in someone's head during a port, once per file, under time pressure.
 * Here it is a committed policy the test enforces: quote the brain freely in these, and nowhere
 * else. If a file is added here it MUST also be excluded from the port — the two facts are the
 * same fact, and this array is where it lives.
 *
 *   docs/superpowers/specs/**  design specs, dense with measured facts about the operator's real corpus
 *   tests/hard-*.test.ts       the live-brain suites; reading the real thing IS their purpose
 */
const PRIVATE_ONLY = [/^docs\/superpowers\/specs\//, /^tests\/hard-[^/]+\.test\.ts$/];

const isPrivateOnly = (rel: string) => PRIVATE_ONLY.some((re) => re.test(rel));

function walk(dir: string, base = ""): string[] {
  const out: string[] = [];
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    if (name === ".git" || name === "node_modules" || name === ".next") continue;
    const abs = join(dir, name);
    const rel = base ? `${base}/${name}` : name;
    if (statSync(abs).isDirectory()) out.push(...walk(abs, rel));
    else out.push(rel);
  }
  return out;
}

/** Every file this repo would publish, as (repo-relative path, text). */
function repoSources(): Array<[string, string]> {
  const files: string[] = [];
  for (const d of SCAN_DIRS) files.push(...walk(join(REPO, d), d));
  for (const f of SCAN_ROOT_FILES) if (existsSync(join(REPO, f))) files.push(f);
  return files
    .filter((f) => f !== SELF && !isPrivateOnly(f))
    .filter((f) => /\.(ts|tsx|js|mjs|jsx|css|md|json|sql|sh|py)$/.test(f))
    .map((f) => [f, readFileSync(join(REPO, f), "utf8")] as [string, string]);
}

/** Real note paths, live and archived. Archive counts double: it is the least-reviewed material. */
function brainPaths(): string[] {
  return walk(BRAIN).filter((p) => p.endsWith(".md"));
}

/**
 * The brain's SCHEMA is public; its note NAMES are private. This separates the two.
 *
 * profile.md, INDEX.md and README.md are fixed structural filenames — they are documented in the
 * public README and shipped in brain-template/, so cortex naming them is describing its own file
 * format, not disclosing what the operator writes about. Day logs are the same: a dated log path
 * is a date in a known shape, carrying no more information than the calendar.
 *
 * A named note under projects/ is the opposite. Nothing about the format requires that name; it
 * exists only because the operator has a project by that name, and printing it in a public repo
 * says so. That is the whole distinction: the shape is documentation, the name is disclosure.
 */
const SCHEMA_PATHS = new Set(["profile.md", "INDEX.md", "README.md"]);
const isSchemaPath = (p: string) => SCHEMA_PATHS.has(p) || /^log\/\d{4}-\d{1,2}-\d{1,2}\.md$/.test(p);

/**
 * Brain files cortex WROTE are not the operator's writing, and matching them is not copying.
 *
 * INDEX.md is emitted by lib/brain.ts and the router by lib/frontmatter.ts, both stamped
 * "Auto-generated by cortex". Their headers therefore appear verbatim in the generator, in the
 * generator's tests, and in the output sitting in the brain — a generator is supposed to match
 * its own output. Counting that as a leak trains people to ignore this test, which is the only
 * way a gate like this actually fails.
 */
const GENERATED_MARKER = "Auto-generated by cortex";

/**
 * Lines from the brain distinctive enough that finding one in source means it was copied.
 *
 * The 45-char floor and the shape filters are the whole design. Too low and ordinary English
 * ("This is the plan.") produces false positives that train people to disable the test, which is
 * worse than no test. Markdown scaffolding, code fences and link-only lines are dropped for the
 * same reason: they recur across unrelated documents and prove nothing about copying.
 */
function brainLines(): Map<string, string> {
  const byLine = new Map<string, string>();
  for (const rel of brainPaths()) {
    let text: string;
    try {
      text = readFileSync(join(BRAIN, rel), "utf8");
    } catch {
      continue;
    }
    if (text.includes(GENERATED_MARKER)) continue;
    for (const raw of text.split("\n")) {
      const line = raw.trim();
      if (line.length < 45) continue;
      if (/^[-=*_#>|`\s]+$/.test(line)) continue; // rules, fences, empty scaffolding
      if (/^[-*+]\s*\[[ x]\]/.test(line)) continue; // checkbox boilerplate
      if (/^(https?:\/\/|!\[|\[)/.test(line)) continue; // bare links and images
      if (!/[a-z]{3}/i.test(line)) continue; // needs actual words
      if (!byLine.has(line)) byLine.set(line, rel);
    }
  }
  return byLine;
}

describe.skipIf(!present)("export gate: this repo must not quote the real brain", () => {
  it("no real note path appears in any shipped source file", () => {
    const sources = repoSources();
    // Synthetic fixtures are the norm and must stay cheap to write, so only paths that ACTUALLY
    // EXIST in the brain are policed. notes/a.md is safe precisely because it is not real.
    const real = brainPaths()
      .filter((p) => !isSchemaPath(p))
      .filter((p) => p.split("/").pop()!.length > 4);
    const hits: string[] = [];

    for (const [file, text] of sources) {
      for (const p of real) {
        const at = text.indexOf(p);
        if (at < 0) continue;
        const line = text.slice(0, at).split("\n").length;
        hits.push(`${file}:${line} references the real note ${p}`);
      }
    }

    expect(hits, `real brain note paths found in shipped source:\n  ${hits.join("\n  ")}`).toEqual([]);
  });

  it("no distinctive line from any real note appears in any shipped source file", () => {
    const lines = brainLines();
    const sources = repoSources();
    const hits: string[] = [];

    for (const [file, text] of sources) {
      if (text.length === 0) continue;
      for (const [line, origin] of lines) {
        const at = text.indexOf(line);
        if (at < 0) continue;
        const at1 = text.slice(0, at).split("\n").length;
        // Coordinates only. The matching text is exactly what must not be reproduced, including
        // here — printing it would put the private line into the CI log that proves it leaked.
        hits.push(`${file}:${at1} reproduces a line from ${origin}`);
      }
    }

    expect(hits, `verbatim brain content found in shipped source:\n  ${hits.join("\n  ")}`).toEqual([]);
  });

  /**
   * Exact-path matching misses the near miss, which is the shape a leak actually takes.
   *
   * A fixture written from memory lands one segment off the real name — notes/<stem>.md where the
   * brain holds notes/<stem>-something.md. The path is not real, so the exact check passes it, and
   * the disclosure is identical: the stem is the project, and the stem is what was private.
   *
   * Only path-shaped literals are inspected, never prose, so a stem that is also an ordinary word
   * cannot fire on a sentence that merely uses it.
   */
  it("no near miss of a real note path appears in any shipped source file", () => {
    const base = (p: string) => p.split("/").pop()!.replace(/\.md$/, "").toLowerCase();
    const real = brainPaths().filter((p) => !isSchemaPath(p));

    // Truncation, not overlap. `quarry` against a real `quarry-api` is the same name with a
    // qualifier dropped; `harbor-policy` against a real `harbor-targets` is two different notes
    // that happen to start with an ordinary word, and policing that would fire on English.
    //
    // The examples here are fictional on purpose. Describing a leak is how the last two got
    // reintroduced: the note came out, and the comment explaining the note went back in.
    const truncates = (a: string, b: string) =>
      a !== b && a.length > 4 && b.startsWith(a) && b[a.length] === "-";

    const hits: string[] = [];
    for (const [file, text] of repoSources()) {
      for (const m of text.matchAll(/(?:notes|projects|archive)\/[A-Za-z0-9._-]+\.md/g)) {
        const b = base(m[0]);
        const origin = real.find((p) => truncates(b, base(p)) || truncates(base(p), b));
        if (!origin || m[0] === origin) continue; // the exact-path check owns the exact case
        const line = text.slice(0, m.index!).split("\n").length;
        hits.push(`${file}:${line} names a note one qualifier off a real one (${origin})`);
      }
    }

    expect(hits, `near-miss brain note paths found in shipped source:\n  ${hits.join("\n  ")}`).toEqual([]);
  });

  it("the gate itself is looking at something — guards against a silently empty corpus", () => {
    // A gate that scans nothing passes everything. If the brain moves or the walk breaks, this
    // fails loudly instead of the suite going quietly green and certifying an unexamined repo.
    expect(brainPaths().length).toBeGreaterThan(20);
    expect(brainLines().size).toBeGreaterThan(200);
    expect(repoSources().length).toBeGreaterThan(30);
  });
});
