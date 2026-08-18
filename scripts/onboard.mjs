#!/usr/bin/env node
/**
 * CORTEX onboarding — from clone to a working brain on every device.
 *
 * Interactive and honest: it does each step it safely can, prints the exact
 * command for each step it cannot (creating a fine-grained PAT needs a browser),
 * and verifies the result at the end instead of assuming it.
 *
 * Safe to re-run: every step checks before it acts.
 */
import { execFileSync, execSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync, cpSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import readline from "node:readline/promises";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

// Interactive by design: every consequential step is confirmed at a prompt, so a pipe or a CI
// runner has no way to answer honestly. Fail before touching anything rather than hang.
if (!process.stdin.isTTY) {
  console.error("onboard is interactive — run it from a terminal. Nothing was changed.");
  process.exit(1);
}
const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

const say = (s) => console.log(s);
const head = (s) => console.log(`\n\x1b[1m${s}\x1b[0m`);
const ok = (s) => console.log(`  \x1b[36m✓\x1b[0m ${s}`);
const act = (s) => console.log(`  \x1b[33m→\x1b[0m ${s}`);
const sh = (cmd, opts = {}) => (execSync(cmd, { encoding: "utf8", stdio: ["pipe", "pipe", "pipe"], ...opts }) ?? "").trim();
const have = (cmd) => { try { sh(`command -v ${cmd}`); return true; } catch { return false; } };

say(`
  CORTEX by OBELYTH — onboarding
  One memory, every surface. This sets up yours.
`);

// ---------------------------------------------------------------- prereqs ---
head("1 · Prerequisites");
const missing = [];
for (const [cmd, hint] of [
  ["gh", "https://cli.github.com — then: gh auth login"],
  ["vercel", "npm i -g vercel — then: vercel login"],
  ["git", "https://git-scm.com"],
]) {
  if (have(cmd)) ok(`${cmd} installed`);
  else { act(`install ${cmd}: ${hint}`); missing.push(cmd); }
}
if (missing.length) {
  say("\nInstall the missing tools, then run this again. Nothing was changed.");
  process.exit(1);
}
let ghUser;
try { ghUser = sh("gh api user --jq .login"); ok(`gh authenticated as ${ghUser}`); }
catch { act("gh is not authenticated — run: gh auth login"); process.exit(1); }
try { ok(`vercel authenticated as ${sh("vercel whoami")}`); }
catch { act("vercel is not authenticated — run: vercel login"); process.exit(1); }

// ------------------------------------------------------------- brain repo ---
head("2 · The brain — a private repo of markdown notes");
const defaultBrain = `${ghUser}/brain`;
const brainRepo =
  (await rl.question(`  Brain repo to create or use [${defaultBrain}]: `)).trim() || defaultBrain;
// The answer lands in child-process arguments and the deployment env: hold it to the one
// shape GitHub accepts before it goes anywhere. Also the wizard's earliest typo-catch.
if (!/^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9._-]{1,100}$/.test(brainRepo)) {
  say(`  "${brainRepo}" is not an owner/repo name. Nothing was changed.`);
  process.exit(1);
}

let brainExists = false;
try { sh(`gh repo view ${brainRepo} --json name`); brainExists = true; ok(`${brainRepo} already exists — will use it as-is`); }
catch { /* will create */ }

if (!brainExists) {
  const yes = (await rl.question(`  Create PRIVATE repo ${brainRepo} from the starter template? [Y/n] `)).trim().toLowerCase();
  if (yes === "n") { say("  Stopped at your request. Nothing was changed."); process.exit(0); }
  const tmp = mkdtempSync(join(tmpdir(), "brain-"));
  cpSync(join(ROOT, "brain-template"), tmp, { recursive: true });
  sh(`git -C ${tmp} init -q -b main && git -C ${tmp} add -A && git -C ${tmp} commit -q -m "brain: initial structure"`);
  sh(`gh repo create ${brainRepo} --private --source ${tmp} --push`);
  rmSync(tmp, { recursive: true, force: true });
  ok(`created ${brainRepo} (private) with the starter structure`);
}

// ------------------------------------------------------------------ fill ---
// The fork every new brain faces: start from the template's clean structure, or bring an
// existing folder of notes in. The ingest path previews first and asks again before writing —
// the same dry-run-by-default contract scripts/ingest.mjs keeps on its own.
head("3 · Fill it — start fresh, or bring what you already have");
say("  Fresh is a fine answer: the template ships a profile, conventions and an example project.");
const fromDir = (await rl.question("  Folder of existing notes to index (Enter to start fresh): ")).trim();
if (fromDir) {
  // The folder never touches a shell, an argv, or this process's filesystem calls: it rides
  // the child's environment, and scripts/ingest.mjs validates it on arrival exactly as it
  // does when run by hand — same dry-run preview, same collision and size rails.
  const ingest = (commit) =>
    execFileSync(process.execPath, [join(ROOT, "scripts", "ingest.mjs"), ...(commit ? ["--commit"] : [])], {
      cwd: ROOT,
      stdio: "inherit",
      env: { ...process.env, INGEST_FROM: fromDir, BRAIN_REPO: brainRepo },
    });
  let previewed = false;
  try { ingest(false); previewed = true; }
  catch { act("preview did not pass — fix what it printed above, then: npm run ingest -- --from <folder> --repo " + brainRepo); }
  if (previewed) {
    const file = (await rl.question("  File these into the brain now, one revertable commit per note? [y/N] ")).trim().toLowerCase();
    if (file === "y") {
      try { ingest(true); ok("ingested — each note carries a provenance line and its own commit"); }
      catch { act("some files failed above — what succeeded is in; fix and re-run ingest for the rest"); }
    } else {
      say(`  Skipped. Any time: npm run ingest -- --from ${fromDir} --repo ${brainRepo} --commit`);
    }
  }
} else {
  ok("starting fresh — the template structure is already in place");
}

