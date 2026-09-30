/**
 * The export gate — nothing in this repo may quote the operator's real brain.
 *
 * WHY THIS EXISTS. A sanitisation pass that is a string search for known bad phrases walks past
 * the same fact written a different way — as note content, or as a code comment that describes
 * it. Searching for what you already know is sensitive cannot find what you don't.
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
 * could ever trip that check, and a suite built only on it stays green while one ships. The
 * third test closes that: it extracts secret-shaped
 * substrings from the brain using lib/redact's own patterns and asserts none of them appear in
 * shipped source, at any length.
 */
import { describe, expect, it } from "vitest";
import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { SECRETS } from "../lib/redact";
import { SKIP_NAME, SKIP_PREFIX } from "../lib/corpus";
import { substringHits, unescaped } from "./helpers/export-scan";
import { noteNameHits } from "./helpers/export-reference-policy";
import publicReferences from "./helpers/export-public-references.json";

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
const SCAN_DIRS = ["lib", "app", "tests", "scripts", "docs", "ops", "supabase", "brain-template", "public", ".github", ".devcontainer"];
/**
 * The repo root is scanned BY EXTENSION, not by allowlist. An allowlist of five names exempted
 * every root file nobody thought to add — DESIGN.md at 23 KB, package.json, the sonar and vitest
 * configs, instrumentation.ts, `Cortex Setup.command` — and a gate whose coverage depends on
 * someone remembering to extend it is a gate that decays silently. Directories still need naming
 * (walking node_modules and .git would be absurd); files do not.
 */
const SCAN_ROOT_SKIP = new Set(["package-lock.json"]);

/**
 * NOTHING SHIPPED IS EXEMPT. There is no exclusion list: the adversarial hard-* suites and the
 * design specs are scanned like every other file. Files that describe real behaviour in detail
 * are exactly where copied text is most likely to hide, so they get the same scan, not a lighter
 * one. If a file cannot pass this scan, it cannot ship; there is no third category.
 */
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
  for (const d of SCAN_DIRS) if (existsSync(join(REPO, d))) files.push(...walk(join(REPO, d), d));
  for (const f of readdirSync(REPO)) {
    if (SCAN_ROOT_SKIP.has(f)) continue;
    if (statSync(join(REPO, f)).isFile()) files.push(f);
  }
  return files
    .filter((f) => /\.(ts|tsx|js|cjs|mjs|jsx|css|md|json|sql|sh|py|yml|yaml|command|txt|example|properties|svg|service|timer)$/.test(f))
    .flatMap((f) => {
      const raw = readFileSync(join(REPO, f), "utf8");
      const decoded = unescaped(raw);
      return (decoded === raw ? [[f, raw]] : [[f, raw], [f, decoded]]) as Array<[string, string]>;
    });
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
 *
 * projects/cortex.md is the one projects/ name that is structure, not disclosure: every cortex
 * deployment grows a project note about cortex itself, under the product's own name. The test
 * suites use it as their brain-presence sentinel and their fixtures cite it, so treating it as
 * private would flag the product for naming its own product.
 */
const SCHEMA_PATHS = new Set(["profile.md", "INDEX.md", "README.md", "projects/cortex.md"]);
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
 * The floor is 4 characters, deliberately low: a PIN or a short numeric passcode is four digits,
 * and a longer floor would let exactly that shape through. What keeps that from drowning the run
 * in noise is that a token must appear in BOTH the brain and shipped source to count, so a common
 * short string only trips when it genuinely sits in both.
 *
 * INDIRECTION IS NOT A SECRET. `TOKEN="$(pass show example/token)"` is a note about
 * secret-manager hygiene — the practice this whole area exists to encourage — and lib/health.ts's
 * plausibleSecret() already excludes exactly that shape. Documenting it in a comment must not
 * read as leaking it.
 */
