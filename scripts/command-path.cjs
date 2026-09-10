const { accessSync, constants, lstatSync, realpathSync, statSync } = require("node:fs");
const path = require("node:path");

const SUPPORTED_COMMANDS = new Set(["git", "gh", "tar"]);

function trustedOwner(stat) {
  if (process.platform === "win32" || typeof process.getuid !== "function") return true;
  const uid = process.getuid();
  return stat.uid === 0 || stat.uid === uid;
}

function validatePathNode(candidate) {
  const stat = lstatSync(candidate);
  if (!trustedOwner(stat)) throw new Error(`Command is not on a trusted PATH: ${candidate}`);
  // Symlink permission bits do not govern replacement; its containing directory does. The
  // canonical target and both lexical/canonical parent chains are checked separately below.
  if (!stat.isSymbolicLink() && process.platform !== "win32" && (stat.mode & 0o022) !== 0) {
    throw new Error(`Command is not on a trusted PATH: ${candidate}`);
  }
}

function validateAncestors(candidate) {
  let current = path.resolve(candidate);
  for (;;) {
    validatePathNode(current);
    const parent = path.dirname(current);
    if (parent === current) return;
    current = parent;
  }
}

function executableNames(name) {
  if (process.platform !== "win32") return [name];
  const extensions = (process.env.PATHEXT || ".EXE;.CMD;.BAT;.COM")
    .split(";")
    .filter(Boolean);
  return extensions.map((extension) => `${name}${extension.toLowerCase()}`);
}

/**
 * Resolve one of the exact external tools used by these scripts to a canonical executable path.
 * An existing but unsafe earlier candidate aborts resolution instead of silently selecting a
 * different program later in PATH.
 */
function resolveTrustedExecutable(name, searchPath = process.env.PATH) {
  if (!SUPPORTED_COMMANDS.has(name)) throw new Error(`Only supported commands may be resolved: ${name || "(empty)"}`);
  if (typeof searchPath !== "string" || searchPath.length === 0) {
    throw new Error(`${name} was not found on PATH`);
  }

  for (const entry of searchPath.split(path.delimiter)) {
    if (!path.isAbsolute(entry)) throw new Error(`Refusing non-absolute PATH entry while resolving ${name}`);
    for (const executable of executableNames(name)) {
      const originalCandidate = path.join(entry, executable);
      let originalStat;
      try {
        originalStat = lstatSync(originalCandidate);
      } catch (error) {
        if (error && error.code === "ENOENT") continue;
        throw error;
      }
      if (!originalStat.isFile() && !originalStat.isSymbolicLink()) continue;

      validateAncestors(originalCandidate);
      const canonical = realpathSync(originalCandidate);
      validateAncestors(canonical);
      if (!statSync(canonical).isFile()) throw new Error(`Command is not a regular executable: ${canonical}`);
      accessSync(canonical, constants.X_OK);
      return canonical;
    }
  }
  throw new Error(`${name} was not found on PATH`);
}

module.exports = { resolveTrustedExecutable };
