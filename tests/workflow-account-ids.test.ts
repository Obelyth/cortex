import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// Provider account identifiers belong to whoever runs a copy of this repository. Workflows
// read them from repository variables so the public source carries none.
const dir = ".github/workflows";

describe("workflow account identifiers", () => {
  it("are read from repository variables, never written as literals", () => {
    const literals: string[] = [];
    for (const name of readdirSync(dir).filter((file) => /\.ya?ml$/.test(file))) {
      readFileSync(join(dir, name), "utf8").split("\n").forEach((line, index) => {
        const match = line.match(/^\s*anthropic_[a-z_]*_id\s*:\s*(.*?)\s*$/);
        if (match && !/^(""|''|\$\{\{\s*vars\.[A-Z0-9_]+\s*\}\})?$/.test(match[1])) {
          literals.push(`${name}:${index + 1}`);
        }
      });
    }
    expect(literals).toEqual([]);
  });
});
