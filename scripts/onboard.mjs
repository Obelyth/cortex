#!/usr/bin/env node
/** Optional interactive setup. Provider changes require explicit confirmation. */
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync, cpSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parseEnv } from "node:util";
import readline from "node:readline/promises";
import { brainRepository, checkDeployment, deploymentLookupPath, requireGitCommitIdentity } from "./onboard-helpers.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
if (!process.stdin.isTTY) {
  console.error("onboard is interactive. Run it from a terminal. Nothing was changed.");
  process.exit(1);
}
const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const say = (s) => console.log(s);
const head = (s) => say(`\n\x1b[1m${s}\x1b[0m`);
const ok = (s) => say(`  ✓ ${s}`);
const act = (s) => say(`  → ${s}`);
const run = (command, args, options = {}) => (execFileSync(command, args, {
  cwd: ROOT, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"], ...options,
}) ?? "").trim();
const confirm = async (prompt) => (await rl.question(`  ${prompt} [y/N] `)).trim().toLowerCase() === "y";
const readRepo = (repo) => JSON.parse(run("gh", ["api", `repos/${repo}`]));

try {
  say("\n  CORTEX by OBELYTH\n  Optional setup for a private brain and protected dashboard.");
  head("1 · Prerequisites");
  for (const command of ["git", "gh", "vercel"]) {
    try { run(command, ["--version"]); }
    catch { throw new Error(`Install ${command} before running setup. See README.md. Nothing was changed.`); }
  }
  // api was introduced in CLI 50.5.1. Stop before creating a repo if it is unavailable.
  try { run("vercel", ["api", "--help"]); }
  catch { throw new Error("Update Vercel CLI (50.5.1 or newer) before running setup. Nothing was changed."); }
  const ghUser = run("gh", ["api", "user", "--jq", ".login"]);
  run("vercel", ["whoami"]);
  ok(`GitHub authenticated as ${ghUser}; Vercel authenticated.`);
  say("  First-time provider accounts, access grants, and database setup need your approval.");
  say("  This wizard does not create a database, apply migrations, or test paid models or email.");

  head("2 · Private brain repository");
  const requestedRepo = (await rl.question(`  Brain repo to create or use [${ghUser}/brain]: `)).trim() || `${ghUser}/brain`;
  if (!/^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9._-]{1,100}$/.test(requestedRepo)) {
    throw new Error("Use a GitHub owner/repo name. Nothing was changed.");
  }
  let metadata;
  try { metadata = readRepo(requestedRepo); }
  catch (error) {
    if (!/HTTP 404/.test(String(error.stderr))) {
      throw new Error("Could not verify the brain repository. Check GitHub authentication and access, then rerun. Nothing was changed.");
    }
    say("  GitHub could not find an accessible repository at that name. Existing private repositories may require another account or grant.");
    if (!await confirm(`Create a new PRIVATE ${requestedRepo} with a blank profile and index?`)) process.exit(0);
    const directory = mkdtempSync(join(tmpdir(), "cortex-blank-brain-"));
    try {
      cpSync(join(ROOT, "brain-template"), directory, { recursive: true });
      run("git", ["init", "-q", "-b", "main"], { cwd: directory });
      requireGitCommitIdentity((args) => run("git", args, { cwd: directory }));
      run("git", ["add", "-A"], { cwd: directory });
      run("git", ["commit", "-q", "-m", "brain: blank initial structure"], { cwd: directory });
      run("gh", ["repo", "create", requestedRepo, "--private", "--source", directory, "--push"]);
    } finally { rmSync(directory, { recursive: true, force: true }); }
    metadata = readRepo(requestedRepo);
  }
  const brain = brainRepository(metadata, requestedRepo);
  // A default-branch name on an empty repository is not proof that a commit exists.
  run("gh", ["api", `repos/${brain.repo}/commits/${encodeURIComponent(brain.branch)}`, "--jq", ".sha"]);
  ok(`Verified private brain: ${brain.repo}; branch: ${brain.branch}. Existing notes are kept.`);

  head("3 · Start blank or import notes");
  say("  A new brain contains only an empty profile and index. No sample memories or projects.");
  const fromDir = (await rl.question("  Folder to import (Enter to leave the brain unchanged): ")).trim();
  if (fromDir) {
    const ingest = (commit) => run(process.execPath, [join(ROOT, "scripts/ingest.mjs"), ...(commit ? ["--commit"] : [])], {
      stdio: "inherit", env: { ...process.env, INGEST_FROM: fromDir, BRAIN_REPO: brain.repo, BRAIN_BRANCH: brain.branch },
    });
    ingest(false);
    if (await confirm("Commit the previewed notes to this private brain?")) ingest(true);
  }

  head("4 · Access credentials");
  say("  Pasted values are visible in this terminal. Store credentials in a password manager; clear scrollback afterwards.");
  act("Create a fine-grained GitHub token at https://github.com/settings/personal-access-tokens/new");
  say(`  Select ONLY ${brain.repo}, with Repository Contents: Read and write.`);
  const githubToken = (await rl.question("  GITHUB_TOKEN: ")).trim();
  if (!githubToken) throw new Error("No token supplied. Stopped before changing any deployment settings.");
  const passcode = (await rl.question("  CONSOLE_PASSCODE (Enter to generate one): ")).trim() || randomBytes(12).toString("base64url");
  const generated = {
    MCP_TOKEN: randomBytes(32).toString("hex"),
    CONNECTOR_PATH_SECRET: randomBytes(32).toString("hex"),
    CONSOLE_PASSCODE: passcode,
  };
  say("  A paid model is optional. Browsing notes, context previews, and basic setup need no model key.");
  const anthropicKey = (await rl.question("  Optional ANTHROPIC_API_KEY (Enter to skip or keep the existing value): ")).trim();

  head("5 · Choose the deployment");
  if (!await confirm("Link this source checkout to a Vercel project?")) process.exit(0);
  run("vercel", ["link"], { stdio: "inherit" });
  const linked = JSON.parse(readFileSync(join(ROOT, ".vercel/project.json"), "utf8"));
  if (!linked.projectId || !linked.orgId ||
      (process.env.VERCEL_PROJECT_ID && process.env.VERCEL_PROJECT_ID !== linked.projectId) ||
      (process.env.VERCEL_ORG_ID && process.env.VERCEL_ORG_ID !== linked.orgId)) {
    throw new Error("The linked project and shell overrides do not agree. Clear the overrides and relink before sending credentials.");
  }
  say(`  Target project: ${linked.projectName ?? linked.projectId} (${linked.projectId}).`);
  const envDirectory = mkdtempSync(join(tmpdir(), "cortex-onboard-env-"));
  let existing;
  try {
    const envPath = join(envDirectory, "production.env");
    run("vercel", ["env", "pull", envPath, "--environment", "production", "--yes"]);
    existing = parseEnv(readFileSync(envPath, "utf8"));
  } finally { rmSync(envDirectory, { recursive: true, force: true }); }
  const hasSecrets = Object.keys(generated).some((key) => existing[key]);
  const rotate = hasSecrets && await confirm("Rotate the existing access credentials? This disconnects existing clients");
  if (rotate) say("  Existing clients will need the new credentials, and browsers will need to unlock again.");
  const live = Object.fromEntries(Object.entries(generated).map(([key, value]) => [key, !rotate && existing[key] ? existing[key] : value]));
  const values = {
    BRAIN_REPO: brain.repo, BRAIN_BRANCH: brain.branch, GITHUB_TOKEN: githubToken,
    ...live, ...(anthropicKey ? { ANTHROPIC_API_KEY: anthropicKey } : {}),
  };
  const changes = Object.entries(values).filter(([key, value]) => existing[key] !== value);
  say(`  Production settings to save: ${changes.map(([key]) => key).join(", ") || "none"}.`);
  if (!await confirm("Save these settings to this project and deploy production?")) process.exit(0);
  for (const [key, value] of changes) {
    if (Object.hasOwn(existing, key)) run("vercel", ["env", "rm", key, "production", "--yes"]);
    run("vercel", ["env", "add", key, "production"], { input: value });
    ok(`Saved ${key}.`);
  }
  say("  Client connections need a reachable production endpoint. If Vercel Deployment Protection blocks them, review its production setting in Vercel; keep preview protection enabled.");
  act("Deploying. The build output follows.");
  // Vercel documents stdout as the immutable deployment URL. Never guess a project alias.
  const deployedUrl = run("vercel", ["deploy", "--prod", "--yes"], { stdio: ["inherit", "pipe", "inherit"] });

  head("6 · Verify the deployment and MCP door");
  const readDeployment = async (host) => JSON.parse(run("vercel", ["api", deploymentLookupPath(host, linked.orgId)]));
  let checked;
  try {
    checked = await checkDeployment({
      deploymentUrl: deployedUrl, projectId: linked.projectId,
      secret: live.CONNECTOR_PATH_SECRET, readDeployment,
    });
    const roster = JSON.parse(readFileSync(join(ROOT, "lib/tool-roster.json"), "utf8"));
    if (JSON.stringify(checked.tools) !== JSON.stringify([...roster.trusted].sort())) throw new Error("Tool roster mismatch");
  } catch {
    // Network errors may contain the credential-bearing URL. Do not echo them or print a guessed link.
    throw new Error("Deployment verification did not pass. No wiring link is being printed. Check the linked project's production domain, ready status, protection, and logs in Vercel, then rerun. Settings already saved remain saved; existing secrets are kept by default.");
  }
  ok(`Verified production host: ${checked.origin}; trusted tool roster matches.`);
  say("  This checked the MCP door, not repository access, database health, email delivery, or model answers. Open Settings and Ops for those services' readiness.");

  head("7 · Open the protected dashboard");
  say(`  Console: ${checked.origin}/s/${live.CONNECTOR_PATH_SECRET}/console`);
  say(`  Passcode: ${live.CONSOLE_PASSCODE}`);
  say("  Overview is the working-context home. Settings has the exact client wiring and service setup.");
  say(`\n  Header-capable MCP client URL: ${checked.origin}/api/mcp`);
  say(`  Authorization: Bearer ${live.MCP_TOKEN}`);
  say(`  Trusted URL-only client: ${checked.origin}/api/s/${live.CONNECTOR_PATH_SECRET}/mcp`);
  say("  Both trusted connections can write notes. Do not share their credentials or URLs.");
  say("  Save these credentials in your password manager now. They can also be recovered from Vercel's production environment.");
  say("\n  Optional database: follow docs/database-bootstrap.md for a new, empty database.");
  say("  Do not use the historical migration runner to initialize a new database.");
  say("  Optional providers, alerts, guest access, and Ops grants are documented in .env.example and README.md.");
  say("\n  For updates, read the release's Action required steps before deploying new source.");
} catch (error) {
  // Child-process failures can include provider output. Only our own actionable errors are shown.
  console.error(`\n  Setup stopped: ${error?.status !== undefined ? "A provider command failed. Check CLI authentication and the selected project, then rerun. Earlier confirmed changes may already have completed." : error.message}`);
  process.exitCode = 1;
} finally { rl.close(); }
