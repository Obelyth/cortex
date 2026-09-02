import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * The guide is the one screen that reads credentials in order to describe them, which makes it
 * the one most able to leak one. It must report PRESENCE and never a value — the same rule the
 * rest of the console follows, but here it is load-bearing because the screen's whole job is to
 * talk about secrets.
 *
 * Structural assertions on the source, in the style of hard-surface.test.ts: a server component
 * that reads env at render time is awkward to mount, and what needs guarding is the shape of
 * the code rather than one rendered instance.
 */
const HERE = path.dirname(fileURLToPath(import.meta.url));
const src = readFileSync(
  path.join(HERE, "../app/s/[secret]/console/settings/connect-section.tsx"),
  "utf8"
);

describe("the setup guide", () => {
  it("reads credentials only as a boolean, never as a value", () => {
    // The section takes PROPS — it must not read env at all; the Boolean-only reads live in
    // the settings page that feeds it. Both halves of that contract are pinned.
    expect(src).not.toContain("process.env");
    const page = readFileSync(
      path.join(HERE, "../app/s/[secret]/console/settings/page.tsx"),
      "utf8"
    );
    for (const v of ["GUEST_PATH_SECRET", "MCP_TOKEN"]) {
      const reads = [...page.matchAll(new RegExp(`process\\.env\\.${v}[^\\n]*`, "g"))].map(
        (m) => m[0]
      );
      expect(reads.length, `${v} is read by the settings page`).toBeGreaterThan(0);
      for (const r of reads) {
        expect(r, `${v} must be read as presence only`).toMatch(/Boolean\(|\?\.trim\(\)/);
      }
    }
    // And no env value is ever interpolated into rendered output, either file.
    for (const f of [src, page]) {
      expect(f).not.toMatch(/\{\s*process\.env\.[A-Z_]+\s*\}/);
      expect(f).not.toMatch(/\$\{process\.env\./);
    }
  });

  it("shows the wire-up as placeholders, not as this deployment's real URLs", () => {
    // A guide that printed the live secret URL would turn a screenshot into a credential.
    expect(src).toContain("<CONNECTOR_PATH_SECRET>");
    expect(src).toContain("<GUEST_PATH_SECRET>");
    expect(src).toContain("<MCP_TOKEN>");
    expect(src).toContain("https://<host>");
  });

  it("describes all three doors, and states what each grants", () => {
    // The screen exists to answer "which path is mine", so a door missing from it is a door
    // nobody can find.
    for (const door of ["Terminal", "Connector", "Guest"]) expect(src).toContain(door);
    expect(src).toContain("/api/mcp");
    expect(src).toContain("/api/s/");
    expect(src).toContain("/api/g/");
    // The guest's limit is the one a reader must not miss.
    expect(src).toMatch(/never writes/);
  });

  it("links onward with relative hrefs, so the secret stays out of markup", () => {
    for (const m of src.matchAll(/href="([^"]+)"/g)) {
      expect(m[1], `href ${m[1]}`).not.toMatch(/^\/|^https?:\/\//);
    }
  });
});

/**
 * The wire-up picker is the one component allowed to COMPLETE a secret URL — and only into the
 * clipboard, never onto the screen. These assertions pin that split: what renders is masked,
 * what copies is real, and the values the server refuses to send stay placeholders everywhere.
 */
const wireSrc = readFileSync(
  path.join(HERE, "../app/s/[secret]/console/settings/wire-client.tsx"),
  "utf8"
);

describe("the wire-up picker", () => {
  it("derives the path secret from the address bar, never from the server", () => {
    expect(wireSrc).toContain("window.location.pathname");
    // No env read is even possible to render from — a "use client" file has no server env,
    // and none is smuggled through props: the only prop is a boolean.
    expect(wireSrc).not.toContain("process.env");
    expect(wireSrc).toMatch(/guestOpen\s*}:\s*{\s*guestOpen:\s*boolean\s*}/);
  });

  it("renders the mask and copies the real value — never the reverse", () => {
    // The visible snippet is built with MASK; only the click handler builds with the secret.
    expect(wireSrc).toMatch(/const shown = w\.snippet\(origin, MASK\)/);
    expect(wireSrc).toMatch(/w\.snippet\(origin, secret\)/);
    // And the real assembly flows only into the clipboard, not into state or JSX.
    expect(wireSrc).toMatch(/clipboard\.writeText\(real\)/);
    expect(wireSrc).not.toMatch(/\{real\}/);
  });

  it("keeps the server-held credentials as placeholders in every snippet", () => {
    expect(wireSrc).toContain("<MCP_TOKEN>");
    expect(wireSrc).toContain("<GUEST_PATH_SECRET>");
  });

  it("covers the clients the doors were built for", () => {
    for (const c of ["Claude Code", "Cursor", "Gemini CLI", "claude.ai", "ChatGPT"]) {
      expect(wireSrc).toContain(c);
    }
    // Every door appears at least once across the snippets.
    expect(wireSrc).toContain("/api/mcp");
    expect(wireSrc).toContain("/api/s/");
    expect(wireSrc).toContain("/api/g/");
  });
});