// ---------------------------------------------------------------- secrets ---
head("4 · Secrets — generated locally, shown once");
say("  Pasted tokens are VISIBLE on screen and in terminal scrollback — clear it after.");
const MCP_TOKEN = randomBytes(32).toString("hex");
const CONNECTOR_PATH_SECRET = randomBytes(32).toString("hex");
ok("MCP_TOKEN and CONNECTOR_PATH_SECRET generated (64 hex chars each)");
say("");
act("One step needs your browser — a fine-grained GitHub PAT, scoped to ONLY the brain repo:");
say(`      https://github.com/settings/personal-access-tokens/new`);
say(`      Repository access: Only select repositories → ${brainRepo}`);
say(`      Permissions → Repository → Contents: Read and write. Nothing else.`);
const GITHUB_TOKEN = (await rl.question("  Paste the PAT (input is used for Vercel env only): ")).trim();
if (!GITHUB_TOKEN) { say("  No token — stopping before any deploy. Re-run when ready."); process.exit(1); }

say("");
act("The reader model needs an Anthropic API key (console.anthropic.com → API keys):");
const ANTHROPIC_API_KEY = (await rl.question("  Paste ANTHROPIC_API_KEY (or Enter to skip — brain_ask will be disabled until set): ")).trim();

// ----------------------------------------------------------------- deploy ---
head("5 · Deploy to Vercel");
const proceed = (await rl.question("  Link this directory to a Vercel project and deploy to production? [Y/n] ")).trim().toLowerCase();
if (proceed === "n") { say("  Stopped before deploy. Your secrets were not sent anywhere."); process.exit(0); }

execSync("vercel link --yes", { cwd: ROOT, stdio: "inherit" });
// Re-run safety: if this project already carries a token, a silent regeneration would break
// every wired surface. Keeping the existing secrets is the default.
let keepExisting = false;
try {
  const existing = sh("vercel env ls production", { cwd: ROOT });
  if (existing.includes("MCP_TOKEN")) {
    const kr = (await rl.question("  This project already has secrets. Keep them (re-wiring stays valid)? [Y/n] ")).trim().toLowerCase();
    keepExisting = kr !== "n";
    if (!keepExisting) act("rotating — every wired device and the claude.ai connector must be re-wired after this");
  }
} catch { /* not linked before — fresh setup */ }

const envs = {
  BRAIN_REPO: brainRepo,
  BRAIN_BRANCH: "main",
  GITHUB_TOKEN,
  MCP_TOKEN,
  CONNECTOR_PATH_SECRET,
  ...(ANTHROPIC_API_KEY ? { ANTHROPIC_API_KEY } : {}),
};
for (const [k, v] of Object.entries(envs)) {
  if (keepExisting && (k === "MCP_TOKEN" || k === "CONNECTOR_PATH_SECRET")) { ok(`env ${k} kept`); continue; }
  try { execSync(`vercel env rm ${k} production --yes`, { cwd: ROOT, stdio: "ignore" }); } catch {}
  execSync(`vercel env add ${k} production`, { cwd: ROOT, input: v, stdio: ["pipe", "ignore", "inherit"] });
  ok(`env ${k} set (production)`);
}
// When keeping, the real secret values are needed for verification and wiring output.
let liveToken = MCP_TOKEN, liveSecret = CONNECTOR_PATH_SECRET;
if (keepExisting) {
  const tmpEnv = join(ROOT, ".vercel", ".onboard-env.tmp");
  execSync(`vercel env pull --environment production ${tmpEnv} --yes`, { cwd: ROOT, stdio: "ignore" });
  const pulled = readFileSync(tmpEnv, "utf8");
  rmSync(tmpEnv, { force: true });
  liveToken = (pulled.match(/^MCP_TOKEN="?([^"\n]+)/m) || [])[1] ?? MCP_TOKEN;
  liveSecret = (pulled.match(/^CONNECTOR_PATH_SECRET="?([^"\n]+)/m) || [])[1] ?? CONNECTOR_PATH_SECRET;
}
// The most common first-deploy failure, said BEFORE the deploy rather than after the check
// fails: team-default Deployment Protection puts an SSO page in front of the doors.
act("if your Vercel team enables Deployment Protection by default, disable it for PRODUCTION");
act("   on this project (Settings → Deployment Protection) — the doors carry their own auth.");
act("deploying… (a few minutes; the build streams below)");
execSync(`vercel deploy --prod --yes`, { cwd: ROOT, stdio: "inherit" });
// The deploy prints an immutable per-deployment URL; wiring must use the STABLE production
// alias, or every future deploy would strand the wired surfaces on an old build.
const projectName = JSON.parse(readFileSync(join(ROOT, ".vercel", "project.json"), "utf8")).projectName
  ?? JSON.parse(readFileSync(join(ROOT, ".vercel", "project.json"), "utf8")).name;
