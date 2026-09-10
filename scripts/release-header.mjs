import { readFileSync } from "node:fs";

const repository = process.env.GITHUB_REPOSITORY ?? "";
const sha = process.env.CORTEX_RELEASE_COMMIT ?? "";
if (repository.trim() !== repository || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)
    || sha.length !== 40 || !/^[a-f0-9]+$/.test(sha)) {
  console.error("Release documentation requires a valid repository and commit SHA.");
  process.exit(1);
}

// The commit is the source packaged by the tag workflow. Moving main or a later
// release cannot silently change the installation instructions for this archive.
const source = `https://github.com/${repository}/blob/${sha}`;
const template = readFileSync(new URL("../.github/RELEASE_HEADER.md", import.meta.url), "utf8");
process.stdout.write(template.replaceAll("{{RELEASE_SOURCE}}", source));
