import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import roster from "../lib/tool-roster.json";
import { ConnectSection } from "../app/s/[secret]/console/settings/connect-section";

/**
 * The connections panel's contract with the operator, pinned structurally — the style of
 * console-guide.test.ts, because a server component that loads live stores is awkward to mount
 * and what needs guarding is the shape of the code: which states render, what the copy promises,
 * and that the opt-in law (no SUPABASE_URL → no panel) survives refactors.
 *
 * The panel lives in the note lens on Ask since the Notes screen folded in (v2, 2026-09-05);
 * the page is ask/page.tsx and the view is ask-lens.tsx. The panel's DATA behaviour — grouping,
 * caps, direction, evidence scrubbing — is held still with fixtures in tests/edges.test.ts; this
 * file guards the rendering seam above it.
 */
const HERE = path.dirname(fileURLToPath(import.meta.url));
const page = readFileSync(path.join(HERE, "../app/s/[secret]/console/ask/page.tsx"), "utf8");
const client = readFileSync(path.join(HERE, "../app/s/[secret]/console/ask/ask-lens.tsx"), "utf8");
const migration = readFileSync(
  path.join(HERE, "../supabase/migrations/20260812000000_note_edges.sql"),
  "utf8"
);

describe("the ask page's connections wiring", () => {
  it("collapses 'off' to null before the client ever sees it — the opt-in law lives on the server", () => {
    expect(page).toMatch(/edges\.state === "off"\s*\?\s*null/);
  });

  it("shortens the head to sha8 on the server, so the client renders it and never re-derives it", () => {
    expect(page).toContain("edges.head.slice(0, 8)");
  });

  it("hands every non-off state to the lens — degraded states are shown, never swallowed", () => {
    expect(page).toContain("connections,");
    expect(page).toMatch(/\{ state: edges\.state \}/);
  });
});

