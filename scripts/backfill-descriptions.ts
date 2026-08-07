/**
 * backfill-descriptions — give every brain note the one-line description the router runs on.
 *
 * Dry-run by default. Nothing is written without `--apply`, because this edits the operator's memory and
 * a bad run is a bad run against the only copy of things he asked to be remembered.
 *
 * Every write goes through `applyDescription` (lib/frontmatter.ts), which refuses input it cannot
 * read back and never overwrites a description that already exists. On top of that, this script
 * re-parses every file it touches and asserts three things before moving on:
 *
 *   1. the description round-trips exactly,
 *   2. the original note text survives byte-for-byte as a suffix of the new file,
 *   3. the file gained exactly one frontmatter block, not two.
 *
 * A failure on any of them aborts the whole run rather than continuing, because a half-applied
 * backfill across 65 notes is far worse to unpick than a clean stop.
 *
 * Usage:
 *   npx tsx scripts/backfill-descriptions.ts <descriptions.json> [--apply] [--brain <dir>]
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { applyDescription, parseFrontmatter } from "../lib/frontmatter";

interface Item {
  path: string;
  description: string;
  tags: string[];
  superseded?: boolean;
}

const argv = process.argv.slice(2);
const apply = argv.includes("--apply");
const brainAt = argv.indexOf("--brain");
const BRAIN = resolve(brainAt >= 0 ? argv[brainAt + 1] : join(process.cwd(), "..", "brain"));
// Skip flags, and skip the value that belongs to --brain — but only when --brain was actually
// given. Treating argv[0] as that value when it was absent swallowed the source path itself.
const consumed = brainAt >= 0 ? brainAt + 1 : -1;
const source = argv.find((a, i) => !a.startsWith("--") && i !== consumed);

if (!source) {
  console.error("usage: backfill-descriptions.ts <descriptions.json> [--apply] [--brain <dir>]");
  process.exit(2);
}

const items: Item[] = JSON.parse(readFileSync(source, "utf8"));

let wrote = 0;
let already = 0;
let missing = 0;
const changed: string[] = [];

for (const item of items) {
  const abs = join(BRAIN, item.path);
  let before: string;
  try {
    before = readFileSync(abs, "utf8");
  } catch {
    console.error(`MISSING  ${item.path} — not in ${BRAIN}`);
    missing++;
    continue;
  }

  if (parseFrontmatter(before).description) {
    already++;
    continue;
  }

  const after = applyDescription(before, item.description, item.tags);

  // Assert the invariants on the produced text, dry-run or not. A dry run that does not verify is
  // just a slower way of finding out later.
  const round = parseFrontmatter(after);
  if (round.description !== item.description) {
    throw new Error(`${item.path}: description did not round-trip\n  in:  ${item.description}\n  out: ${round.description}`);
  }
  if (!after.endsWith(before)) {
    throw new Error(`${item.path}: original note text is not preserved verbatim`);
  }
  if ((after.match(/^---$/gm) ?? []).length !== 2) {
    throw new Error(`${item.path}: expected exactly one frontmatter block`);
  }

  changed.push(item.path);
  if (apply) {
    writeFileSync(abs, after, "utf8");
    wrote++;
  }
}

const verb = apply ? "wrote" : "would write";
console.log(`\n${verb} ${apply ? wrote : changed.length} · ${already} already described · ${missing} missing`);
if (!apply) {
  console.log("\nDRY RUN — nothing written. Re-run with --apply.\n");
  for (const p of changed.slice(0, 5)) {
    const t = readFileSync(join(BRAIN, p), "utf8");
    const item = items.find((i) => i.path === p)!;
    console.log(`--- ${p}`);
    console.log(applyDescription(t, item.description, item.tags).split("\n").slice(0, 5).join("\n"));
    console.log();
  }
}
if (missing > 0) process.exitCode = 1;
