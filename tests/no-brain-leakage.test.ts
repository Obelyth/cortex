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
 * WHEN ../brain IS ABSENT this gate cannot run, and that fact is now SAID OUT LOUD rather than
 * folded into a silent skip. It used to disappear from the run entirely — CI never clones a
 * brain, so the gate had never once executed there, and a developer without the brain saw a
 * green suite that had certified nothing. Set REQUIRE_EXPORT_GATE=1 on any path that actually
 * ports code (a release script, a pre-push hook) to make absence a hard failure instead.
 *
 * WHOLE LINES ARE NOT ENOUGH. The line check below asks whether a full brain line was
 * reproduced; a credential never is. It is a short token INSIDE a longer line, so no secret
 * could ever trip that check — which is exactly how a live production password reached the
 * public repo with this suite green. The third test closes that: it extracts secret-shaped
 * substrings from the brain using lib/redact's own patterns and asserts none of them appear in
 * shipped source, at any length.
 */
import { describe, expect, it } from "vitest";
import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { SECRETS } from "../lib/redact";
import { SKIP_NAME, SKIP_PREFIX } from "../lib/corpus";

const BRAIN = process.env.BRAIN_DIR ?? join(process.cwd(), "..", "brain");
const REPO = process.cwd();
const present = existsSync(BRAIN);

// The escape hatch has to be closable. Any path that actually publishes code — a release
// script, a pre-push hook, the port itself — sets this, and a missing brain becomes a failure
// rather than a skip. Thrown at module load so it cannot be mistaken for one failing assertion.
if (!present && process.env.REQUIRE_EXPORT_GATE === "1") {
  throw new Error(
    `REQUIRE_EXPORT_GATE=1 but no brain clone at ${BRAIN}. The export gate cannot run, and this ` +
      `is a path that publishes code. Clone the brain or set BRAIN_DIR.`
  );
}

/** Directories whose contents ship. node_modules and build output are not ours to police. */
const SCAN_DIRS = ["lib", "app", "tests", "scripts", "docs", "ops", "supabase", "brain-template"];
const SCAN_ROOT_FILES = ["README.md", "CONTRIBUTING.md", "SECURITY.md", "ROADMAP.md", ".env.example"];

/** This file necessarily describes the leak it prevents, so it cannot be its own subject. */
const SELF = "tests/no-brain-leakage.test.ts";

/**
 * PRIVATE-ONLY: files that exist in the operator's private deployment and are never ported here
 * except in sanitized form.
 *
 * This list is the export boundary written down as code, which is the point. Deciding "does this
 * file ship?" used to happen in someone's head during a port, once per file, under time pressure.
 * Here it is a committed policy the test enforces: on the private side these files quote the
 * brain freely; the copies shipped here carry synthetic fixtures only, and they reference the
 * live-brain layout (../brain, its well-known note paths) by design, which is why the gate does
 * not scan them. Everything else in the tree — including the public-only surfaces such as
 * ops/groundskeeper, the onboarding scripts and brain-template/ — is scanned in full.
 *
 *   docs/superpowers/specs/**  design specs; the private originals are dense with measured facts
 *                              about the operator's real corpus
 *   tests/hard-*.test.ts       the live-brain suites; on the private side, reading the real
 *                              thing IS their purpose
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

/**
 * Secret-shaped substrings in the brain, as VALUES rather than whole lines.
 *
 * The key=value rule contributes its value half; the vendor-token and JWT rules contribute the
 * whole match.
 *
 * The floor is 4 characters, deliberately low: the credential that actually leaked was FOUR
 * digits. A longer floor would have let it through and this test would be theatre. What keeps
 * that from drowning the run in noise is that a token must appear in BOTH the brain and shipped
 * source to count, so a common short string only trips when it genuinely sits in both.
 *
 * INDIRECTION IS NOT A SECRET. `TOKEN="$(security find-generic-password …)"` is a note about
 * Keychain hygiene — the practice this whole area exists to encourage — and lib/health.ts's
 * plausibleSecret() already excludes exactly that shape. Documenting it in a comment must not
 * read as leaking it.
 */