describe("the connections panel", () => {
  it("renders nothing at all when connections is null — absence of config is not an error state", () => {
    // The whole panel hangs off one conditional; there is no unconditional connections markup.
    expect(client).toMatch(/\{connections && \(/);
  });

  it("states the honest absent-table state, naming the command that changes it", () => {
    expect(client).toContain("no connections built — migration pending, run scripts/migrate.ts --apply");
  });

  it("states the migrated-but-never-built state, naming both paths that fill it", () => {
    expect(client).toMatch(/no connections built yet[\s\S]*?next brain write[\s\S]*?build-edges\.ts/);
  });

  it("names the consequence when the store does not answer — a dark panel must say it is one", () => {
    expect(client).toMatch(/connections unavailable[\s\S]*?the graph itself is untouched/);
  });

  it("headers the built graph with the head and the rebuild time, and discloses the top-5 cap", () => {
    expect(client).toContain("edges at ${connections.head}");
    expect(client).toMatch(/rebuilt \$\{ago\(connections\.builtAt/);
    // A truncated list that does not announce itself reads as the complete set.
    expect(client).toMatch(/top 5 per kind by weight/);
  });

  it("gives every weight a unit and every kind a chip — no bare numbers on this console", () => {
    for (const label of ["ref", "marker", "shared tag", "co-read windows", "bm25"]) {
      expect(client).toContain(label);
    }
    expect(client).toMatch(/askEdgeKind">\{e\.kind\}/);
  });

  it("puts evidence behind a real disclosure, exact ISO time in the title", () => {
    expect(client).toMatch(/className="askEdgeRow" aria-expanded=\{open\}/);
    expect(client).toContain('title={connections.state === "built" ? connections.builtAt : undefined}');
  });
});

describe("the note_edges migration", () => {
  it("enables RLS on both new tables — deny-by-default, like every table before them", () => {
    expect(migration).toContain("alter table note_edges enable row level security");
    expect(migration).toContain("alter table edges_state enable row level security");
  });

  it("makes an evidence-free or oversized edge unrepresentable", () => {
    expect(migration).toMatch(/char_length\(evidence\) between 1 and 200/);
  });

  it("admits exactly the five kinds the spec names", () => {
    expect(migration).toMatch(/kind in \('link', 'tag', 'coaccess', 'lexical', 'correction'\)/);
  });

  it("locks the rebuild RPC away from every REST role but the service key", () => {
    for (const role of ["public", "anon", "authenticated"]) {
      expect(migration).toContain(`revoke execute on function edges_rebuild(text, jsonb) from ${role}`);
    }
    expect(migration).toMatch(/set search_path = public, pg_catalog/);
  });

  it("computes coaccess in one-hour windows with boot rows excluded, endpoints pinned to live notes", () => {
    expect(migration).toContain("date_trunc('hour', at)");
    expect(migration).toContain("mode <> 'boot'");
    expect(migration).toMatch(/exists \(select 1 from notes/);
  });
});

describe("the Settings tool reference", () => {
  const html = renderToStaticMarkup(React.createElement(ConnectSection, {
    guestOpen: true,
    guestMissing: [],
    bearerSet: true,
    activeModel: "claude-sonnet-5",
    activeSource: "console",
    guestReader: "claude-sonnet-5",
  }));

  it("names the actual missing guest prerequisite in the connection card and selected guest wire", () => {
    const closed = renderToStaticMarkup(React.createElement(ConnectSection, {
      guestOpen: false,
      guestMissing: ["MCP_TOKEN"],
      bearerSet: false,
      activeModel: "claude-sonnet-5",
      activeSource: "console",
      guestReader: "claude-sonnet-5",
      initialWire: "chatgpt",
    } as never));
    expect(closed).toMatch(/path 03[\s\S]*closed · missing MCP_TOKEN/);
    expect(closed).toMatch(/guest[\s\S]*CLOSED[\s\S]*missing MCP_TOKEN/i);
    expect(closed).not.toMatch(/set GUEST_PATH_SECRET to open/i);
  });

  it("distinguishes an unreadable guest policy from a missing path prerequisite", () => {
    const unavailable = renderToStaticMarkup(React.createElement(ConnectSection, {
      guestOpen: false,
      guestMissing: [],
      guestStoreState: "unreachable",
      bearerSet: true,
      activeModel: "claude-sonnet-5",
      activeSource: "console",
      guestReader: "claude-sonnet-5",
      initialWire: "chatgpt",
    } as never));
    expect(unavailable).toMatch(/path 03[\s\S]*guest policy store did not answer/);
    expect(unavailable).not.toMatch(/GUEST_PATH_SECRET not set|missing MCP_TOKEN/);
  });

  it("renders every canonical trusted and guest tool by its actual registered name", () => {
    for (const name of new Set([...roster.trusted, ...roster.guest])) expect(html).toContain(name);
  });

  it("links to current setup help within Settings instead of removed public pages", () => {
    expect(html).toMatch(/<a href="#setDoors">Services &amp; deployment<\/a>/);
    expect(html).toMatch(/<a href="#setReader">Answering model<\/a>/);
    expect(html).not.toMatch(/public site|\/tools|\/guide/);
  });

  it("documents the accepted write and bubble operations", () => {
    expect(html).toMatch(/brain_write[\s\S]*create[\s\S]*replace[\s\S]*append[\s\S]*edit/);
    expect(html).toMatch(/brain_bubble[\s\S]*list[\s\S]*add[\s\S]*update[\s\S]*file[\s\S]*drop/);
  });

  it("states corpus egress and limits quote verification to what it actually proves", () => {
    expect(html).toMatch(/brain_corpus[\s\S]*note text[\s\S]*calling client[\s\S]*no separate reader model call/);
    expect(html).not.toContain("no egress");
    expect(html).toMatch(/quote[\s\S]*does not prove[\s\S]*answer[\s\S]*correct/);
  });
});

// Freshness scheduling is exercised behaviorally in edges-freshness.test.ts, including the
// same-SHA cache path. A source-text assertion of Git-head-only scheduling hid that regression.