const url = `https://${projectName}.vercel.app`;
ok(`deployed — production alias: ${url}`);

// ----------------------------------------------------------------- verify ---
head("6 · Verify — trust the check, not the deploy log");
const body = JSON.stringify({ jsonrpc: "2.0", method: "tools/list", id: 1 });
const MCP_SECRET_FOR_CHECK = liveSecret;
let healthy = true;
const tools = sh(
  `curl -s --max-time 30 -X POST "${url}/api/s/${MCP_SECRET_FOR_CHECK}/mcp" ` +
  `-H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' ` +
  `--data '${body}' | grep -o 'brain_[a-z]*' | sort -u | tr '\\n' ' '`
);
// The roster comes from lib/tool-roster.json — the same file the ops healthcheck asserts and
// tests/tool-roster.test.ts pins to registerTools(). A roster string hardcoded here went stale
// once and failed every healthy first deploy at the finish line, hiding the wiring
// instructions behind a false UNHEALTHY. Never inline it again.
const roster = JSON.parse(readFileSync(join(ROOT, "lib", "tool-roster.json"), "utf8"));
const expected = roster.trusted.join(" ");
if (tools.trim() === expected) {
  ok(`secret-URL path healthy — ${roster.trusted.length} tools: ${tools.trim()}`);
} else {
  act(`UNHEALTHY — got: ${tools.trim() || "<none>"} (expected: ${expected})`);
  act("if you see an auth/SSO page instead of tools: disable Vercel Deployment Protection for");
  act("   PRODUCTION only (Settings → Deployment Protection) — the doors carry their own auth,");
  act("   and preview protection can stay on. Then re-run; secrets are kept on re-run.");
  act("secrets are recoverable any time with:");
  act("   vercel env pull --environment production .env.production.local   (gitignored)");
  act("");
  act("The deploy itself succeeded — the wiring commands below are printed anyway; fix the");
  act("check before trusting the doors.");
  healthy = false;
}

// ------------------------------------------------------------------ wire ---
head("7 · Wire your surfaces");
say(`  Claude Code (any machine — run once, user scope):
      claude mcp add --transport http cortex ${url}/api/mcp \\
        --header "Authorization: Bearer ${liveToken}"

  claude.ai (web → syncs to iOS and desktop on its own):
      Settings → Connectors → Add custom connector
      URL: ${url}/api/s/${liveSecret}/mcp

  The secret-gated pages (do not share these URLs):
      console         ${url}/s/${liveSecret}/console
      live map        ${url}/s/${liveSecret}/map
`);
say(`  Store MCP_TOKEN and CONNECTOR_PATH_SECRET in your password manager now —
  this is the only time they are shown together.\n`);
say(`  Optional tiers, when you want them (each documented in .env.example):
      guest door       GUEST_PATH_SECRET (a second, different secret) + the Upstash KV
                       integration on the Vercel Marketplace — it injects KV_REST_API_* itself
      Supabase mirror  SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY, then apply the schema:
                       npx tsx scripts/migrate.ts --apply   (dry-run without --apply)
`);

// --------------------------------------------------------- staying current ---
head("8 · Staying current");
// Updates ship from main (SECURITY.md). A copy made with GitHub's "Use this
// template" has no fork relationship, so without a remote pointing home a
// git pull would never see a release — wire it now, while we are here, so
// npm run update works on every acquisition path from day one.
try {
  let originUrl = "";
  try { originUrl = sh("git remote get-url origin", { cwd: ROOT }); } catch { /* no origin */ }
  if (/github\.com[/:]obelyth\/cortex(\.git)?$/i.test(originUrl)) {
    ok("origin points at Obelyth/cortex — this copy updates over it directly");
  } else if (sh("git remote", { cwd: ROOT }).split("\n").includes("upstream")) {
    ok("upstream remote already wired — updates come from there");
  } else {
    sh("git remote add upstream https://github.com/Obelyth/cortex.git", { cwd: ROOT });
    ok("added upstream remote (github.com/Obelyth/cortex) — where updates come from");
  }
} catch {
  act("not a git checkout — npm run update will offer to fix that on its first run");
}
say(`  Update any time — one command pulls what shipped, redeploys, and re-verifies:
      npm run update
  Hear about releases: github.com/Obelyth/cortex → Watch → Custom → Releases.
  The console footer also shows a "vX.Y.Z available" link when one is out.
`);
ok(`done. More to bring in later? npm run ingest -- --from <folder> --repo ${brainRepo}`);
rl.close();

process.exit(healthy ? 0 : 1);
