#!/usr/bin/env node
/**
 * CORTEX ingest — bring an existing folder of notes into the brain.
 *
 * Dry-run BY DEFAULT: it prints exactly what it would file and where, and
 * writes nothing until you pass --commit. Every ingested note gets a
 * provenance line, because a brain that cannot say where a claim came from
 * cannot be trusted to answer with it.
 *
 *   npm run ingest -- --from ~/notes                    # preview
 *   npm run ingest -- --from ~/notes --commit           # do it
 *   npm run ingest -- --from ~/docs --into projects --commit
 */
import { execSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, extname, basename } from "node:path";

const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? null : args[i + 1] && !args[i + 1].startsWith("--") ? args[i + 1] : true;
};

const FROM = flag("from");
const INTO = flag("into") || "notes"; // notes | projects
const COMMIT = flag("commit") === true;
// Explicit flag beats environment: --repo means --repo.
const BRAIN = flag("repo") || process.env.BRAIN_REPO;

if (!FROM || !existsSync(FROM)) {
  console.error("usage: npm run ingest -- --from <folder> [--into notes|projects] [--repo owner/brain] [--commit]");
  process.exit(1);
}
if (!["notes", "projects"].includes(INTO)) {
  console.error(`--into must be notes or projects, got: ${INTO}`);
  process.exit(1);
}
if (!BRAIN) {
  console.error("set BRAIN_REPO=owner/brain (env) or pass --repo owner/brain");
  process.exit(1);
}

/** Contents-API ceiling is 1 MB and the server refuses to grow files it can no
 *  longer read back; stay far under it. */
const MAX_BYTES = 256 * 1024;
const EXTS = new Set([".md", ".markdown", ".txt"]);

const slug = (s) =>
  s.toLowerCase().replace(/\.[^.]+$/, "").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80);

const today = new Date().toISOString().slice(0, 10);
const files = readdirSync(FROM)
  .filter((f) => EXTS.has(extname(f).toLowerCase()))
  .map((f) => ({ src: join(FROM, f), name: f, size: statSync(join(FROM, f)).size }));

if (!files.length) {
  console.log(`nothing to ingest: no .md/.markdown/.txt files in ${FROM}`);
  process.exit(0);
}

console.log(`\n  ${COMMIT ? "INGESTING" : "DRY RUN (pass --commit to write)"} — ${files.length} file(s) → ${BRAIN}/${INTO}/\n`);

let skipped = 0;
const planned = [];
for (const f of files) {
  if (f.size > MAX_BYTES) {
    console.log(`  skip  ${f.name}  (${(f.size / 1024).toFixed(0)} KB > ${MAX_BYTES / 1024} KB cap — split it first)`);
    skipped++;
    continue;
  }
  const dest = `${INTO}/${slug(f.name)}.md`;
  planned.push({ ...f, dest });
  console.log(`  file  ${f.name}  →  ${dest}  (${(f.size / 1024).toFixed(1)} KB)`);
}

// Two sources slugging to one destination would half-fail on commit; a dry run that hides
// that is not a preview. Fail loudly before anything is written.
const seen = new Map();
for (const f of planned) {
  if (seen.has(f.dest)) {
    console.error(`\n  COLLISION: "${seen.get(f.dest)}" and "${f.name}" both map to ${f.dest} — rename one and re-run.`);
    process.exit(1);
  }
  seen.set(f.dest, f.name);
}

if (!COMMIT) {
  console.log(`\n  ${planned.length} would be written, ${skipped} skipped. Re-run with --commit to proceed.`);
  process.exit(0);
}

let written = 0;
for (const f of planned) {
  const body =
    readFileSync(f.src, "utf8").trimEnd() +
    `\n\n_Ingested ${today} from ${f.name}. Review before trusting: ingested text has no verification history._\n`;
  // One commit per file through the Contents API — same write path the server uses,
  // so every ingest is a visible, revertable commit.
  const b64 = Buffer.from(body, "utf8").toString("base64");
  const payload = JSON.stringify({ message: `brain: ingest ${f.dest}`, content: b64 });
  try {
    execSync(
      `gh api -X PUT repos/${BRAIN}/contents/${f.dest} --input -`,
      { input: payload, stdio: ["pipe", "ignore", "pipe"] }
    );
    console.log(`  ok    ${f.dest}`);
    written++;
  } catch (e) {
    const msg = String(e.stderr || e.message).slice(0, 120);
    console.log(`  FAIL  ${f.dest} — ${msg} (already exists? delete it in the repo or rename the source)`);
  }
}
console.log(`\n  ${written} written, ${planned.length - written} failed, ${skipped} skipped.`);
console.log(`  The server regenerates INDEX.md on its own writes; ingested files appear there after your next brain_write, or immediately via the repo.`);
if (written < planned.length) process.exit(1);
