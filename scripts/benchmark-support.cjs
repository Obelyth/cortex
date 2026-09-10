const {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  realpathSync,
} = require("node:fs");
const path = require("node:path");

const DEFAULT_BASELINE_BYTES = 1024 * 1024;

function readRepositoryJson(repositoryRoot, requestedPath, maxBytes = DEFAULT_BASELINE_BYTES) {
  if (typeof requestedPath !== "string" || path.extname(requestedPath).toLowerCase() !== ".json") {
    throw new Error("Baseline must be a repository-local regular JSON file");
  }
  const root = realpathSync(repositoryRoot);
  const requested = path.resolve(root, requestedPath);
  let direct;
  try {
    direct = lstatSync(requested);
  } catch {
    throw new Error("Baseline must be a repository-local regular JSON file");
  }
  if (!direct.isFile()) throw new Error("Baseline must be a repository-local regular JSON file");

  const canonical = realpathSync(requested);
  const relative = path.relative(root, canonical);
  if (relative === "" || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error("Baseline must be repository-local");
  }

  const noFollow = constants.O_NOFOLLOW ?? 0;
  const descriptor = openSync(requested, constants.O_RDONLY | noFollow);
  try {
    const stat = fstatSync(descriptor);
    if (!stat.isFile()) throw new Error("Baseline must be a repository-local regular JSON file");
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || stat.size > maxBytes) {
      throw new Error(`Baseline exceeds the ${maxBytes}-byte limit`);
    }
    const data = Buffer.alloc(stat.size);
    let offset = 0;
    while (offset < data.length) {
      const bytes = readSync(descriptor, data, offset, data.length - offset, offset);
      if (bytes === 0) break;
      offset += bytes;
    }
    try {
      return JSON.parse(data.subarray(0, offset).toString("utf8"));
    } catch {
      throw new Error("Baseline must contain valid JSON");
    }
  } finally {
    closeSync(descriptor);
  }
}

module.exports = { readRepositoryJson };
