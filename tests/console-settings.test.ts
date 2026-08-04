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
    // No secret value interpolation anywhere in either file.
    expect(page).not.toMatch(/\{process\.env\.(MCP_TOKEN|GUEST_PATH_SECRET|CONNECTOR_PATH_SECRET|[A-Z_]*API_KEY|KV_REST[A-Z_]*)\}/);
    expect(client).not.toContain("process.env");
  });

  it("is gated like every sibling screen", () => {
    expect(page).toContain("requireSecret(params)");
    expect(page).toContain('dynamic = "force-dynamic"');
  });

  it("writes only through the gated save endpoint, derived from the address bar", () => {
    expect(client).toContain("/settings/save");
    expect(client).toContain("window.location.pathname");
    // No absolute URLs, no secret in markup — the fetch target is derived, never rendered.
    expect(client).not.toMatch(/https?:\/\//);
  });

  it("is reachable — the tab exists", () => {
    expect(tabs).toContain('"settings"');
  });

  it("tells the truth about a missing store instead of rendering dead controls silently", () => {
    expect(client).toMatch(/nowhere durable to write|unreachable this render/);
    expect(page).toMatch(/not configured|unreachable/);
  });
});