const INDIRECTION = /^\$[({]?/; // $(cmd), ${VAR}, $VAR
const PLACEHOLDER = /^(x+|\.+|<.*>|\{.*\}|changeme|your[-_]?\w*|placeholder|redacted|example)$/i;
/**
 * A short run of plain letters is prose, not a credential this check can police.
 *
 * Measured against the real brain, the extractor yields seven distinct tokens: four are shell
 * indirection, one is the credential, and two are the words "temp" and "user" — which appear in
 * ordinary source everywhere and would flag thirty files. A password that IS a short dictionary
 * word is indistinguishable from prose by any rule that does not also flag the prose, so it is
 * out of scope here and belongs to rotation instead. Digits and mixed-class tokens stay in,
 * which is what the leaked value was.
 */
const WORDLIKE = /^[A-Za-z]{1,11}$/;

/**
 * AN IDENTIFIER IS NOT A SECRET. A field-ops note that quotes the design system it builds on
 * hands the extractor a CSS custom-property name — and `--ob-ink-900` extracted as a "value"
 * collides with every stylesheet that defines it, which is how the 2026-08 false positive put
 * app/globals.css on this gate's report. A custom property's name is published verbatim in
 * every sheet and every devtools pane that uses it; treating one as a credential flags the
 * design system for existing, and a gate people learn to ignore is a dead gate. The exclusion
 * is exactly the custom-property shape — two dashes, a letter, then identifier characters —
 * and nothing else: a value that merely contains dashes, starts with one dash, or trails into
 * other text is still policed.
 */
const CSS_VAR = /^--[A-Za-z][A-Za-z0-9-]*$/;

function brainSecrets(): Map<string, string> {
  const out = new Map<string, string>();
  for (const rel of brainPaths()) {
    let text: string;
    try {
      text = readFileSync(join(BRAIN, rel), "utf8");
    } catch {
      continue;
    }
    for (const [pattern] of SECRETS) {
      for (const m of text.matchAll(new RegExp(pattern.source, pattern.flags))) {
        // Group 1 is the key name for the key=value rule; the value is what must never ship.
        const raw = m[1] ? m[0].slice(m[1].length).replace(/^["']?\s*[:=]\s*/, "") : m[0];
        const token = raw.trim().replace(/^[`"']+|[`"',.;)]+$/g, "");
        if (token.length < 4) continue;
        if (!/[A-Za-z0-9]/.test(token)) continue;
        if (INDIRECTION.test(token)) continue;
        if (PLACEHOLDER.test(token)) continue;
        if (WORDLIKE.test(token)) continue;
        if (CSS_VAR.test(token)) continue;
        if (!out.has(token)) out.set(token, rel);
      }
    }
  }
  return out;
}

describe("CSS_VAR — the identifier shape the credential extractor excludes", () => {
  // Pure shape checks, no brain required: these pins run on every machine, including CI without
  // a brain clone, so the exclusion cannot silently widen where the corpus tests are skipped.
  it("excludes a custom-property name — an identifier the stylesheets publish anyway", () => {
    expect(CSS_VAR.test("--ob-ink-900")).toBe(true);
    expect(CSS_VAR.test("--accent")).toBe(true);
  });

  it("keeps everything that is not exactly that shape", () => {
    expect(CSS_VAR.test("a1b2-c3d4")).toBe(false); // dashes inside a value are just dashes
    expect(CSS_VAR.test("-a1b2c3")).toBe(false); // one dash is not the shape
    expect(CSS_VAR.test("--4821")).toBe(false); // dashed digits could be a PIN — policed
    expect(CSS_VAR.test("--ob ink")).toBe(false); // spaces break the identifier
  });
});

if (!present) {
  // VISIBLE, not silent. skipIf alone shrank the reported test count and said nothing, so a run
  // without the brain looked identical to a run that had checked everything.
  describe.skip(`export gate SKIPPED — no brain clone at ${BRAIN} (set BRAIN_DIR, or REQUIRE_EXPORT_GATE=1 to fail instead)`, () => {
    it("did not run", () => {});
  });
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

  it("no credential-shaped value from the brain appears in any shipped source file", () => {
    // THE CHECK THE LINE TEST STRUCTURALLY CANNOT DO. A secret is a token inside a line, so
    // indexOf on whole brain lines can never match one. This is how ADMIN_PASSWORD=<value> for a
    // live site sat in tests/redact.test.ts, tests/health-outline.test.ts and
    // tests/hard-surface.test.ts and rode four commits into the public repo with this suite green.
    const secrets = brainSecrets();
    const hits: string[] = [];

    for (const [file, text] of repoSources()) {
      for (const [token, origin] of secrets) {
        const at = text.indexOf(token);
        if (at < 0) continue;
        const line = text.slice(0, at).split("\n").length;
        // Coordinates and origin only — printing the token would put the credential in the log
        // that proves the credential leaked.
        hits.push(`${file}:${line} contains a credential-shaped value from ${origin}`);
      }
    }

    expect(
      hits,
      `real credential values found in shipped source (rotate them, then replace the fixture with a synthetic value):\n  ${hits.join("\n  ")}`
    ).toEqual([]);
  });

  it("the gate itself is looking at something — guards against a silently empty corpus", () => {
    // A gate that scans nothing passes everything. If the brain moves or the walk breaks, this
    // fails loudly instead of the suite going quietly green and certifying an unexamined repo.
    expect(brainPaths().length).toBeGreaterThan(20);
    expect(brainLines().size).toBeGreaterThan(200);
    expect(repoSources().length).toBeGreaterThan(30);
  });
});

describe.skipIf(!present)("corpus definition parity — the live differential", () => {
  // Both sides announce "a parity test asserts the two agree" (lib/corpus.ts, brain_ask.py:38).
  // Until 2026-08-18 that test was a hand-synced copy — which is how ".claude/" landed on the
  // python side first and the two definitions of "the live corpus" spent a day disagreeing with
  // every assertion green. This reads the real python source out of the brain checkout, so the
  // next divergence fails the gate instead of waiting for someone to notice a count mismatch.
  function pyTuple(name: string): string[] {
    const src = readFileSync(join(BRAIN, "tools", "brain_ask.py"), "utf8");
    const m = src.match(new RegExp(`^${name}\\s*=\\s*\\(([^)]*)\\)`, "m"));
    expect(m, `${name} tuple not found in brain_ask.py — update this parser alongside the py`).toBeTruthy();
    return [...m![1].matchAll(/["']([^"']*)["']/g)].map((x) => x[1]);
  }

  it("SKIP_PREFIX matches brain_ask.py, order and all", () => {
    expect(SKIP_PREFIX).toEqual(pyTuple("SKIP_PREFIX"));
  });

  it("SKIP_NAME matches brain_ask.py SKIP_NAMES, order and all", () => {
    expect(SKIP_NAME).toEqual(pyTuple("SKIP_NAMES"));
  });
});
