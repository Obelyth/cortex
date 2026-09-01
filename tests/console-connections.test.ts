import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * The connections panel's contract with the operator, pinned structurally — the style of
 * console-guide.test.ts, because a server component that loads live stores is awkward to mount
 * and what needs guarding is the shape of the code: which states render, what the copy promises,
 * and that the opt-in law (no SUPABASE_URL → no panel) survives refactors.
 *
 * The panel's DATA behaviour — grouping, caps, direction, evidence scrubbing — is held still
 * with fixtures in tests/edges.test.ts; this file guards the rendering seam above it.
 */
const HERE = path.dirname(fileURLToPath(import.meta.url));
const page = readFileSync(path.join(HERE, "../app/s/[secret]/console/corpus/page.tsx"), "utf8");
const client = readFileSync(
  path.join(HERE, "../app/s/[secret]/console/corpus/ledger-client.tsx"),
  "utf8"
);
const migration = readFileSync(
  path.join(HERE, "../supabase/migrations/20260812000000_note_edges.sql"),
  "utf8"
);
const corpusLib = readFileSync(path.join(HERE, "../lib/corpus.ts"), "utf8");

describe("the corpus page's connections wiring", () => {
  it("collapses 'off' to null before the client ever sees it — the opt-in law lives on the server", () => {
    expect(page).toMatch(/edges\.state === "off"\s*\?\s*null/);
  });

  it("shortens the head to sha8 on the server, so the client renders it and never re-derives it", () => {
    expect(page).toContain("edges.head.slice(0, 8)");
  });

  it("hands every non-off state to the ledger — degraded states are shown, never swallowed", () => {
    expect(page).toContain("connections={connections}");
    expect(page).toMatch(/\{ state: edges\.state \}/);
  });
});

describe("the connections panel", () => {
  it("renders nothing at all when connections is null — absence of config is not an error state", () => {
    // The whole panel hangs off one conditional; there is no unconditional cxn markup.
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
    expect(client).toContain("edges at {connections.head}");
    expect(client).toMatch(/rebuilt \{ago\(connections\.builtAt\)\}/);
    // A truncated list that does not announce itself reads as the complete set.
    expect(client).toMatch(/top 5\s+per kind by weight/);
  });

  it("gives every weight a unit and every kind a chip — no bare numbers on this console", () => {
    for (const label of ["ref", "marker", "shared tag", "co-read windows", "bm25"]) {
      expect(client).toContain(label);
    }
    expect(client).toMatch(/cxnKind\}>\{e\.kind\}/);
  });

  it("puts evidence behind the ledger's own caret vocabulary, exact ISO time in the title", () => {
    expect(client).toMatch(/revCaret\$\{isEvi \? " revCaretOpen" : ""\}/);
    expect(client).toContain("title={connections.builtAt}");
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

describe("the trigger", () => {
  it("schedules a rebuild exactly when a reconcile advanced the head, off the request path", () => {
    expect(corpusLib).toMatch(/if \(head !== before\) scheduleEdgeRebuild\(corpus\.files, head\)/);
  });
});
