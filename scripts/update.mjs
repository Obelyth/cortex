#!/usr/bin/env node
/**
 * CORTEX update — pull what shipped, redeploy, verify. One command, any copy.
 *
 * Every acquisition path converges here:
 *   - a direct clone updates over its own origin;
 *   - a template copy has no fork relationship, so the first run wires an
 *     `upstream` remote pointing home — without it `git pull` would never see
 *     a release;
 *   - a release download has no git history at all, so the first run converts
 *     it into a real clone anchored at the version it shipped as, keeping any
 *     local edits as uncommitted changes.
 *
 * Interactive and honest, like onboard: nothing merges or deploys without a
 * prompt, a conflict aborts back to the exact pre-merge state, and the finish
 * line is the same live tool-roster check onboarding ends with — trust the
 * check, not the deploy log.
 */
import { execFileSync, execSync } from "node:child_process";
import { existsSync, readFileSync, rmSync, mkdtempSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { parseEnv } from "node:util";
import readline from "node:readline/promises";
import { checkDeployment, deploymentLookupPath } from "./onboard-helpers.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const CANONICAL = "https://github.com/Obelyth/cortex.git";
const isCanonical = (url) => /github\.com[/:]obelyth\/cortex(\.git)?$/i.test(url.trim());

// Interactive by design, for the same reason onboard is: a pipe cannot answer
// a merge or deploy prompt honestly. Fail before touching anything.
if (!process.stdin.isTTY) {
  console.error("update is interactive — run it from a terminal. Nothing was changed.");
  process.exit(1);
}
const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

const say = (s) => console.log(s);
const head = (s) => console.log(`\n\x1b[1m${s}\x1b[0m`);
const ok = (s) => console.log(`  \x1b[36m✓\x1b[0m ${s}`);
const act = (s) => console.log(`  \x1b[33m→\x1b[0m ${s}`);
const sh = (cmd, opts = {}) =>
  (execSync(cmd, { encoding: "utf8", stdio: ["pipe", "pipe", "pipe"], cwd: ROOT, ...opts }) ?? "").trim();
const version = () => JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")).version;

say(`
  CORTEX by OBELYTH — update
  Pull what shipped, redeploy, re-verify. Nothing changes without a prompt.
`);

// ------------------------------------------------------------- this copy ---
head("1 · This copy");
try { sh("command -v git"); } catch {
  act("git is not installed (https://git-scm.com) — install it, then run this again.");
  process.exit(1);
}

if (!existsSync(join(ROOT, ".git"))) {
  // A release download. Git can still update it: anchor a fresh history at the
  // exact commit this version was cut from, so upstream changes merge normally
  // and anything the operator edited surfaces as ordinary uncommitted changes.
  const v = version();
  say(`  This copy is not a git clone — it looks like a release download (v${v}).`);
  const yes = (await rl.question("  Convert it into a clone so it can update in place? [Y/n] ")).trim().toLowerCase();
  if (yes === "n") { say("  Stopped at your request. Nothing was changed."); process.exit(0); }
  sh("git init -q");
  sh("git symbolic-ref HEAD refs/heads/main");
  sh(`git remote add upstream ${CANONICAL}`);
  act("fetching history and tags from Obelyth/cortex…");
  sh("git fetch -q upstream --tags");
  let sha;
  try { sha = sh(`git rev-parse -q --verify "v${v}^{commit}"`); }
  catch {
    act(`no published tag matches v${v}, so this copy cannot be anchored to a commit.`);
    act("safest path: clone fresh (git clone " + CANONICAL.replace(/\.git$/, "") + "), run npm run onboard");
    act("   there — it keeps a linked project's existing secrets — and carry your edits over.");
    rmSync(join(ROOT, ".git"), { recursive: true, force: true });
    process.exit(1);
  }
  sh(`git update-ref refs/heads/main ${sha}`);
  sh("git reset -q --mixed");
  ok(`now a clone anchored at v${v} — your local edits, if any, are ordinary uncommitted changes`);
}

// Updates come from wherever Obelyth/cortex is reachable: origin on a direct
// clone, upstream otherwise — added here once, which is the template-copy fix.
let remote;
let originUrl = "";
try { originUrl = sh("git remote get-url origin"); } catch { /* no origin — template zip or bare init */ }
if (isCanonical(originUrl)) {
  remote = "origin";
  ok("origin points at Obelyth/cortex — updating over it");
} else {
  remote = "upstream";
  let upstreamUrl = "";
  try { upstreamUrl = sh("git remote get-url upstream"); } catch { /* not wired yet */ }
  if (!upstreamUrl) {
    sh(`git remote add upstream ${CANONICAL}`);
    ok("added upstream remote (github.com/Obelyth/cortex) — where updates come from");
  } else if (!isCanonical(upstreamUrl)) {
    act(`the upstream remote points at ${upstreamUrl}, not Obelyth/cortex — fix or remove it, then re-run.`);
    process.exit(1);
  } else {
    ok("upstream remote already wired");
  }
}

// ------------------------------------------------------------- what's new ---
head("2 · What shipped");
try { sh(`git fetch -q ${remote} --tags`); }
catch {
  act(`could not reach github.com to fetch from ${remote} — check the network and re-run.`);
  process.exit(1);
}
const behind = Number(sh(`git rev-list --count HEAD..${remote}/main`));
if (behind === 0) {
  ok(`up to date — running v${version()}, nothing new on main`);
  say("  To redeploy the same code anyway: vercel deploy --prod");
  rl.close();
  process.exit(0);
}
const latestTag = sh(`git tag --merged ${remote}/main --list "v*" --sort=-v:refname`).split("\n")[0];
const latestNote = latestTag ? ` — latest release ${latestTag}` : "";
say(`  ${behind} commit${behind === 1 ? "" : "s"} behind main${latestNote}:`);
say(sh(`git log --oneline -8 HEAD..${remote}/main`).replace(/^/gm, "      "));
if (behind > 8) say(`      … and ${behind - 8} more`);
say("");
act("release notes: https://github.com/Obelyth/cortex/releases");
act('   if a release opens with an "Action required" section, do those steps — they are');
act("   the manual part (a new env var, a migration) this command cannot do for you.");

// Merge commits need an author; a fresh machine often has none configured. The
// GitHub noreply address is real, private, and already theirs — set repo-local
// only, never touching global config.
const ensureIdentity = () => {
  if (sh("git config user.email || true")) return;
  try {
    const id = sh("gh api user --jq .id");
    const login = sh("gh api user --jq .login");
    sh(`git config user.name "${login}"`);
    sh(`git config user.email "${id}+${login}@users.noreply.github.com"`);
    ok(`git identity set for this repo only: ${login}`);
  } catch {
    act("git needs to know who you are to record changes. Run:");
    act('   git config user.name "Your Name" && git config user.email "you@example.com"');
    act("then run npm run update again. Nothing was changed.");
    process.exit(1);
  }
};

// ----------------------------------------------------------------- merge ---
head("3 · Merge");
const dirty = sh("git status --porcelain");
if (dirty) {
  const files = dirty.split("\n");
  say(`  You have ${files.length} local change${files.length === 1 ? "" : "s"} the update must merge around:`);
  say(files.slice(0, 8).map((f) => `      ${f}`).join("\n"));
  if (files.length > 8) say(`      … and ${files.length - 8} more`);
  const keep = (await rl.question("  Keep them by committing them now (revertable, in your copy only)? [Y/n] ")).trim().toLowerCase();
  if (keep === "n") {
    say("  Stopped. Commit or discard those changes, then run npm run update again.");
    process.exit(0);
  }
  ensureIdentity();
  sh("git add -A");
  sh(`git commit -q -m "local changes kept before updating past v${version()}"`);
  ok("local changes committed");
}
const oldHead = sh("git rev-parse HEAD");
const go = (await rl.question(`  Merge ${behind} commit${behind === 1 ? "" : "s"} into this copy now? [Y/n] `)).trim().toLowerCase();
if (go === "n") { say("  Stopped at your request. Nothing was merged."); process.exit(0); }
try {
  sh(`git merge --ff-only ${remote}/main`);
  ok("fast-forwarded — this copy had no commits of its own");
} catch {
  ensureIdentity();
  try {
    sh(`git merge --no-edit ${remote}/main`);
    ok("merged around your local commits");
  } catch {
    const conflicted = sh("git diff --name-only --diff-filter=U || true");
    sh("git merge --abort || true");
    act("your copy and the update changed the same lines — the merge was undone, and");
    act("   every file is exactly as it was. Nothing was deployed. The overlap:");
    say(conflicted.replace(/^/gm, "      "));
    act(`finish by hand when ready: git merge ${remote}/main, resolve, commit — then npm run update.`);
    process.exit(1);
  }
}
const vNew = version();

// The externally-installed CLIs are resolved to absolute paths once and invoked
// without a shell: the argument list cannot be re-parsed, and a PATH change
// cannot swap the binary between the check and the call.
const binOf = (name) => sh(`command -v ${name}`);

// ---------------------------------------------------------- dependencies ---
if (sh(`git diff --name-only ${oldHead} HEAD`).split("\n").includes("package-lock.json")) {
  act("the update changed dependencies — installing the exact pinned set (npm ci)…");
  // --ignore-scripts: no dependency lifecycle script runs on this machine, same
  // policy as the release workflow — which proves on every tag that the suite
  // and build pass without them. Vercel's build runs on Vercel's side either way.
  execFileSync(binOf("npm"), ["ci", "--ignore-scripts"], { cwd: ROOT, stdio: "inherit" });
  ok("dependencies match the lockfile");
}

// ---------------------------------------------------------------- deploy ---
head("4 · Deploy");
if (!existsSync(join(ROOT, ".vercel", "project.json"))) {
  act("this folder is not linked to a Vercel project, so nothing is running the old code from");
  act("   here — the code is updated. To deploy a brain from this copy: npm run onboard.");
  rl.close();
  process.exit(1);
}
let vercelBin;
try { vercelBin = binOf("vercel"); } catch {
  act("vercel CLI is not installed (npm i -g vercel) — install it, then re-run to deploy.");
  process.exit(1);
}
say("  A failed build never replaces what is live — Vercel promotes only builds that succeed.");
const deploy = (await rl.question(`  Deploy v${vNew} to production now? [Y/n] `)).trim().toLowerCase();
if (deploy === "n") {
  say("  Updated locally only. Deploy any time: vercel deploy --prod");
  rl.close();
  process.exit(0);
}
const project = JSON.parse(readFileSync(join(ROOT, ".vercel", "project.json"), "utf8"));
if (!project.projectId || !project.orgId ||
    (process.env.VERCEL_PROJECT_ID && process.env.VERCEL_PROJECT_ID !== project.projectId) ||
    (process.env.VERCEL_ORG_ID && process.env.VERCEL_ORG_ID !== project.orgId)) {
  act("Linked project and shell overrides do not agree. Clear the overrides and relink. Nothing was deployed.");
  rl.close();
  process.exit(1);
}
try { execFileSync(vercelBin, ["api", "--help"], { cwd: ROOT, stdio: "ignore" }); }
catch {
  act("Update Vercel CLI to 50.5.1 or newer before deploying; verified host lookup requires vercel api.");
  rl.close();
  process.exit(1);
}
// stdout is the immutable URL; the helper resolves the actual assigned production domain.
const deployedUrl = execFileSync(vercelBin, ["deploy", "--prod", "--yes"], {
  cwd: ROOT, encoding: "utf8", stdio: ["inherit", "pipe", "inherit"],
}).trim();

// ---------------------------------------------------------------- verify ---
head("5 · Verify — trust the check, not the deploy log");
const envDirectory = mkdtempSync(join(tmpdir(), "cortex-update-env-"));
const tmpEnv = join(envDirectory, "production.env");
let liveSecret = "", liveToken = "";
try {
  execFileSync(vercelBin, ["env", "pull", "--environment", "production", tmpEnv, "--yes"], {
    cwd: ROOT,
    stdio: "ignore",
  });
  const pulled = parseEnv(readFileSync(tmpEnv, "utf8"));
  liveSecret = pulled.CONNECTOR_PATH_SECRET ?? "";
  liveToken = pulled.MCP_TOKEN ?? "";
} catch { /* reported just below — an unverified deploy is named, not guessed at */ } finally {
  rmSync(envDirectory, { recursive: true, force: true });
}
if (!liveSecret && !liveToken) {
  act("could not pull this project's env (vercel env pull), so the deploy cannot be verified");
  act("   from here. Inspect the actual production deployment and environment in Vercel,");
  act("   or use npm run onboard to recheck setup while keeping existing credentials.");
  rl.close();
  process.exit(1);
}
let checked;
try {
  checked = await checkDeployment({
    deploymentUrl: deployedUrl, projectId: project.projectId, secret: liveSecret, token: liveToken,
    readDeployment: async (host) => JSON.parse(execFileSync(vercelBin, ["api", deploymentLookupPath(host, project.orgId)], {
      cwd: ROOT, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"],
    })),
  });
} catch {
  // A fetch error can contain its credential-bearing URL. Never echo it or a guessed link.
  act("Deployment verification did not pass. Check the linked project's ready status, production domain, protection, and logs in Vercel.");
  act("The deployment may already be live. No unverified wiring link is being printed.");
  rl.close();
  process.exit(1);
}
// Same rule as onboard and the ops healthcheck: the expected roster is read from
// lib/tool-roster.json at run time, never inlined — and read AFTER the merge, so a
// release that ships a new tool is verified against its own roster.
const roster = JSON.parse(readFileSync(join(ROOT, "lib", "tool-roster.json"), "utf8"));
const matches = JSON.stringify(checked.tools) === JSON.stringify([...roster.trusted].sort((a, b) => a < b ? -1 : a > b ? 1 : 0));
if (matches) {
  ok(`Verified production host: ${checked.origin}; ${roster.trusted.length} trusted tools answering.`);
  ok(`Updated to v${vNew}, deployed, and the MCP tool roster checked.`);
  say("  This is not a database, model-answer, or email-delivery test. Inspect readiness and receipts in Settings and Ops.");
} else {
  act("The verified production host returned an unexpected tool roster. Inspect the deployed source and logs before trusting the connection.");
}
rl.close();
process.exit(matches ? 0 : 1);
