import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * The settings screen is the console's one control surface, and the screen most tempted to
 * break the presence-never-values law — its whole subject is configuration. Structural guards,
 * in the style of console-guide.test.ts: the shape of the code is what needs pinning.
 */
const HERE = path.dirname(fileURLToPath(import.meta.url));
const page = readFileSync(path.join(HERE, "../app/s/[secret]/console/settings/page.tsx"), "utf8");
const client = readFileSync(
  path.join(HERE, "../app/s/[secret]/console/settings/settings-client.tsx"),
  "utf8"
);
const learning = readFileSync(
  path.join(HERE, "../app/s/[secret]/console/settings/learning-client.tsx"),
  "utf8"
);
const endpoints = readFileSync(
  path.join(HERE, "../app/s/[secret]/console/settings/endpoints.ts"),
  "utf8"
);
const tabs = readFileSync(path.join(HERE, "../app/s/[secret]/console/tabs.tsx"), "utf8");

describe("the settings screen", () => {
  it("renders presence for every secret-shaped env var, never the value", () => {
    // Secret-shaped vars may be READ (trim/Boolean/length) but their value must never reach
    // JSX. The two identity vars (BRAIN_REPO/BRANCH/TZ, READER_MODEL) are addresses, not
    // credentials, and may render.
    for (const v of ["MCP_TOKEN", "GUEST_PATH_SECRET", "CONNECTOR_PATH_SECRET"]) {
      const uses = [...page.matchAll(new RegExp(`process\\.env\\.${v}[^\\n]*`, "g"))].map((m) => m[0]);
      for (const u of uses) {
        expect(u, `${v} read must be presence/length only`).toMatch(/\?\.trim\(\)|Boolean\(/);
      }
    }
    // No secret value interpolation anywhere in any of these files.
    expect(page).not.toMatch(/\{process\.env\.(MCP_TOKEN|GUEST_PATH_SECRET|CONNECTOR_PATH_SECRET|[A-Z_]*API_KEY|KV_REST[A-Z_]*)\}/);
    expect(client).not.toContain("process.env");
    expect(learning).not.toContain("process.env");
  });

  it("is gated like every sibling screen", () => {
    expect(page).toContain("requireSecret(params)");
    expect(page).toContain('dynamic = "force-dynamic"');
  });

  it("writes only through the gated endpoints, derived from the address bar", () => {
    // The derivation lives once, in endpoints.ts — settings-client and learning-client both
    // post through it, so neither may grow its own URL opinion.
    expect(endpoints).toContain("window.location.pathname");
    expect(client).toContain('settingsEndpoint("save")');
    expect(learning).toContain("settingsEndpoint(");
    // No absolute URLs, no secret in markup — the fetch target is derived, never rendered.
    expect(client).not.toMatch(/https?:\/\//);
    expect(learning).not.toMatch(/https?:\/\//);
    expect(endpoints).not.toMatch(/https?:\/\//);
  });

  it("is reachable — the tab exists", () => {
    expect(tabs).toContain('"settings"');
  });

  it("tells the truth about a missing store instead of rendering dead controls silently", () => {
    expect(client).toMatch(/nowhere durable to write|unreachable this render/);
    expect(learning).toMatch(/nowhere durable to write|unreachable this render/);
    expect(page).toMatch(/not configured|unreachable/);
  });

  it("keeps retrieval a statement, not a knob — the eval gate is the only door", () => {
    // The Learning section shows the incumbent and the verdicts; no control may write a
    // retrieval setting, and the row says why in those words.
    expect(learning).toContain("the eval gate is the only door");
    expect(learning).not.toMatch(/send\(\{\s*retrieval/i);
  });
});
