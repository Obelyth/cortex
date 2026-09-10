import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));

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

describe("deployment readiness", () => {
  it("keeps a partially configured feature unavailable and reports only missing variable names", async () => {
    const readiness = await import("../app/s/[secret]/console/settings/readiness").catch(() => null);
    expect(readiness).not.toBeNull();
    if (!readiness) return;
    const state = readiness.featureReadiness("SUPABASE_URL", {
      SUPABASE_URL: "https://private-project.example",
      SUPABASE_SERVICE_ROLE_KEY: "",
    });
    expect(state).toEqual({ ready: false, missing: ["SUPABASE_SERVICE_ROLE_KEY"] });
    expect(JSON.stringify(state)).not.toContain("private-project");
  });

  it("wires guest policy availability from the guest family rather than reader settings", () => {
    expect(page).toContain("guestDoorReadiness.ready && guest.source === \"store\"");
    expect(page).toContain("storeState: guest.source");
    expect(page).not.toContain("kvReady: settings.source");
  });

  it.each([
    ["CONNECTOR_PATH_SECRET", { CONNECTOR_PATH_SECRET: "path-only", MCP_TOKEN: "" }, "MCP_TOKEN"],
    ["GUEST_PATH_SECRET", { GUEST_PATH_SECRET: "path-only", MCP_TOKEN: "" }, "MCP_TOKEN"],
    ["KV_REST_API_URL", { KV_REST_API_URL: "https://private-kv.example", KV_REST_API_TOKEN: "" }, "KV_REST_API_TOKEN"],
    ["RESEND_API_KEY", { RESEND_API_KEY: "private-mail-key", OPS_ALERT_TO: "" }, "OPS_ALERT_TO"],
  ] as const)("requires the complete %s feature configuration", async (feature, env, missing) => {
    const readiness = await import("../app/s/[secret]/console/settings/readiness").catch(() => null);
    expect(readiness).not.toBeNull();
    if (!readiness) return;
    expect(readiness.featureReadiness(feature, env)).toEqual({ ready: false, missing: [missing] });
  });

  it("renders every exact-note and nested-folder grant by name and removes only the selected entry", async () => {
    const controls = await import("../app/s/[secret]/console/settings/settings-client");
    expect(controls.ExactGuestGrants).toBeTypeOf("function");
    expect(controls.withoutGuestGrant).toBeTypeOf("function");
    if (!controls.ExactGuestGrants || !controls.withoutGuestGrant) return;
    const scope = ["projects/", "projects/one.md", "notes/two.md", "notes/team/", "profile.md"];
    const html = renderToStaticMarkup(React.createElement(controls.ExactGuestGrants, {
      scope,
      disabled: false,
      onChange: () => undefined,
    }));
    for (const path of ["projects/one.md", "notes/two.md", "notes/team/", "profile.md"]) expect(html).toContain(path);
    expect(controls.withoutGuestGrant(scope, "notes/team/")).toEqual([
      "projects/",
      "projects/one.md",
      "notes/two.md",
      "profile.md",
    ]);
  });

  it("renders the bearer-only guest prerequisite in the actual guest rows", async () => {
    const controls = await import("../app/s/[secret]/console/settings/settings-client");
    const g = {
      open: false,
      missing: ["MCP_TOKEN"],
      kvReady: true,
      scope: ["projects/", "notes/team/"],
      citations: false,
      dailyAsks: 50,
      maxK: 8,
      usedToday: 0,
      queued: 0,
    };
    const html = renderToStaticMarkup(
      React.createElement(
        controls.SettingsWrites,
        null,
        React.createElement(controls.GuestRows as React.ComponentType<any>, {
          g,
          writable: true,
          storeState: "store",
        }),
      ),
    );
    expect(html).toContain("notes/team/");
    expect(html).toMatch(/Door closed[\s\S]*missing MCP_TOKEN/);
    expect(html).not.toContain("GUEST_PATH_SECRET not set");
  });

  it("keeps a loaded guest policy operational when only the reader settings family is unreachable", async () => {
    const controls = await import("../app/s/[secret]/console/settings/settings-client");
    const g = {
      open: true,
      missing: [],
      storeState: "store",
      kvReady: true,
      scope: ["projects/", "notes/allowed.md", "notes/team/"],
      citations: false,
      dailyAsks: 25,
      maxK: 8,
      usedToday: 4,
      queued: 0,
    };
    const html = renderToStaticMarkup(
      React.createElement(
        controls.SettingsWrites,
        null,
        React.createElement(controls.GuestRows as React.ComponentType<any>, {
          g,
          // These reader-family facts deliberately disagree. GuestRows must not use them.
          writable: false,
          storeState: "unreachable",
        }),
      ),
    );
    expect(html).toMatch(/Door open[\s\S]*4 of 25 asks used today/);
    expect(html).toContain("notes/team/");
    expect(html).not.toMatch(/door is closed until the store answers|KV missing/);
    expect(html).toMatch(/aria-pressed="true" title="stop sharing projects\/"/);
  });
});