const INDIRECTION = /^\$[({]?/; // $(cmd), ${VAR}, $VAR
const PLACEHOLDER = /^(x+|\.+|<.*>|\{.*\}|changeme|your[-_]?\w*|placeholder|redacted|example)$/i;
/**
 * A short run of plain letters is prose, not a credential this check can police.
 *
 * Run over ordinary notes, the extractor yields mostly shell indirection and words like "temp"
 * and "user" — which appear in ordinary source everywhere and would flag dozens of files. A
 * password that IS a short dictionary word is indistinguishable from prose by any rule that does
 * not also flag the prose, so it is out of scope here and belongs to rotation instead. Digits and
 * mixed-class tokens stay in: that is what a PIN or a generated secret looks like.
 */
const WORDLIKE = /^[A-Za-z]{1,11}$/;

/**
 * AN IDENTIFIER IS NOT A SECRET. A note that quotes a design system hands the extractor a CSS
 * custom-property name — and `--ob-ink-900` extracted as a "value" collides with every
 * stylesheet that defines it, putting app/globals.css on this gate's report for nothing. A
 * custom property's name is published verbatim in
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

describe("export gate source coverage", () => {
  it("includes its own shipped source in the privacy scan", () => {
    expect(repoSources().some(([file]) => file === "tests/no-brain-leakage.test.ts")).toBe(true);
  });

  it("includes the shipped development container in the privacy scan", () => {
    expect(repoSources().some(([file]) => file === ".devcontainer/devcontainer.json")).toBe(true);
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

  /**
   * THE PATH TEST ABOVE MATCHES A FULL PATH, AND A FULL PATH IS NOT THE ONLY WAY TO NAME A NOTE.
   *
   * It does `text.indexOf("notes/aurora-authoring.md")`. Source that writes the same note as
   * `[[notes/aurora-authoring]]` (no extension), `[[alpha-beats-beta]]` (no directory),
   * `"name: feedback-keep-building"` (a frontmatter value), or `about-stamps.md` (no directory)
   * matches none of them — every one of those is the note's name, and a path-only check passes
   * all of them green.
   *
   * The examples above are synthetic. This test file is scanned too: explanations and fixtures
   * must pass the same privacy checks as every other shipped source file.
   *
   * So the STEM is policed too, and it is the stem that discloses: a directory prefix and an
   * extension are format, and a reader who wants the note does not need either.
   *
   * The filters keep it from crying wolf, which is the only way a gate like this really dies.
   * A stem must be hyphenated and longer than eight characters to count — that is what makes a
   * name a name rather than a word ("setup.md", "map.md" and "log.md" are shapes anyone would
   * write). Schema paths are exempt for the reason SCHEMA_PATHS gives, and STEM_ALLOW carries
   * the names that are the product describing itself.
   * Independently public repository identifiers have a separate exact-occurrence policy;
   * it does not exempt their files or other occurrences of the same stem. See docs/export-gate.md.
   */
  const STEM_ALLOW = new Set([
    // "Cortex second-brain map — canvas renderer." The product's own term for the product.
    "second-brain",
  ]);

  it("no real note NAME appears in any shipped source file, path or not", () => {
    const stems = brainPaths()
      .filter((p) => !isSchemaPath(p))
      .map((p) => p.split("/").pop()!.replace(/\.md$/, ""))
      .filter((stem) => stem.includes("-") && stem.length > 8)
      .filter((stem) => !STEM_ALLOW.has(stem));
    const hits = noteNameHits(repoSources(), stems, publicReferences)
      .map(({ file, line, origin }) => `${file}:${line} names the real note "${origin}"`);

    expect(hits, `real brain note names found in shipped source:\n  ${hits.join("\n  ")}`).toEqual(
      []
    );
  });

  it("no distinctive line from any real note appears in any shipped source file", () => {
    const lines = brainLines();
    const sources = repoSources();
    const hits = substringHits(sources, lines).map(({file,line}) => `${file}:${line}`);

    expect(hits, `verbatim brain content found in shipped source:\n  ${hits.join("\n  ")}`).toEqual([]);
  });

  it("no credential-shaped value from the brain appears in any shipped source file", () => {
    // THE CHECK THE LINE TEST STRUCTURALLY CANNOT DO. A secret is a token inside a line, so
    // indexOf on whole brain lines can never match one: a KEY=<value> pair pasted into a fixture,
    // inside a longer line, passes every whole-line check green.
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

    // Truncation, not overlap. `widget` against a real `widget-api` is the same name with a
    // qualifier dropped; `garden-policy` against a real `garden-targets` is two different notes
    // that happen to start with an ordinary word, and policing that would fire on English.
    //
    // The examples here are fictional on purpose: a comment that names a real note to explain
    // the rule would reintroduce the very name it describes.
    const truncates = (a: string, b: string) =>
      a !== b && a.length > 4 && b.startsWith(a) && b[a.length] === "-";

    const hits: string[] = [];
    for (const [file, text] of repoSources()) {
      for (const m of text.matchAll(/(?:notes|projects|archive|history)\/[A-Za-z0-9._\/-]+\.md/g)) {
        // A schema path is the deliberately-public exception the exact check carves out; its stem
        // is the product's own name, so a "near miss" of it discloses nothing either.
        if (isSchemaPath(m[0])) continue;
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

/**
 * Corpus definition parity — the live differential against the brain-side reference ranker.
 *
 * lib/corpus.ts's SKIP_PREFIX and SKIP_NAME define "the live corpus". A brain-side reference
 * implementation that scores retrieval outside this server carries its own copy of both lists,
 * and a hand-synced copy of them in this repo can drift from the real one with every assertion
 * green. So this reads the reference source itself, and the next divergence fails here instead
 * of surfacing as a count that does not add up.
 *
 * Where that file lives is deployment detail, not part of this repo: BRAIN_PARITY_RANKER names
 * it. Unset, the check is skipped VISIBLY; set to a path that does not exist, it fails.
 */
const RANKER = process.env.BRAIN_PARITY_RANKER;
const haveRanker = Boolean(RANKER) && existsSync(RANKER as string);

if (RANKER && !haveRanker) {
  throw new Error(`BRAIN_PARITY_RANKER is set to ${RANKER}, which does not exist. Point it at the reference ranker or unset it.`);
}

if (!haveRanker) {
  describe.skip("corpus definition parity SKIPPED — BRAIN_PARITY_RANKER is not set, so nothing compared lib/corpus.ts with the reference ranker", () => {
    it("did not run", () => {});
  });
}

describe.skipIf(!haveRanker)("corpus definition parity — the live differential", () => {
  function pyTuple(name: string): string[] {
    const src = readFileSync(RANKER as string, "utf8");
    const m = src.match(new RegExp(`^${name}\\s*=\\s*\\(([^)]*)\\)`, "m"));
    expect(m, `${name} tuple not found in the reference ranker — update this parser alongside it`).toBeTruthy();
    return [...m![1].matchAll(/["']([^"']*)["']/g)].map((x) => x[1]);
  }

  it("SKIP_PREFIX matches the reference ranker's, order and all", () => {
    expect(SKIP_PREFIX).toEqual(pyTuple("SKIP_PREFIX"));
  });

  it("SKIP_NAME matches the reference ranker's SKIP_NAMES, order and all", () => {
    expect(SKIP_NAME).toEqual(pyTuple("SKIP_NAMES"));
  });
});
