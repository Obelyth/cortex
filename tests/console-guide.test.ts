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
  path.join(HERE, "../app/s/[secret]/console/guide/page.tsx"),
  "utf8"
);

describe("the setup guide", () => {
  it("reads credentials only as a boolean, never as a value", () => {
    // Every env read on this page is wrapped in Boolean(...) and compared to nothing else.
    for (const v of ["GUEST_PATH_SECRET", "MCP_TOKEN"]) {
      const reads = [...src.matchAll(new RegExp(`process\\.env\\.${v}[^\\n]*`, "g"))].map(
        (m) => m[0]
      );
      expect(reads.length, `${v} is read`).toBeGreaterThan(0);
      for (const r of reads) {
        expect(r, `${v} must be read as presence only`).toMatch(/Boolean\(|\?\.trim\(\)/);
      }
    }
    // And no env value is ever interpolated into rendered output.
    expect(src).not.toMatch(/\{\s*process\.env\.[A-Z_]+\s*\}/);
    expect(src).not.toMatch(/\$\{process\.env\./);
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
  path.join(HERE, "../app/s/[secret]/console/guide/wire-client.tsx"),
  "utf8"
);

describe("the wire-up picker", () => {
  it("derives the path secret from the address bar, never from the server", () => {
    expect(wireSrc).toContain("window.location.pathname");
    // No env read is even possible to render from — a "use client" file has no server env,
    // and none is smuggled through props: the only prop is a boolean.
    expect(wireSrc).not.toContain("process.env");
    expect(wireSrc).toMatch(/guestServes\s*}:\s*{\s*guestServes:\s*boolean\s*}/);
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

  it("offers claude.ai on the guest door as well as the connector", () => {
    // A claude.ai account is not automatically one you hold the pen for: a work or org account
    // runs under somebody else's policy. With only the connector entry on the picker, the
    // obvious move for that account is the full read-write URL — so the guest option has to be
    // on the same screen, named for the same client, or the safe path is the one nobody finds.
    const claudeAi = [...wireSrc.matchAll(/name: "(claude\.ai[^"]*)",\s*\n\s*door: "(\w+)"/g)].map(
      (m) => [m[1], m[2]]
    );
    expect(claudeAi).toEqual(
      expect.arrayContaining([
        ["claude.ai", "connector"],
        [expect.stringContaining("guest"), "guest"],
      ])
    );
    // And the guest-facing one must carry the guest URL and NOT the trusted door's — the whole
    // point of the row. Bounded by the next entry's id rather than the next "}," so a snippet
    // built with JSON.stringify (two sibling entries already are) cannot truncate the slice.
    const start = wireSrc.indexOf('id: "claude-ai-guest"');
    expect(start, 'the claude-ai-guest entry must exist to be checked').toBeGreaterThan(-1);
    const rest = wireSrc.slice(start + 1);
    const next = rest.indexOf('id: "');
    const guestEntry = next === -1 ? rest : rest.slice(0, next);
    expect(guestEntry).toContain("/api/g/");
    expect(guestEntry).not.toContain("/api/s/");
  });

  it("reports the guest door as serving only when it can actually serve", () => {
    // The picker's door-state sentence used to key off GUEST_PATH_SECRET presence alone, so a
    // deployment with the secret but no KV store (or no MCP_TOKEN) got "this door is open" from
    // the picker and "door cannot serve" from the path 03 card — on the same screen, thirty
    // pixels apart. The guest door is an alias onto the bearer-gated handler and it meters
    // against KV, so all three have to be present before anything claims it serves.
    // All three inputs reach the verdict, and it is computed in ONE place — the previous shape
    // spelled the decision out separately per screen, which is how they came to disagree.
    expect(src).toMatch(/guestDoorState\(guestOpen, kvSet, bearerSet\)/);
    expect(src).toMatch(/const guestServes = guestDoor\.serves;/);
    // Every rendered guest-door string comes from that verdict, not from a local re-derivation.
    expect(src).toMatch(/who: guestDoor\.who,/);
    expect(src).toMatch(/state: guestDoor\.state,/);
    // The helper must refuse on any missing piece rather than only the secret.
    const helper = src.slice(src.indexOf("function guestDoorState"));
    const body = helper.slice(0, helper.indexOf("\n}"));
    for (const guard of ["!open", "!kv", "!bearer"]) {
      expect(body, `guestDoorState must guard on ${guard}`).toContain(guard);
    }
    expect(body.match(/serves: true/g), "exactly one path may report serving").toHaveLength(1);
    // The picker gets the composed verdict, never the bare secret-presence flag.
    expect(src).toMatch(/<WireClient guestServes=\{guestServes\} \/>/);
    expect(src).not.toMatch(/<WireClient[^>]*guestOpen=/);
    // And the closed branch must not name one cause, since the boolean cannot tell them apart.
    expect(wireSrc).not.toMatch(/NOT serving[^"]*set GUEST_PATH_SECRET/);
  });
});
