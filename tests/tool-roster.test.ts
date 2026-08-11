import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerTools } from "../lib/tools";
import roster from "../lib/tool-roster.json";

/**
 * lib/tool-roster.json is what the onboarding verify step and the ops healthcheck assert
 * against. Three separate multi-night outages came from roster strings hardcoded in verifiers
 * drifting behind the server; this test makes that drift a red build instead of a 2am mystery.
 */
function registered(guest: boolean): string[] {
  const names: string[] = [];
  const fake = { registerTool: (name: string) => void names.push(name) } as unknown as McpServer;
  registerTools(fake, { guest });
  return names.sort();
}

describe("the tool roster file", () => {
  it("matches what the trusted door actually registers", () => {
    expect(registered(false)).toEqual([...roster.trusted].sort());
  });

  it("matches what the guest door actually registers", () => {
    expect(registered(true)).toEqual([...roster.guest].sort());
  });

  it("is stored sorted, because the consumers compare sorted shell output", () => {
    expect(roster.trusted).toEqual([...roster.trusted].sort());
    expect(roster.guest).toEqual([...roster.guest].sort());
  });

  it("is derived, never copied, by the ops healthcheck", () => {
    // The shell script once carried its own roster, went stale behind a new tool, and
    // reported UNHEALTHY against a healthy deployment for as long as nobody looked. It must
    // read this file at run time and never name a tool itself.
    const sh = readFileSync(new URL("../ops/groundskeeper/healthcheck.sh", import.meta.url), "utf8");
    expect(sh).toContain("lib/tool-roster.json");
    for (const name of [...roster.trusted, ...roster.guest]) {
      expect(sh, `${name} is hardcoded in healthcheck.sh`).not.toContain(name);
    }
  });
});
